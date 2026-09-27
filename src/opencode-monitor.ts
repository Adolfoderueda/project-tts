import { createOpencodeClient } from '@opencode-ai/sdk';
import { mapOpenCodeEvent, type ProjectConfig } from './events.js';
import { EventStore } from './store.js';

export type MonitorEventStream = AsyncIterable<unknown>;

interface SubscribeOptions {
  signal: AbortSignal;
  sseMaxRetryAttempts: number;
  onSseError?: (error: unknown) => void;
  onSseEvent?: (event: { id?: string; data?: unknown }) => void;
}

interface SubscribeResult {
  stream: MonitorEventStream;
}

export interface MonitorClient {
  event: {
    subscribe(options: SubscribeOptions): SubscribeResult | Promise<SubscribeResult>;
  };
}

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type Logger = Pick<typeof console, 'warn'>;

export type CreateMonitorClient = (project: ProjectConfig) => MonitorClient;

interface OpenCodeMonitorOptions {
  createMonitorClient?: CreateMonitorClient;
  sleep?: Sleep;
  logger?: Logger;
}

const reconnectDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

class EventPersistenceError extends Error {
  constructor(cause: unknown) {
    const details = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to persist captured OpenCode event: ${details}`, { cause });
    this.name = 'EventPersistenceError';
  }
}

export function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AbortError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      cleanup();
      reject(new AbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function getReconnectDelay(failureCount: number): number {
  return reconnectDelaysMs[Math.min(failureCount, reconnectDelaysMs.length - 1)];
}

function diagnosticName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return typeof error;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createMonitorClient(project: ProjectConfig): MonitorClient {
  return createOpencodeClient({ baseUrl: project.baseURL }) as MonitorClient;
}

export class OpenCodeMonitor {
  readonly #project: ProjectConfig;
  readonly #store: EventStore;
  readonly #client: MonitorClient;
  readonly #sleep: Sleep;
  readonly #logger: Logger;

  constructor(project: ProjectConfig, store: EventStore, options: OpenCodeMonitorOptions = {}) {
    this.#project = project;
    this.#store = store;
    this.#client = (options.createMonitorClient ?? createMonitorClient)(project);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#logger = options.logger ?? console;
  }

  async run(signal: AbortSignal): Promise<void> {
    let failureCount = 0;

    while (!signal.aborted) {
      let streamErrorReported = false;
      const logStreamFailure = (error: unknown) => {
        if (signal.aborted || streamErrorReported) {
          return;
        }

        streamErrorReported = true;
        this.#logger.warn(`OpenCode event stream failed for project ${this.#project.id}: ${diagnosticName(error)}`);
      };

      try {
        const sourceEventIds = new WeakMap<object, string>();
        const result = await this.#client.event.subscribe({
          signal,
          sseMaxRetryAttempts: 1,
          onSseError: logStreamFailure,
          onSseEvent: ({ id, data }) => {
            if (typeof id === 'string' && id.length > 0 && typeof data === 'object' && data !== null) {
              sourceEventIds.set(data, id);
            }
          },
        });

        for await (const event of result.stream) {
          if (signal.aborted) {
            break;
          }

          const sourceEventId = typeof event === 'object' && event !== null ? sourceEventIds.get(event) : undefined;
          const mappedEvent = mapOpenCodeEvent(this.#project, event, new Date(), sourceEventId);
          if (mappedEvent !== null) {
            try {
              this.#store.insert(mappedEvent);
            } catch (error) {
              throw new EventPersistenceError(error);
            }
          }
        }

        if (signal.aborted) {
          break;
        }
      } catch (error) {
        if (error instanceof EventPersistenceError) {
          throw error;
        }

        if (signal.aborted || isAbortLikeError(error)) {
          break;
        }

        logStreamFailure(error);
      }

      if (signal.aborted) {
        break;
      }

      const delay = getReconnectDelay(failureCount);
      failureCount += 1;

      try {
        await this.#sleep(delay, signal);
      } catch (error) {
        if (signal.aborted || isAbortLikeError(error)) {
          break;
        }
        throw error;
      }
    }
  }
}
