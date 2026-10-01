import { expect, test, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speakResponse, type ResponseSpeechInput } from '../src/response-speech.js';
const wav = Buffer.from('RIFF0000WAVE');
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'response-'));
  const input: ResponseSpeechInput = {
    event: { id: 'event', projectId: 'alpha', projectName: 'Alpha', sessionId: 'session', kind: 'turn-ended', occurredAt: 'now', summary: '', rawEventType: 'session.idle' },
    project: { id: 'alpha', name: 'Alpha', directory }, messageId: 'chosen', outputPath: join(directory, 'new.wav'), chatLanguage: 'en',
  };
  return input;
}
test('gets exact response, translates, previews, rechecks then synthesizes and writes', async () => {
  const input = await setup(); const order: string[] = [];
  const original = 'hello\u001b'; const spanish = 'hola\u001b';
  await speakResponse(input, {
    get: async (project, sessionId, messageId) => { expect([project, sessionId, messageId]).toEqual([input.project, 'session', 'chosen']); order.push('get'); return { id: messageId, sessionId, completedAt: 1, text: original }; },
    verify: async (project, sessionId) => { expect([project, sessionId]).toEqual([input.project, 'session']); order.push('verify'); },
  }, { translate: async (text, source, target) => { expect([text, source, target]).toEqual([original, 'en', 'es']); order.push('translate'); return spanish; } },
  { synthesize: async text => { expect(text).toBe(spanish); order.push('synthesize'); return wav; } },
  preview => { expect(preview).toEqual({ project: input.project, sessionId: 'session', messageId: 'chosen', sourceLanguage: 'en', originalText: original, spanishText: spanish }); order.push('preview'); });
  expect(order).toEqual(['get', 'translate', 'preview', 'verify', 'synthesize']);
  expect(await readFile(input.outputPath)).toEqual(wav);
});
test('Spanish bypasses translation and moved directory after preview prevents synthesis/output', async () => {
  const input = await setup(); input.chatLanguage = 'es';
  const translate = vi.fn(); const synthesize = vi.fn(async () => wav);
  const responses = { get: async () => ({ id: 'chosen', sessionId: 'session', completedAt: 1, text: 'hola' }), verify: async (): Promise<void> => { throw new Error('moved'); } };
  await expect(speakResponse(input, responses, { translate }, { synthesize }, preview => expect(preview.spanishText).toBe('hola'))).rejects.toThrow('moved');
  expect(translate).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
  await expect(readFile(input.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  responses.verify = async () => {};
  await speakResponse(input, responses, { translate }, { synthesize }, () => {});
  expect(synthesize).toHaveBeenCalledWith('hola'); expect(translate).not.toHaveBeenCalled();
});
test('existing/non-WAV output fails before response retrieval', async () => {
  const input = await setup(); await writeFile(input.outputPath, 'original'); const get = vi.fn();
  const run = () => speakResponse(input, { get, verify: vi.fn() }, { translate: vi.fn() }, { synthesize: vi.fn() }, vi.fn());
  await expect(run()).rejects.toThrow(); input.outputPath += '.mp3'; await expect(run()).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});
test.each(['', 'x'.repeat(2001)])('rejects invalid source before translation', async text => {
  const input = await setup(); const translate = vi.fn();
  await expect(speakResponse(input, { get: async () => ({ id: 'chosen', sessionId: 'session', completedAt: 1, text }), verify: vi.fn() }, { translate }, { synthesize: vi.fn() }, vi.fn())).rejects.toThrow();
  expect(translate).not.toHaveBeenCalled();
});
test.each(['', 'x'.repeat(2001)])('rejects invalid Spanish translation before preview or synthesis', async spanish => {
  const input = await setup(); const preview = vi.fn(); const synthesize = vi.fn(); const verify = vi.fn();
  await expect(speakResponse(input, { get: async () => ({ id: 'chosen', sessionId: 'session', completedAt: 1, text: 'hello' }), verify }, { translate: async () => spanish }, { synthesize }, preview)).rejects.toThrow();
  expect(preview).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
  await expect(readFile(input.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
});
