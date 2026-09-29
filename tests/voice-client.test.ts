import { describe, expect, test, vi } from 'vitest';
import { VoiceClient } from '../src/voice-client.js';

const wav = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE'), 0]);

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
