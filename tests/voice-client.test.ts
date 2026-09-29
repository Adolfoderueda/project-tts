import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { VoiceClient } from '../src/voice-client.js';

const wav = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE'), 0]);
let dir: string | undefined;
async function recording(bytes: Uint8Array = wav): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'voice-client-'));
  const path = join(dir, 'recording.wav');
  await writeFile(path, bytes);
  return path;
}
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('VoiceClient.synthesize', () => {
  test('posts local Kokoro WAV speech with timeout', async () => {
    const fetch = vi.fn(async () => new Response(wav, { status: 200 }));
    const result = await new VoiceClient(fetch).synthesize('Hola, proyecto.');
    expect(result).toEqual(wav);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/audio/speech');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'ef_dora', input: 'Hola, proyecto.', response_format: 'wav' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('rejects unavailable and failed local service', async () => {
    await expect(new VoiceClient(vi.fn(async () => { throw new Error('offline'); })).synthesize('hola')).rejects.toThrow('offline');
    await expect(new VoiceClient(vi.fn(async () => new Response('failed', { status: 503 }))).synthesize('hola')).rejects.toThrow(/503/);
  });

  test.each([
    ['invalid header', Uint8Array.from([1, 2, 3])],
    ['oversized response', new Uint8Array(20 * 1024 * 1024 + 1)],
  ])('rejects %s', async (_name, bytes) => {
    await expect(new VoiceClient(vi.fn(async () => new Response(bytes))).synthesize('hola')).rejects.toThrow();
  });

  test('rejects malformed response stream', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken stream')); } }));
    await expect(new VoiceClient(vi.fn(async () => response)).synthesize('hola')).rejects.toThrow('broken stream');
  });
});

describe('VoiceClient.transcribe', () => {
  test('sends Spanish audio only to loopback with multilingual model and returns trimmed transcript', async () => {
    const path = await recording();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: '  Hola, mundo.  ' })));
    expect(await new VoiceClient(fetch).transcribe(path)).toBe('Hola, mundo.');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get('model')).toBe('Systran/faster-whisper-small');
    expect(body.get('language')).toBe('es');
    const file = body.get('file') as File;
    expect(file.name).toBe('recording.wav');
    expect(file.type).toBe('audio/wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav);
    expect(await readFile(path)).toEqual(Buffer.from(wav));
  });

  test('does not send invalid recordings and preserves them', async () => {
    const path = await recording(Buffer.from('not audio'));
    const fetch = vi.fn(async () => new Response('{}'));
    await expect(new VoiceClient(fetch).transcribe(path)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(Buffer.from('not audio'));
  });

  test.each([
    ['empty transcript', JSON.stringify({ text: ' \n ' }), 200, /empty/i],
    ['missing text', JSON.stringify({ other: 'x' }), 200, /invalid/i],
    ['malformed JSON', '{', 200, /invalid/i],
    ['service failure', 'unavailable', 503, /503/],
  ])('rejects %s', async (_label, result, status, message) => {
    const path = await recording();
    await expect(new VoiceClient(vi.fn(async () => new Response(result, { status }))).transcribe(path)).rejects.toThrow(message);
    expect(await readFile(path)).toEqual(Buffer.from(wav));
  });

  test('rejects oversized transcription response', async () => {
    const path = await recording();
    await expect(new VoiceClient(vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1)))).transcribe(path)).rejects.toThrow(/limit/i);
  });
});
