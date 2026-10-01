import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ discover: vi.fn(), headers: vi.fn(), make: vi.fn(), ensure: vi.fn(), start: vi.fn() }));
vi.mock('@opencode/client/service', () => ({ Service: mocks }));
vi.mock('@opencode/client', () => ({ OpenCode: { make: mocks.make } }));

import { createResponseClient, OpenCodeResponses, type ResponseClient } from '../src/opencode-responses.js';

const project = { id: 'demo', name: 'Demo', directory: join(tmpdir(), 'demo') };
const sessionId = 'ses-one';
const messageId = 'msg-one';
const validSession = { id: sessionId, location: { directory: project.directory } };
const message = (overrides: Record<string, unknown> = {}) => ({
  id: messageId, type: 'assistant', agent: 'build', model: { providerID: 'test', modelID: 'test' },
  time: { created: 100, completed: 200 }, finish: 'stop',
  content: [{ type: 'text', text: 'Hola ' }, { type: 'reasoning', text: 'secret' },
    { type: 'tool', id: 'tool-one', name: 'shell', state: { status: 'completed', output: 'secret tool' }, time: { created: 100 } },
    { type: 'text', text: '世界' }], ...overrides,
});

function setup() {
  const getSession = vi.fn(async () => validSession as unknown);
  const getMessage = vi.fn(async () => message() as unknown);
  const list = vi.fn(async () => ({ data: [message()], cursor: { next: 'ignored' } }) as unknown);
  const prompt = vi.fn();
  const session = { get: getSession, message: { get: getMessage }, prompt };
  const client: ResponseClient = { session, message: { list } };
  const responses = new OpenCodeResponses({ createClient: async () => client });
  return { responses, client, getSession, getMessage, list, prompt };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

test('factory discovers authenticated existing V2 service without ensure or start', async () => {
  const endpoint = { url: 'http://127.0.0.1:54321', password: 'secret' };
  const headers = { Authorization: 'Basic test' };
  const { client } = setup();
  mocks.discover.mockResolvedValueOnce(endpoint);
  mocks.headers.mockReturnValueOnce(headers);
  mocks.make.mockReturnValueOnce(client);
  expect(await createResponseClient()).toBe(client);
  expect(mocks.discover).toHaveBeenCalledOnce();
  expect(mocks.headers).toHaveBeenCalledWith(endpoint);
  expect(mocks.make).toHaveBeenCalledWith({ baseUrl: endpoint.url, headers });
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

test('factory fails closed when existing service is absent', async () => {
  mocks.discover.mockResolvedValueOnce(undefined);
  await expect(createResponseClient()).rejects.toThrow('No healthy OpenCode V2 service');
  expect(mocks.make).not.toHaveBeenCalled();
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

test('all reads verify the exact session first, use scoped inputs and 30-second signals, and never prompt', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const { responses, getSession, getMessage, list, prompt } = setup();
  await responses.verify(project, sessionId);
  expect(await responses.list(project, sessionId)).toEqual([{ id: messageId, completedAt: 200 }]);
  expect(await responses.get(project, sessionId, messageId)).toEqual({ id: messageId, sessionId, completedAt: 200, text: 'Hola 世界' });
  expect(getSession).toHaveBeenCalledTimes(3);
  for (const call of getSession.mock.calls) expect(call).toEqual([{ sessionID: sessionId }, { signal: expect.any(AbortSignal) }]);
  expect(list).toHaveBeenCalledExactlyOnceWith({ sessionID: sessionId, limit: 20, order: 'desc', type: 'assistant' }, { signal: expect.any(AbortSignal) });
  expect(getMessage).toHaveBeenCalledExactlyOnceWith({ sessionID: sessionId, messageID: messageId }, { signal: expect.any(AbortSignal) });
  expect(getSession.mock.invocationCallOrder[1]).toBeLessThan(list.mock.invocationCallOrder[0]!);
  expect(getSession.mock.invocationCallOrder[2]).toBeLessThan(getMessage.mock.invocationCallOrder[0]!);
  expect(timeout).toHaveBeenCalledTimes(5);
  expect(timeout.mock.calls.every(([ms]) => ms === 30_000)).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
});

test.each([0, 21, -1, 1.5, NaN, Infinity])('list rejects out-of-bounds limit %s without reads', async (limit) => {
  const { responses, getSession, list } = setup();
  await expect(responses.list(project, sessionId, limit)).rejects.toThrow(/limit/i);
  expect(getSession).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

test.each([1, 20])('list accepts bound %s and reads only one recent page without content', async (limit) => {
  const { responses, list, getMessage, prompt } = setup();
  expect(await responses.list(project, sessionId, limit)).toEqual([{ id: messageId, completedAt: 200 }]);
  expect(list).toHaveBeenCalledExactlyOnceWith({ sessionID: sessionId, limit, order: 'desc', type: 'assistant' }, { signal: expect.any(AbortSignal) });
  expect(getMessage).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

test.each([undefined, {}, [], { data: {} }, { data: [] }, { data: [], cursor: null }, { data: [], cursor: { next: 3 } }])(
  'list rejects malformed page envelope %j', async (page) => {
    const { responses, list } = setup();
    list.mockResolvedValueOnce(page);
    await expect(responses.list(project, sessionId)).rejects.toThrow(/page/i);
  },
);

test('empty page returns no responses', async () => {
  const { responses, list } = setup();
  list.mockResolvedValueOnce({ data: [], cursor: {} });
  expect(await responses.list(project, sessionId)).toEqual([]);
});

const ineligible: [string, unknown][] = [
  ['missing', undefined], ['user', message({ type: 'user' })],
  ['incomplete', message({ time: { created: 100 } })], ['error', message({ error: { message: 'failed' } })],
  ['length-finished', message({ finish: 'length' })], ['tool-finished', message({ finish: 'tool-calls' })],
  ['missing finish', message({ finish: undefined })], ['string timestamp', message({ time: { completed: '200' } })],
  ['NaN timestamp', message({ time: { completed: NaN } })], ['infinite timestamp', message({ time: { completed: Infinity } })],
  ['empty ID', message({ id: '' })], ['wrong ID', message({ id: 'msg-other' })],
  ['empty content', message({ content: [] })], ['blank text', message({ content: [{ type: 'text', text: ' \n' }] })],
  ['reasoning only', message({ content: [{ type: 'reasoning', text: 'secret' }] })],
  ['malformed text', message({ content: [{ type: 'text', text: 42 }] })],
  ['missing content', message({ content: undefined })],
  ['overlong text', message({ content: [{ type: 'text', text: '😀'.repeat(2001) }] })],
];

test.each(ineligible)('get rejects %s rather than selecting another message', async (_name, value) => {
  const { responses, getMessage, list, prompt } = setup();
  getMessage.mockResolvedValueOnce(value);
  await expect(responses.get(project, sessionId, messageId)).rejects.toThrow();
  expect(getMessage).toHaveBeenCalledOnce();
  expect(list).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

test('list filters ineligible records without retaining their content', async () => {
  const { responses, list } = setup();
  list.mockResolvedValueOnce({ data: [...ineligible.filter(([name]) => name !== 'wrong ID').map(([, value]) => value), message()], cursor: {} });
  expect(await responses.list(project, sessionId)).toEqual([{ id: messageId, completedAt: 200 }]);
});

test('page containing only ineligible messages returns no selectable responses', async () => {
  const { responses, list, getMessage } = setup();
  list.mockResolvedValueOnce({ data: [message({ finish: 'length' }), message({ type: 'user' })], cursor: { next: 'not-followed' } });
  expect(await responses.list(project, sessionId)).toEqual([]);
  expect(list).toHaveBeenCalledOnce();
  expect(getMessage).not.toHaveBeenCalled();
});

test('deleted exact message surfaces its read error without a fallback or prompt', async () => {
  const { responses, getMessage, list, prompt } = setup();
  getMessage.mockRejectedValueOnce(new Error('404 message missing'));
  await expect(responses.get(project, sessionId, messageId)).rejects.toThrow('404 message missing');
  expect(getMessage).toHaveBeenCalledOnce();
  expect(list).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

test('visible text is joined in order and limit counts Unicode code points', async () => {
  const { responses, getMessage } = setup();
  getMessage.mockResolvedValueOnce(message({ content: [{ type: 'text', text: '😀'.repeat(2000) }] }));
  expect((await responses.get(project, sessionId, messageId)).text).toBe('😀'.repeat(2000));
});

test.each([
  ['deleted', undefined], ['wrong ID', { ...validSession, id: 'ses-other' }],
  ['moved', { ...validSession, location: { directory: join(tmpdir(), 'other') } }],
])('every operation rejects %s session before accessing messages', async (_name, value) => {
  const { responses, getSession, getMessage, list, prompt } = setup();
  getSession.mockResolvedValue(value);
  await expect(responses.verify(project, sessionId)).rejects.toThrow();
  await expect(responses.list(project, sessionId)).rejects.toThrow();
  await expect(responses.get(project, sessionId, messageId)).rejects.toThrow();
  expect(getMessage).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});

test('location is reverified after verify if session is moved or deleted', async () => {
  const { responses, getSession, getMessage, list } = setup();
  await responses.verify(project, sessionId);
  getSession.mockResolvedValueOnce({ ...validSession, location: { directory: join(tmpdir(), 'other') } });
  await expect(responses.list(project, sessionId)).rejects.toThrow();
  getSession.mockRejectedValueOnce(new Error('404 session missing'));
  await expect(responses.get(project, sessionId, messageId)).rejects.toThrow('404 session missing');
  expect(getMessage).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

test('missing exact IDs fail before any API reads', async () => {
  const { responses, getSession, getMessage, list } = setup();
  await expect(responses.verify(project, '')).rejects.toThrow(/session ID/);
  await expect(responses.list(project, '')).rejects.toThrow(/session ID/);
  await expect(responses.get(project, sessionId, '')).rejects.toThrow(/message ID/);
  expect(getSession).not.toHaveBeenCalled();
  expect(getMessage).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
