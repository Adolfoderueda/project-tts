import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { OpenCodeReply, type ReplyClient } from '../src/opencode-reply.js';
import type { ProjectConfig } from '../src/config.js';

const project: ProjectConfig = { id: 'alpha', name: 'Alpha', directory: join(tmpdir(), 'voice-alpha') };
const sessionId = 'session-alpha';

function clientWith(get: (input: { sessionID: string }) => Promise<unknown>) {
  const prompt = vi.fn(async (_input: { sessionID: string; text: string }) => ({}));
  const client: ReplyClient = { session: { get: vi.fn(get), prompt } };
  return { client, get: client.session.get, prompt };
}

function validSession(directory = project.directory) {
  return { id: sessionId, location: { directory } };
}

describe('OpenCodeReply', () => {
  test('verifies a matching session and sends only the specified text to it after rechecking', async () => {
    const { client, get, prompt } = clientWith(async () => validSession());
    const reply = new OpenCodeReply({ createClient: async () => client });
    const destination = await reply.verify(project, sessionId);

    expect(destination).toEqual({ project, sessionId });
    await reply.send(destination, 'Texto editado');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, { sessionID: sessionId });
    expect(get).toHaveBeenNthCalledWith(2, { sessionID: sessionId });
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith({ sessionID: sessionId, text: 'Texto editado' });
  });

  test('does not prompt when the service is absent', async () => {
    const reply = new OpenCodeReply({ createClient: async () => { throw new Error('No healthy OpenCode V2 service was discovered'); } });
    await expect(reply.verify(project, sessionId)).rejects.toThrow('No healthy OpenCode V2 service');
  });

  test.each([
    ['missing session', undefined],
    ['wrong ID', { id: 'session-other', location: { directory: project.directory } }],
    ['wrong directory', validSession(join(tmpdir(), 'voice-other'))],
    ['missing location', { id: sessionId }],
    ['relative directory', validSession('voice-alpha')],
  ])('rejects %s without prompting', async (_reason, session) => {
    const { client, prompt } = clientWith(async () => session);
    const reply = new OpenCodeReply({ createClient: async () => client });
    await expect(reply.verify(project, sessionId)).rejects.toThrow();
    expect(prompt).not.toHaveBeenCalled();
  });

  test('rejects a missing session from the API without prompting', async () => {
    const { client, prompt } = clientWith(async () => { throw new Error('404 session missing'); });
    const reply = new OpenCodeReply({ createClient: async () => client });
    await expect(reply.verify(project, sessionId)).rejects.toThrow('404 session missing');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('rechecks the destination and fails closed if location changes before send', async () => {
    const { client, get, prompt } = clientWith(vi.fn()
      .mockResolvedValueOnce(validSession())
      .mockResolvedValueOnce(validSession(join(tmpdir(), 'voice-other'))));
    const reply = new OpenCodeReply({ createClient: async () => client });
    const destination = await reply.verify(project, sessionId);
    await expect(reply.send(destination, 'No enviar')).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
  });

  test('does not prompt if service discovery fails during the send recheck', async () => {
    const { client, prompt } = clientWith(async () => validSession());
    const createClient = vi.fn()
      .mockResolvedValueOnce(client)
      .mockRejectedValueOnce(new Error('OpenCode service disconnected'));
    const reply = new OpenCodeReply({ createClient });
    const destination = await reply.verify(project, sessionId);
    await expect(reply.send(destination, 'No enviar')).rejects.toThrow('OpenCode service disconnected');
    expect(prompt).not.toHaveBeenCalled();
  });

  test('a timeout after prompt surfaces uncertain delivery without retry', async () => {
    const { client, prompt } = clientWith(async () => validSession());
    prompt.mockRejectedValueOnce(new Error('timeout'));
    const reply = new OpenCodeReply({ createClient: async () => client });
    const destination = await reply.verify(project, sessionId);
    await expect(reply.send(destination, 'Texto')).rejects.toThrow(/delivery may be uncertain/i);
    expect(prompt).toHaveBeenCalledOnce();
  });
});
