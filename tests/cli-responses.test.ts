import { expect, test, vi } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliDependencies } from '../src/cli.js';
import { runResponses, runSpeakResponse } from '../src/cli-responses.js';
import { EventStore } from '../src/store.js';
function capture(tty = true) {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  Object.assign(stream, { isTTY: tty });
  return { stream, text: () => text };
}
async function setup(translation = true, language: string | undefined = 'en') {
  const directory = await mkdtemp(join(tmpdir(), 'cli-response-'));
  const config = join(directory, 'config.json'); const output = join(directory, 'speech.wav');
  const project = { id: 'alpha', name: 'Alpha', directory, ...(language ? { chatLanguage: language } : {}) };
  await writeFile(config, JSON.stringify({ databasePath: join(directory, 'events.sqlite'), projects: [project], ...(translation ? { translation: { model: 'gemma4:e2b', digest: 'a'.repeat(64) } } : {}) }));
  const store = new EventStore(join(directory, 'events.sqlite'));
  store.insert({ id: 'event', projectId: 'alpha', projectName: 'Alpha', sessionId: 'session', kind: 'turn-ended', occurredAt: '2026-10-01T00:00:00Z', summary: 'PRIVATE_TEXT', rawEventType: 'session.idle' }); store.close();
  const close = vi.fn(); const list = vi.fn(async () => [{ id: 'chosen', completedAt: 123, text: 'PRIVATE_TEXT' }]);
  const get = vi.fn(async () => ({ id: 'chosen', sessionId: 'session', completedAt: 123, text: 'hello\u001b' }));
  const verify = vi.fn(async () => {}); const translate = vi.fn(async () => 'hola\u001b');
  const synthesize = vi.fn(async () => Buffer.from('RIFF0000WAVE'));
  const deps: CliDependencies = {
    createStore: path => { const real = new EventStore(path); return { get: real.get.bind(real), close: () => { close(); real.close(); } } as EventStore; },
    createResponses: () => ({ list, get, verify }), createTranslator: () => ({ translate }), createVoice: () => ({ synthesize }),
    createMonitor: () => { throw new Error('no monitor'); }, onSigint: () => () => {},
  };
  const stdout = capture(); const stderr = capture(); const io = { stdout: stdout.stream, stderr: stderr.stream };
  const base = ['--config', config, '--event-id', 'event'];
  const speech = [...base, '--message-id', 'chosen', '--output', output];
  return { directory, config, output, project, close, list, get, verify, translate, synthesize, deps, stdout, stderr, io, base, speech };
}
test('listing defaults to 20, needs no translation, and prints only selection metadata', async () => {
  const f = await setup(false);
  expect(await main(['responses', ...f.base, '--json'], f.io, f.deps)).toBe(0);
  expect(f.list).toHaveBeenCalledWith(f.project, 'session', 20);
  expect(JSON.parse(f.stdout.text())).toEqual({ projectId: 'alpha', projectName: 'Alpha', sessionId: 'session', responses: [{ id: 'chosen', completedAt: 123 }] });
  expect(f.stdout.text()).not.toContain('PRIVATE_TEXT'); expect(f.close).toHaveBeenCalledOnce();
  expect(f.translate).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
});
test('empty page reports no eligible response; explicit bounded limit works', async () => {
  const f = await setup(); f.list.mockResolvedValueOnce([]);
  expect(await runResponses([...f.base, '--limit', '1'], f.io, f.deps)).toBe(0);
  expect(f.list).toHaveBeenCalledWith(f.project, 'session', 1);
  expect(f.stdout.text()).toMatch(/no eligible/i);
});
test.each([
  ['--limit', '0'], ['--limit', '21'], ['--limit', '1.5'], ['--limit'], ['--json', '--json'], ['--config', 'duplicate'], ['--unknown'], ['--limit', '1', '--limit', '2'],
])('rejects invalid listing flags %j', async (...extra) => {
  const f = await setup(); expect(await runResponses([...f.base, ...extra], f.io, f.deps)).toBe(2); expect(f.list).not.toHaveBeenCalled();
});
test.each([
  ['--chat-language', 'fr'], ['--chat-language'], ['--message-id', 'duplicate'], ['--output', 'duplicate'], ['--unknown', 'value'], ['--chat-language', 'es', '--chat-language', 'en'],
])('rejects invalid speech flags %j', async (...extra) => {
  const f = await setup(); expect(await runSpeakResponse([...f.speech, ...extra], f.io, f.deps)).toBe(2); expect(f.get).not.toHaveBeenCalled();
});
test('requires all exact flags', async () => {
  const f = await setup();
  for (let index = 0; index < f.speech.length; index += 2) {
    expect(await runSpeakResponse(f.speech.filter((_, i) => i !== index && i !== index + 1), f.io, f.deps)).toBe(2);
  }
  expect(await runResponses(['--config', f.config], f.io, f.deps)).toBe(2);
});
test('speech selects exact ID, previews escaped controls/labels, leaves TTS data intact and never prompts', async () => {
  const f = await setup(); expect(await main(['speak-response', ...f.speech], f.io, f.deps)).toBe(0);
  expect(f.get).toHaveBeenCalledWith(f.project, 'session', 'chosen');
  expect(f.synthesize).toHaveBeenCalledWith('hola\u001b');
  for (const label of ['Alpha', 'session', 'chosen', 'Original (en)', 'Spanish', 'hello\\u001b', 'hola\\u001b']) expect(f.stdout.text()).toContain(label);
  expect(f.stdout.text()).not.toContain('\u001b'); expect(f.stdout.text()).not.toMatch(/confirm|type yes|latest|caused/i);
  expect(await readFile(f.output)).toEqual(Buffer.from('RIFF0000WAVE')); expect(f.close).toHaveBeenCalledOnce();
});
test('stdout TTY is required before content retrieval but stdin is not', async () => {
  const f = await setup(); expect(await runSpeakResponse(f.speech, { ...f.io, stdout: capture(false).stream }, f.deps)).toBe(1);
  expect(f.get).not.toHaveBeenCalled(); expect(f.translate).not.toHaveBeenCalled();
});
test.each([[false, 'en'], [true, undefined]] as const)('speech needs bilingual config and declared language', async (translation, language) => {
  const f = await setup(translation, language); // Explicitly remove the helper default when language is absent.
  if (language === undefined) {
    const config = JSON.parse(await readFile(f.config, 'utf8')); delete config.projects[0].chatLanguage; await writeFile(f.config, JSON.stringify(config));
  }
  expect(await runSpeakResponse(f.speech, f.io, f.deps)).toBe(1); expect(f.get).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
});
test('override resolves missing language and Spanish bypasses translation', async () => {
  const f = await setup(true, 'en');
  const config = JSON.parse(await readFile(f.config, 'utf8')); delete config.projects[0].chatLanguage; await writeFile(f.config, JSON.stringify(config));
  expect(await runSpeakResponse([...f.speech, '--chat-language', 'es'], f.io, f.deps)).toBe(0);
  expect(f.translate).not.toHaveBeenCalled(); expect(f.synthesize).toHaveBeenCalledWith('hello\u001b');
});
test('existing output is rejected before retrieval and preserved with content-free diagnostic', async () => {
  const f = await setup(); await writeFile(f.output, 'original recording');
  expect(await runSpeakResponse(f.speech, f.io, f.deps)).toBe(1);
  expect(f.get).not.toHaveBeenCalled(); expect(f.translate).not.toHaveBeenCalled(); expect(f.synthesize).not.toHaveBeenCalled();
  expect(await readFile(f.output, 'utf8')).toBe('original recording'); expect(f.close).toHaveBeenCalledOnce();
});
test('configuration errors do not echo credentials or private content', async () => {
  const f = await setup(); await writeFile(f.config, 'PRIVATE_TEXT Bearer secret-token');
  expect(await runResponses(f.base, f.io, f.deps)).toBe(1);
  expect(await runSpeakResponse(f.speech, f.io, f.deps)).toBe(1);
  expect(f.stderr.text()).not.toMatch(/PRIVATE_TEXT|Bearer|secret-token/); expect(f.get).not.toHaveBeenCalled();
});
test('unknown event or removed project fails closed with store cleanup', async () => {
  const f = await setup();
  expect(await runResponses(['--config', f.config, '--event-id', 'missing'], f.io, f.deps)).toBe(1);
  const config = JSON.parse(await readFile(f.config, 'utf8')); config.projects[0].id = 'removed'; await writeFile(f.config, JSON.stringify(config));
  expect(await runSpeakResponse(f.speech, f.io, f.deps)).toBe(1);
  expect(f.get).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(2);
});
test.each(['list', 'get', 'translate', 'verify', 'synthesize'] as const)('redacts raw %s failure and closes store', async stage => {
  const f = await setup(); f[stage].mockRejectedValueOnce(new Error('PRIVATE_TEXT Bearer secret-token'));
  const result = stage === 'list' ? await runResponses(f.base, f.io, f.deps) : await runSpeakResponse(f.speech, f.io, f.deps);
  expect(result).toBe(1); expect(f.stderr.text()).not.toMatch(/PRIVATE_TEXT|Bearer|secret-token/); expect(f.close).toHaveBeenCalledOnce();
  await expect(readFile(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
});
test.each(['responses', 'speak-response'] as const)('contains %s store close errors after success and workflow failure', async command => {
  for (const failWorkflow of [false, true]) {
    const f = await setup();
    const createStore = f.deps.createStore;
    f.deps.createStore = path => {
      const store = createStore(path);
      const close = store.close.bind(store);
      store.close = () => { close(); throw new Error('PRIVATE_TEXT Bearer secret-token'); };
      return store;
    };
    if (failWorkflow) {
      (command === 'responses' ? f.list : f.get).mockRejectedValueOnce(new Error('PRIVATE_TEXT workflow credentials'));
    }
    const result = command === 'responses' ? runResponses(f.base, f.io, f.deps) : runSpeakResponse(f.speech, f.io, f.deps);
    await expect(result).resolves.toBe(1);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.stderr.text()).toContain('Response command cleanup failed.');
    expect(f.stderr.text()).not.toMatch(/PRIVATE_TEXT|Bearer|secret-token|credentials/);
  }
});
