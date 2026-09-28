import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { mapOpenCodeEvent, type ProjectConfig } from './events.js';
import { EventStore } from './store.js';

export type MonitorEventStream = AsyncIterable<unknown>;

export interface MonitorClient {
  event: {
    subscribe(options: { signal: AbortSignal }): MonitorEventStream;
  };
}

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type Logger = Pick<typeof console, 'warn'>;

export type CreateMonitorClient = () => Promise<MonitorClient>;

interface OpenCodeMonitorOptions {
  createMonitorClient?: CreateMonitorClient;
  sleep?: Sleep;
  logger?: Logger;
}

const reconnectDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const streamGapWarning = 'OpenCode V2 event stream disconnected; events during this outage may have been missed because V2 does not replay events.';
const serviceUnavailableWarning = 'OpenCode V2 service is unavailable; ensure the OpenCode background service is running before the bridge retries.';

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

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function createMonitorClient(): Promise<MonitorClient> {
  const endpoint = await Service.discover();
  if (endpoint === undefined) {
    throw new Error('No healthy OpenCode V2 service was discovered');
  }

  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
}

export class OpenCodeMonitor {
  readonly #projects: readonly ProjectConfig[];
  readonly #store: EventStore;
  readonly #createMonitorClient: CreateMonitorClient;
  readonly #sleep: Sleep;
  readonly #logger: Logger;

  constructor(projects: readonly ProjectConfig[], store: EventStore, options: OpenCodeMonitorOptions = {}) {
    this.#projects = projects;
    this.#store = store;
    this.#createMonitorClient = options.createMonitorClient ?? createMonitorClient;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#logger = options.logger ?? console;
  }

  async run(signal: AbortSignal): Promise<void> {
    let failureCount = 0;

    while (!signal.aborted) {
      let client: MonitorClient;
      try {
        client = await this.#createMonitorClient();
      } catch {
        if (signal.aborted) {
          break;
        }
        this.#logger.warn(serviceUnavailableWarning);
        await this.#waitBeforeReconnect(failureCount, signal);
        failureCount += 1;
        continue;
      }

      try {
        const stream = client.event.subscribe({ signal });
        for await (const event of stream) {
          if (signal.aborted) {
            break;
          }

          const capturedEvent = mapOpenCodeEvent(this.#projects, event, new Date());
          if (capturedEvent !== null) {
            try {
              this.#store.insert(capturedEvent);
            } catch (error) {
              throw new EventPersistenceError(error);
            }
          }
        }

        if (signal.aborted) {
          break;
        }

        this.#logger.warn(streamGapWarning);
      } catch (error) {
        if (error instanceof EventPersistenceError) {
          throw error;
        }
        if (signal.aborted || isAbortLikeError(error)) {
          break;
        }

        this.#logger.warn(streamGapWarning);
      }

      if (signal.aborted) {
        break;
      }

      await this.#waitBeforeReconnect(failureCount, signal);
      failureCount += 1;
    }
  }

  async #waitBeforeReconnect(failureCount: number, signal: AbortSignal): Promise<void> {
    try {
      await this.#sleep(getReconnectDelay(failureCount), signal);
    } catch (error) {
      if (!signal.aborted && !isAbortLikeError(error)) {
        throw error;
      }
    }
  }
}
