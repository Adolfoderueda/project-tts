import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import type { ProjectConfig } from './config.js';
import { normalizeProjectDirectory } from './project-paths.js';

export type VerifiedDestination = { project: ProjectConfig; sessionId: string };

export interface ReplyClient {
  session: {
    get(input: { sessionID: string }): Promise<unknown>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
  };
}

export type CreateReplyClient = () => Promise<ReplyClient>;

export async function createReplyClient(): Promise<ReplyClient> {
  const endpoint = await Service.discover();
  if (endpoint === undefined) {
    throw new Error('No healthy OpenCode V2 service was discovered');
  }
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
}

export class OpenCodeReply {
  readonly #createClient: CreateReplyClient;

  constructor(options: { createClient?: CreateReplyClient } = {}) {
    this.#createClient = options.createClient ?? createReplyClient;
  }

  async verify(project: ProjectConfig, sessionId: string): Promise<VerifiedDestination> {
    const client = await this.#createClient();
    await this.#checkSession(client, project, sessionId);
    return { project, sessionId };
  }

  async send(destination: VerifiedDestination, text: string): Promise<void> {
    const client = await this.#createClient();
    await this.#checkSession(client, destination.project, destination.sessionId);
    try {
      await client.session.prompt({ sessionID: destination.sessionId, text });
    } catch (cause) {
      throw new Error('OpenCode prompt failed; delivery may be uncertain. Inspect the session before trying again.', { cause });
    }
  }

  async #checkSession(client: ReplyClient, project: ProjectConfig, sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('OpenCode session ID is missing');
    }
    const expectedDirectory = normalizeProjectDirectory(project.directory);
    const session: unknown = await client.session.get({ sessionID: sessionId });
    if (typeof session !== 'object' || session === null || !('id' in session) || session.id !== sessionId ||
      !('location' in session) || typeof session.location !== 'object' || session.location === null ||
      !('directory' in session.location) || typeof session.location.directory !== 'string') {
      throw new Error('OpenCode session ID or location could not be verified');
    }
    let actualDirectory: string;
    try {
      actualDirectory = normalizeProjectDirectory(session.location.directory);
    } catch {
      throw new Error('OpenCode session location could not be verified');
    }
    if (actualDirectory !== expectedDirectory) {
      throw new Error('OpenCode session location does not match the configured project');
    }
  }
}
