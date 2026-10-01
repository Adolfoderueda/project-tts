import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import type { ProjectConfig } from './config.js';
import { assertSessionLocation } from './opencode-session.js';
import { normalizeProjectDirectory } from './project-paths.js';
import { assertVoiceText } from './voice-text.js';

export type ResponseSummary = { id: string; completedAt: number };
export type CompletedResponse = ResponseSummary & { sessionId: string; text: string };

type RequestOptions = { signal: AbortSignal };

export interface ResponseClient {
  session: {
    get(input: { sessionID: string }, options: RequestOptions): Promise<unknown>;
    message: {
      get(input: { sessionID: string; messageID: string }, options: RequestOptions): Promise<unknown>;
    };
  };
  message: {
    list(input: { sessionID: string; limit: number; order: 'desc'; type: 'assistant' }, options: RequestOptions): Promise<unknown>;
  };
}

export async function createResponseClient(): Promise<ResponseClient> {
  const endpoint = await Service.discover();
  if (endpoint === undefined) {
    throw new Error('No healthy OpenCode V2 service was discovered');
  }
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function completedResponse(value: unknown, sessionId: string): CompletedResponse {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 ||
    value.type !== 'assistant' || value.finish !== 'stop' || value.error !== undefined ||
    !isRecord(value.time) || typeof value.time.completed !== 'number' || !Number.isFinite(value.time.completed) ||
    !Array.isArray(value.content)) {
    throw new Error('OpenCode message is not an eligible completed assistant response');
  }
  const text = value.content.flatMap((part: unknown) => {
    if (!isRecord(part) || part.type !== 'text') return [];
    if (typeof part.text !== 'string') throw new Error('OpenCode response text could not be verified');
    return [part.text];
  }).join('\n');
  assertVoiceText(text);
  return { id: value.id, sessionId, completedAt: value.time.completed, text };
}

function requestOptions(): RequestOptions {
  return { signal: AbortSignal.timeout(30_000) };
}

export class OpenCodeResponses {
  readonly #createClient: () => Promise<ResponseClient>;

  constructor(options: { createClient?: () => Promise<ResponseClient> } = {}) {
    this.#createClient = options.createClient ?? createResponseClient;
  }

  async verify(project: ProjectConfig, sessionId: string): Promise<void> {
    const client = await this.#createClient();
    await this.#checkSession(client, project, sessionId);
  }

  async list(project: ProjectConfig, sessionId: string, limit = 20): Promise<ResponseSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('OpenCode response list limit must be an integer from 1 to 20');
    }
    const client = await this.#createClient();
    await this.#checkSession(client, project, sessionId);
    const page = await client.message.list({ sessionID: sessionId, limit, order: 'desc', type: 'assistant' }, requestOptions());
    if (!isRecord(page) || !Array.isArray(page.data) || !isRecord(page.cursor) ||
      ![page.cursor.previous, page.cursor.next].every((cursor) => cursor === undefined || cursor === null || typeof cursor === 'string')) {
      throw new Error('OpenCode response page could not be verified');
    }
    const summaries: ResponseSummary[] = [];
    for (const value of page.data) {
      try {
        const { id, completedAt } = completedResponse(value, sessionId);
        summaries.push({ id, completedAt });
      } catch {
        // Ineligible messages never appear in the selectable response list.
      }
    }
    return summaries;
  }

  async get(project: ProjectConfig, sessionId: string, messageId: string): Promise<CompletedResponse> {
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new Error('OpenCode message ID is missing');
    }
    const client = await this.#createClient();
    await this.#checkSession(client, project, sessionId);
    const value = await client.session.message.get({ sessionID: sessionId, messageID: messageId }, requestOptions());
    if (!isRecord(value) || value.id !== messageId) {
      throw new Error('OpenCode message ID could not be verified');
    }
    return completedResponse(value, sessionId);
  }

  async #checkSession(client: ResponseClient, project: ProjectConfig, sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('OpenCode session ID is missing');
    }
    normalizeProjectDirectory(project.directory);
    const session = await client.session.get({ sessionID: sessionId }, requestOptions());
    assertSessionLocation(session, project, sessionId);
  }
}
