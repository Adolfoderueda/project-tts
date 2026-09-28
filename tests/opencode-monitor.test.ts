import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventStore } from '../src/store.js';
import { OpenCodeMonitor, defaultSleep, type MonitorClient, type MonitorEventStream } from '../src/opencode-monitor.js';
import type { ProjectConfig } from '../src/events.js';

const tempDirs: string[] = [];
const alphaDirectory = join(tmpdir(), 'project-tts-monitor-projects', 'alpha');
const betaDirectory = join(tmpdir(), 'project-tts-monitor-projects', 'beta');

const projects: ProjectConfig[] = [
  { id: 'project-alpha', name: 'Project Alpha', directory: alphaDirectory },
  { id: 'project-beta', name: 'Project Beta', directory: betaDirectory },
];

async function createStore(): Promise<EventStore> {
  const directory = await mkdtemp(join(tmpdir(), 'project-tts-monitor-'));
  tempDirs.push(directory);
  return new EventStore(join(directory, 'events.sqlite'));
}

function streamFrom(events: unknown[], failure?: unknown): MonitorEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
}

function blockingStream(signal: AbortSignal): MonitorEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

function v2Event(id: string, directory: string, sessionID: string, type = 'session.idle') {
  return { id, type, data: { sessionID }, location: { directory } };
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
  test('subscribes once to the global V2 stream with the monitor AbortSignal', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => blockingStream(signal));
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(projects, store, { createMonitorClient: async () => client });
    const runPromise = monitor.run(abortController.signal);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    expect(subscribe).toHaveBeenCalledWith({ signal: abortController.signal });
    abortController.abort();
    await runPromise;
    store.close();
  });

  test('routes multiple project events and deduplicates upstream event IDs', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const alphaEvent = v2Event('shared-id', alphaDirectory, 'session-alpha');
    const betaEvent = v2Event('shared-id', betaDirectory, 'session-beta');
    const subscribe = vi.fn(() => streamFrom([alphaEvent, alphaEvent, betaEvent]));
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(projects, store, {
      createMonitorClient: async () => client,
      sleep: async () => abortController.abort(),
      logger: { warn: vi.fn() },
    });
    await monitor.run(abortController.signal);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(store.list(10)).toMatchObject([
      { id: JSON.stringify(['project-beta', 'shared-id']), projectId: 'project-beta', sessionId: 'session-beta' },
      { id: JSON.stringify(['project-alpha', 'shared-id']), projectId: 'project-alpha', sessionId: 'session-alpha' },
    ]);
    expect(store.list(10)).toHaveLength(2);
    store.close();
  });

  test('reports_v2_stream_gaps_without_persisting_transport_errors', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const logger = { warn: vi.fn() };
    const subscribe = vi.fn(() => streamFrom([], new Error('ECONNRESET bearer=secret-token')));
    const client: MonitorClient = { event: { subscribe } };
    const delays: number[] = [];

    const monitor = new OpenCodeMonitor(projects, store, {
      createMonitorClient: async () => client,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        abortController.abort();
      },
      logger,
    });
    await monitor.run(abortController.signal);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/V2 event stream disconnected.*events during this outage may have been missed/u));
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('secret-token');
    expect(store.list(10)).toEqual([]);
    expect(delays).toEqual([1_000]);
    store.close();
  });

  test('reconnects with capped exponential delays', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays: number[] = [];
    const subscribe = vi.fn(() => streamFrom([], new Error('connection failed')));
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(projects, store, {
      createMonitorClient: async () => client,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 7) {
          abortController.abort();
        }
      },
      logger: { warn: vi.fn() },
    });
    await monitor.run(abortController.signal);

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(subscribe).toHaveBeenCalledTimes(7);
    store.close();
  });

  test('resets reconnect backoff after a sustained healthy stream', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const delays: number[] = [];
    let now = 0;
    const subscribe = vi.fn(() => {
      if (subscribe.mock.calls.length === 1) {
        return streamFrom([], new Error('short failure'));
      }
      now += 60_000;
      return streamFrom([]);
    });
    const client: MonitorClient = { event: { subscribe } };

    const monitor = new OpenCodeMonitor(projects, store, {
      createMonitorClient: async () => client,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 2) {
          abortController.abort();
        }
      },
      now: () => now,
      logger: { warn: vi.fn() },
    });
    await monitor.run(abortController.signal);

    expect(delays).toEqual([1_000, 1_000]);
    store.close();
  });

  test('retries_when_v2_service_is_unavailable_without_leaking_diagnostics', async () => {
    const store = await createStore();
    const abortController = new AbortController();
    const logger = { warn: vi.fn() };
    const createMonitorClient = vi.fn(async () => {
      throw new Error('service auth token=private-token');
    });
    const delays: number[] = [];

    const monitor = new OpenCodeMonitor(projects, store, {
      createMonitorClient,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 2) {
          abortController.abort();
        }
      },
      logger,
    });
    await monitor.run(abortController.signal);

    expect(createMonitorClient).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1_000, 2_000]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/OpenCode V2 service is unavailable.*background service is running/u));
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('private-token');
    store.close();
  });

  test('persistence failures propagate rather than reconnecting', async () => {
    const store = await createStore();
    store.close();
    const abortController = new AbortController();
    const logger = { warn: vi.fn() };
    const client: MonitorClient = {
      event: { subscribe: vi.fn(() => streamFrom([v2Event('event-1', alphaDirectory, 'session-1')])) },
    };
    const monitor = new OpenCodeMonitor(projects, store, {
      createMonitorClient: async () => client,
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
