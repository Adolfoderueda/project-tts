import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventStore } from '../src/store.js';
import { OpenCodeMonitor, defaultSleep, type MonitorClient, type MonitorEventStream } from '../src/opencode-monitor.js';
import type { ProjectConfig } from '../src/events.js';

const tempDirs: string[] = [];

const project: ProjectConfig = {
  id: 'project-alpha',
  name: 'Project Alpha',
  baseURL: 'http://127.0.0.1:4096',
};

async function createStore(): Promise<EventStore> {
  const directory = await mkdtemp(join(tmpdir(), 'project-tts-monitor-'));
  tempDirs.push(directory);
  return new EventStore(join(directory, 'events.sqlite'));
}

function streamFrom(events: unknown[], options: { failWith?: unknown } = {}): MonitorEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
      if (options.failWith !== undefined) {
        throw options.failWith;
      }
    },
  };
}

function sdkSseStream(frames: Array<{ id: string; data: unknown }>, onSseEvent?: (event: { id: string; data: unknown }) => void): MonitorEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        onSseEvent?.(frame);
        yield frame.data;
      }
    },
  };
}

function subscribeResult(stream: MonitorEventStream): { stream: MonitorEventStream } {
  return { stream };
}

function blockingStream(signal: AbortSignal): { stream: MonitorEventStream; abortCalled: Promise<void> } {
  let resolveAbort!: () => void;
  const abortCalled = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  signal.addEventListener('abort', resolveAbort, { once: true });

  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        await abortCalled;
      },
    },
    abortCalled,
  };
}

function deferredDelay() {
  const delays: number[] = [];
  const resolvers: Array<() => void> = [];
  return {
    delays,
    sleep: vi.fn((milliseconds: number) => {
      delays.push(milliseconds);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    }),
    resolveNext() {
      const resolve = resolvers.shift();
      if (resolve === undefined) {
        throw new Error('No pending delay to resolve');
      }
      resolve();
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('OpenCodeMonitor', () => {
  test('subscribes with the monitor AbortSignal and one SDK retry attempt', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal; sseMaxRetryAttempts: number }) => subscribeResult(blockingStream(signal).stream));
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(project, store, { createMonitorClient: () => client });
    const runPromise = monitor.run(abortController.signal);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ signal: abortController.signal, sseMaxRetryAttempts: 1 }));

    abortController.abort();
    await runPromise;
    store.close();
  });

  test('logs sanitized SDK SSE errors reported through onSseError', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays = deferredDelay();
    const logger = { warn: vi.fn() };
    const subscribe = vi.fn((options: { onSseError?: (error: unknown) => void }) => {
      options.onSseError?.(new Error('connect ECONNREFUSED token=secret-value'));
      return subscribeResult(streamFrom([]));
    });
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(project, store, {
      createMonitorClient: () => client,
      sleep: delays.sleep,
      logger,
    });
    const runPromise = monitor.run(abortController.signal);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());

    expect(logger.warn).toHaveBeenCalledWith('OpenCode event stream failed for project project-alpha: Error');
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('secret-value');

    await vi.waitFor(() => expect(delays.sleep).toHaveBeenCalledOnce());
    abortController.abort();
    delays.resolveNext();
    await runPromise;
    store.close();
  });

  test('persists mapped OpenCode events with the configured project identity', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal; sseMaxRetryAttempts: number }) => subscribeResult(blockingStream(signal).stream));
    const client: MonitorClient = {
      event: {
        subscribe: subscribe
          .mockReturnValueOnce(subscribeResult(streamFrom([{ type: 'session.idle', properties: { sessionID: 'session-1' } }])))
      },
    };

    const monitor = new OpenCodeMonitor(project, store, { createMonitorClient: () => client, sleep: async () => {} });
    const runPromise = monitor.run(abortController.signal);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));

    abortController.abort();
    await runPromise;

    expect(store.list(10)).toMatchObject([
      {
        projectId: project.id,
        projectName: project.name,
        sessionId: 'session-1',
        kind: 'turn-ended',
        summary: 'OpenCode turn finished',
        rawEventType: 'session.idle',
      },
    ]);
    store.close();
  });

  test('deduplicates replayed SDK SSE source events across reconnects', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays = deferredDelay();
    const event = { type: 'session.idle', properties: { sessionID: 'session-1' } };
    const subscribe = vi.fn((options: { onSseEvent?: (event: { id: string; data: unknown }) => void }) =>
      subscribeResult(sdkSseStream([{ id: 'sse-event-1', data: event }], options.onSseEvent)),
    );
    const client: MonitorClient = { event: { subscribe: subscribe as unknown as MonitorClient['event']['subscribe'] } };

    const monitor = new OpenCodeMonitor(project, store, { createMonitorClient: () => client, sleep: delays.sleep });
    const runPromise = monitor.run(abortController.signal);
    await vi.waitFor(() => expect(delays.sleep).toHaveBeenCalledOnce());
    delays.resolveNext();
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));

    abortController.abort();
    await vi.waitFor(() => expect(delays.sleep).toHaveBeenCalledTimes(2));
    delays.resolveNext();
    await runPromise;

    expect(store.list(10)).toMatchObject([
      {
        id: JSON.stringify(['project-alpha', 'sse-event-1']),
        projectId: project.id,
        sessionId: 'session-1',
        kind: 'turn-ended',
      },
    ]);
    expect(store.list(10)).toHaveLength(1);
    store.close();
  });

  test('ignores unsupported and malformed OpenCode events', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal; sseMaxRetryAttempts: number }) => subscribeResult(blockingStream(signal).stream));
    const client: MonitorClient = {
      event: {
        subscribe: subscribe
          .mockReturnValueOnce(subscribeResult(streamFrom([
            { type: 'session.status', properties: { sessionID: 'session-1' } },
            { type: 'session.idle', properties: {} },
            null,
          ])))
      },
    };

    const monitor = new OpenCodeMonitor(project, store, { createMonitorClient: () => client, sleep: async () => {} });
    const runPromise = monitor.run(abortController.signal);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));

    abortController.abort();
    await runPromise;

    expect(store.list(10)).toEqual([]);
    store.close();
  });

  test('reconnects after stream failures with capped exponential delays', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays = deferredDelay();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal; sseMaxRetryAttempts: number }) => subscribeResult(blockingStream(signal).stream));
    const client: MonitorClient = {
      event: {
        subscribe: subscribe
          .mockReturnValueOnce(subscribeResult(streamFrom([], { failWith: new Error('first') })))
          .mockReturnValueOnce(subscribeResult(streamFrom([], { failWith: new Error('second') })))
          .mockReturnValueOnce(subscribeResult(streamFrom([], { failWith: new Error('third') })))
          .mockReturnValueOnce(subscribeResult(streamFrom([], { failWith: new Error('fourth') })))
          .mockReturnValueOnce(subscribeResult(streamFrom([], { failWith: new Error('fifth') })))
          .mockReturnValueOnce(subscribeResult(streamFrom([], { failWith: new Error('sixth') })))
      },
    };

    const monitor = new OpenCodeMonitor(project, store, {
      createMonitorClient: () => client,
      sleep: delays.sleep,
      logger: { warn: vi.fn() },
    });
    const runPromise = monitor.run(abortController.signal);

    for (let index = 0; index < 6; index += 1) {
      await flushPromises();
      delays.resolveNext();
    }
    await flushPromises();

    abortController.abort();
    await runPromise;

    expect(delays.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(store.list(10)).toEqual([]);
    store.close();
  });

  test('abort signal cancels the active stream and stops without scheduling another reconnect', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays = deferredDelay();
    let abortCalled!: Promise<void>;
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal; sseMaxRetryAttempts: number }) => {
      const blocking = blockingStream(signal);
      abortCalled = blocking.abortCalled;
      return subscribeResult(blocking.stream);
    });
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(project, store, {
      createMonitorClient: () => client,
      sleep: delays.sleep,
    });
    const runPromise = monitor.run(abortController.signal);
    await flushPromises();

    abortController.abort();
    await abortCalled;
    await runPromise;

    expect(delays.sleep).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);
    store.close();
  });

  test('keeps retrying unavailable endpoints without rejecting the monitor promise', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays = deferredDelay();
    const logger = { warn: vi.fn() };
    const client: MonitorClient = {
      event: {
        subscribe: vi.fn(() => {
          throw new Error('connect ECONNREFUSED token=secret');
        }),
      },
    };

    const monitor = new OpenCodeMonitor(project, store, {
      createMonitorClient: () => client,
      sleep: delays.sleep,
      logger,
    });
    const runPromise = monitor.run(abortController.signal);

    await flushPromises();
    expect(delays.delays).toEqual([1_000]);
    delays.resolveNext();
    await flushPromises();
    expect(delays.delays).toEqual([1_000, 2_000]);

    abortController.abort();
    delays.resolveNext();
    await expect(runPromise).resolves.toBeUndefined();
    expect(store.list(10)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('OpenCode event stream failed for project project-alpha: Error');
    store.close();
  });

  test('propagates inbox persistence failures instead of reconnecting as if the stream failed', async () => {
    const store = await createStore();
    store.close();
    const abortController = new AbortController();
    const logger = { warn: vi.fn() };
    const client: MonitorClient = {
      event: {
        subscribe: vi.fn(() =>
          subscribeResult(streamFrom([{ type: 'session.idle', properties: { sessionID: 'session-1' } }])),
        ),
      },
    };
    const monitor = new OpenCodeMonitor(project, store, {
      createMonitorClient: () => client,
      sleep: async () => {
        abortController.abort();
      },
      logger,
    });

    await expect(monitor.run(abortController.signal)).rejects.toThrow(/database connection is not open/u);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('defaultSleep', () => {
  test('removes its abort listener after the timer expires normally', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');

    const sleepPromise = defaultSleep(1_000, abortController.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await sleepPromise;

    expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith('abort', addEventListener.mock.calls[0]?.[1]);
    vi.useRealTimers();
  });

  test('removes its abort listener after abort cancels the timer', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const addEventListener = vi.spyOn(abortController.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(abortController.signal, 'removeEventListener');

    const sleepPromise = defaultSleep(1_000, abortController.signal);
    abortController.abort();

    await expect(sleepPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith('abort', addEventListener.mock.calls[0]?.[1]);
    vi.useRealTimers();
  });
});
