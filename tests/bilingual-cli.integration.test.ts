import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { main, type CliDependencies } from '../src/cli.js';
import { EventStore } from '../src/store.js';
import { OllamaTranslator } from '../src/translation-client.js';
import { OpenCodeResponses } from '../src/opencode-responses.js';
import { OpenCodeReply } from '../src/opencode-reply.js';
import { VoiceClient, isWav } from '../src/voice-client.js';
import type { ChatLanguage } from '../src/config.js';

const english = 'Do not delete `src/cli.ts`.';
const spanish = 'No borres `src/cli.ts`.';
const privateText = 'PRIVATE_FIXTURE Bearer secret-token';
const wav = Buffer.from('RIFF0000WAVEsynthetic-only');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function snapshot(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string; sql: string }[];
    return tables.map(table => {
      const rows = db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}" ORDER BY rowid`).all();
      return { ...table, count: rows.length, rows };
    });
  } finally { db.close(); }
}

async function setup(language: ChatLanguage | undefined = 'en') {
  const directory = await mkdtemp(join(tmpdir(), 'bilingual-integration-'));
  directories.push(directory);
  const databasePath = join(directory, 'events.sqlite');
  const configPath = join(directory, 'config.json');
  const audioPath = join(directory, 'recording.wav');
  const projects = ['alpha', 'beta'].map(id => ({ id, name: id.toUpperCase(), directory: join(directory, id), ...(language ? { chatLanguage: language } : {}) }));
  const config = { databasePath, projects, translation: { model: 'gemma4:e2b', digest: 'a'.repeat(64) } };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(audioPath, wav);
  const events = projects.map(project => ({ id: `event-${project.id}`, projectId: project.id, projectName: project.name, sessionId: `session-${project.id}`, kind: 'turn-ended' as const, occurredAt: '2026-10-01T00:00:00Z', summary: 'Turn finished', rawEventType: 'session.idle' }));
  const seed = new EventStore(databasePath);
  try { events.forEach(event => seed.insert(event)); } finally { seed.close(); }
  const before = snapshot(databasePath);
  let moved = false;
  const getSession = vi.fn(async ({ sessionID }: { sessionID: string }) => {
    const index = events.findIndex(event => event.sessionId === sessionID);
    if (index < 0) throw new Error(privateText);
    return { id: sessionID, location: { directory: projects[moved ? 1 - index : index].directory } };
  });
  const prompt = vi.fn(async (_input: { sessionID: string; text: string }) => undefined);
  const responseText = new Map(events.map(event => [event.sessionId, language === 'es' ? spanish : english]));
  const message = (sessionID: string) => ({ id: `message-${sessionID}`, type: 'assistant', finish: 'stop', time: { completed: 123 }, content: [{ type: 'text', text: responseText.get(sessionID) }, { type: 'reasoning', text: privateText }] });
  const getMessage = vi.fn(async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
    if (messageID !== `message-${sessionID}`) throw new Error(privateText);
    return message(sessionID);
  });
  const list = vi.fn(async ({ sessionID }: { sessionID: string }) => ({ data: [message(sessionID)], cursor: {} }));
  const client = { session: { get: getSession, prompt, message: { get: getMessage } }, message: { list } };
  const translationFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/tags')) return Response.json({ models: [{ name: 'gemma4:e2b', digest: config.translation.digest }] });
    expect(String(url)).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'gemma4:e2b', stream: false, think: false, keep_alive: '30s', options: { temperature: 0, num_ctx: 4096, num_predict: 1024 } });
    expect(body.messages).toHaveLength(2);
    expect(init?.redirect).toBe('error');
    const source = JSON.parse(body.messages[1].content).source as string;
    expect(body.messages[0].content).toContain(source.startsWith('Do not delete')
      ? 'Translate only from English to Spanish.' : 'Translate only from Spanish to English.');
    expect(source).not.toContain('src/cli.ts');
    expect(source).not.toContain('npm test');
    const translation = source.startsWith('Do not delete') ? source.replace('Do not delete', 'No borres') : source.replace('No borres', 'Do not delete');
    return Response.json({ model: 'gemma4:e2b', done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ translation }) } });
  });
  const speechInputs: string[] = [];
  const voiceFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/transcriptions')) {
      const body = init?.body as FormData;
      expect(body.get('language')).toBe('es');
      expect(Buffer.from(await (body.get('file') as Blob).arrayBuffer())).toEqual(wav);
      return Response.json({ text: spanish });
    }
    expect(String(url)).toBe('http://127.0.0.1:8000/v1/audio/speech');
    speechInputs.push(JSON.parse(String(init?.body)).input);
    return new Response(wav);
  });
  const voice = new VoiceClient(voiceFetch);
  const dependencies: CliDependencies = {
    createStore: path => new EventStore(path),
    createTranslator: config => new OllamaTranslator(config, translationFetch),
    createVoice: () => voice, createTranscriber: () => voice,
    createResponses: () => new OpenCodeResponses({ createClient: async () => client }),
    createReply: () => new OpenCodeReply({ createClient: async () => client }),
    createMonitor: () => { throw new Error('Not used'); }, onSigint: () => () => {},
  };
  async function run(command: string, index = 0, extra: string[] = [], answers: (string | null)[] = ['', '', 'yes'], beforeAnswer?: (stage: number) => void) {
    const input = new PassThrough(); Object.assign(input, { isTTY: true });
    let stdout = ''; let stderr = ''; let stage = 0;
    const output = new Writable({ write(chunk, _encoding, callback) {
      const text = chunk.toString(); stdout += text;
      if (/Enter replacement on one line|Enter target replacement on one line|Type yes exactly:/.test(text)) {
        const current = stage++;
        setImmediate(() => { beforeAnswer?.(current); const answer = answers[current]; if (answer === null) input.end(); else input.write(`${answer ?? ''}\n`); });
      }
      callback();
    } }); Object.assign(output, { isTTY: true });
    const error = new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } });
    const outputPath = join(directory, `speech-${index}.wav`);
    const args = ['--config', configPath, '--event-id', events[index].id,
      ...(command === 'reply' ? ['--audio', audioPath] : command === 'speak-response' ? ['--message-id', `message-${events[index].sessionId}`, '--output', outputPath] : []), ...extra];
    try {
      const code = await main([command, ...args], { stdin: input, stdout: output, stderr: error }, dependencies);
      return { code, stdout, stderr, outputPath };
    } finally { input.destroy(); output.destroy(); error.destroy(); }
  }
  async function unchanged() {
    expect(snapshot(databasePath)).toEqual(before);
    expect(await readFile(audioPath)).toEqual(wav);
  }
  return { run, unchanged, events, databasePath, config, configPath, prompt, speechInputs, responseText, getSession, getMessage, list, translationFetch, voiceFetch, move: () => { moved = true; } };
}

test('whole English-project flow lists exact responses, speaks Spanish, and sends only confirmed protected English text', async () => {
  const f = await setup();
  const seededEvent = f.events[0];
  const { prompt, speechInputs } = f;
  for (let index = 0; index < 2; index++) {
    const listing = await f.run('responses', index, ['--json']);
    expect(listing.code).toBe(0);
    expect(JSON.parse(listing.stdout)).toEqual({ projectId: f.events[index].projectId, projectName: f.events[index].projectName, sessionId: f.events[index].sessionId, responses: [{ id: `message-${f.events[index].sessionId}`, completedAt: 123 }] });
    expect(listing.stdout).not.toContain(privateText);
  }
  expect(f.translationFetch).not.toHaveBeenCalled(); expect(f.voiceFetch).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
  const speech = await f.run('speak-response');
  expect(speech.code).toBe(0); expect(isWav(await readFile(speech.outputPath))).toBe(true);
  expect(await readFile(speech.outputPath)).toEqual(wav);
  expect(prompt).not.toHaveBeenCalled();
  expect(f.getMessage).toHaveBeenCalledExactlyOnceWith({ sessionID: seededEvent.sessionId, messageID: `message-${seededEvent.sessionId}` }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(await f.run('reply')).toMatchObject({ code: 0, stderr: '' });
  expect(prompt).toHaveBeenCalledExactlyOnceWith({ sessionID: seededEvent.sessionId, text: 'Do not delete `src/cli.ts`.' });
  expect(speechInputs).toContain('No borres `src/cli.ts`.');
  const store = new EventStore(f.databasePath);
  try { expect(store.get(seededEvent.id)).toEqual(seededEvent); } finally { store.close(); }
  await f.unchanged();
});

test.each([
  ['en', undefined, 'en'], ['es', undefined, 'es'], ['en', 'es', 'es'], ['es', 'en', 'en'], [undefined, 'en', 'en'], [undefined, 'es', 'es'],
] as const)('direction matrix: config %s override %s resolves %s for both workflows', async (configured, override, resolved) => {
  const f = await setup(configured);
  if (configured === undefined) { f.config.projects.forEach(project => { delete project.chatLanguage; }); await writeFile(f.configPath, JSON.stringify(f.config)); }
  const extra = override ? ['--chat-language', override] : [];
  f.responseText.set(f.events[1].sessionId, resolved === 'en' ? english : spanish);
  expect((await f.run('speak-response', 1, extra)).code).toBe(0);
  const reply = await f.run('reply', 1, extra);
  expect(reply.code).toBe(0); expect(reply.stdout).toContain(`Chat language: ${resolved}`);
  expect(f.speechInputs).toEqual([spanish]);
  expect(f.prompt).toHaveBeenCalledExactlyOnceWith({ sessionID: f.events[1].sessionId, text: resolved === 'en' ? english : spanish });
  expect(f.translationFetch).toHaveBeenCalledTimes(resolved === 'en' ? 4 : 0);
  await f.unchanged();
});

test('target edit is shown and sent byte-for-byte, with controls escaped in review', async () => {
  const f = await setup(); const final = 'Keep `src/cli.ts`.\u202e';
  const result = await f.run('reply', 0, [], ['', final, 'yes']);
  expect(result.code).toBe(0); expect(result.stdout).toContain('Keep `src/cli.ts`.\\u202e');
  expect(f.prompt).toHaveBeenCalledExactlyOnceWith({ sessionID: f.events[0].sessionId, text: final });
  expect(f.translationFetch).toHaveBeenCalledTimes(2);
  await f.unchanged();
});

test('edited Spanish source protects a command through translation and exact confirmation', async () => {
  const f = await setup();
  const result = await f.run('reply', 0, [], ['No borres `npm test -- --run tests`.', '', 'yes']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Do not delete `npm test -- --run tests`.');
  expect(f.prompt).toHaveBeenCalledExactlyOnceWith({ sessionID: f.events[0].sessionId, text: 'Do not delete `npm test -- --run tests`.' });
  expect(f.translationFetch).toHaveBeenCalledTimes(2);
  await f.unchanged();
});

test('a moved response session fails before message retrieval, translation, or synthesis', async () => {
  const f = await setup(); f.move();
  const result = await f.run('speak-response');
  expect(result.code).toBe(1); expect(result.stderr).not.toContain(privateText);
  expect(f.getMessage).not.toHaveBeenCalled(); expect(f.translationFetch).not.toHaveBeenCalled();
  expect(f.voiceFetch).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled();
  await expect(readFile(result.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.unchanged();
});

test.each([['', '', 'no'], [null], ['', null], ['', '', null], ['', '', 'YES'], ['', '', '\x03']] as (string | null)[][])('cancel/EOF/interrupt %j sends zero prompts', async (...answers) => {
  const f = await setup(); expect((await f.run('reply', 0, [], answers)).code).toBe(2);
  expect(f.prompt).not.toHaveBeenCalled(); await f.unchanged();
});

test.each(['translation', 'voice', 'response', 'missing-language', 'moved-before', 'moved-at-confirmation'] as const)('fails closed at %s without private diagnostics or sends', async stage => {
  const f = await setup();
  if (stage === 'translation') f.translationFetch.mockRejectedValueOnce(new Error(privateText));
  if (stage === 'voice') f.voiceFetch.mockRejectedValueOnce(new Error(privateText));
  if (stage === 'response') f.getMessage.mockRejectedValueOnce(new Error(privateText));
  if (stage === 'missing-language') { f.config.projects.forEach(project => { delete project.chatLanguage; }); await writeFile(f.configPath, JSON.stringify(f.config)); }
  if (stage === 'moved-before') f.move();
  const result = await f.run(stage === 'response' ? 'speak-response' : 'reply', 0, [], ['', '', 'yes'], index => { if (stage === 'moved-at-confirmation' && index === 2) f.move(); });
  expect(result.code).toBe(1); expect(result.stderr).not.toMatch(/PRIVATE_FIXTURE|Bearer|secret-token|No borres|Do not delete/);
  expect(f.prompt).not.toHaveBeenCalled();
  if (stage === 'moved-before' || stage === 'missing-language') { expect(f.voiceFetch).not.toHaveBeenCalled(); expect(f.translationFetch).not.toHaveBeenCalled(); }
  await f.unchanged();
});
