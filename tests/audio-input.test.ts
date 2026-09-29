import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { validateAudioInput } from '../src/audio-input.js';

const wav = Buffer.from([...Buffer.from('RIFF'), 4, 0, 0, 0, ...Buffer.from('WAVE'), 0, 0, 0, 0]);
const m4a = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypM4A '), 0, 0, 0, 0, ...Buffer.from('M4A '), 0, 0, 0, 0]);
let dir: string | undefined;

async function fixture(name: string, data: Uint8Array): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'voice-input-'));
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('validateAudioInput', () => {
  test.each([
    ['audio.wav', wav, 'audio/wav'],
    ['audio.m4a', m4a, 'audio/mp4'],
  ])('accepts signed %s and returns its bytes', async (name, bytes, mimeType) => {
    const path = await fixture(name, bytes);
    expect(await validateAudioInput(path)).toEqual({ bytes: new Uint8Array(bytes), filename: name, mimeType });
    expect(await readFile(path)).toEqual(bytes);
  });

  test('rejects a nonexistent file', async () => {
    await expect(validateAudioInput(join(tmpdir(), 'missing-voice-recording.wav'))).rejects.toThrow();
  });

  test.each([
    ['wrong extension', 'recording.wav', m4a],
    ['unknown type', 'recording.mp3', Buffer.from('ID3\0\0\0\0\0\0\0')],
    ['truncated WAV', 'recording.wav', Buffer.from('RIFF')],
    ['empty recording', 'recording.wav', Buffer.alloc(0)],
  ])('rejects %s and preserves the recording', async (_label, name, bytes) => {
    const path = await fixture(name, bytes);
    await expect(validateAudioInput(path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(bytes);
  });

  test('rejects a recording at the 25 MiB boundary without deleting it', async () => {
    const path = await fixture('large.wav', wav);
    await truncate(path, 25 * 1024 * 1024);
    await expect(validateAudioInput(path)).rejects.toThrow(/25 MiB/);
    expect((await readFile(path)).byteLength).toBe(25 * 1024 * 1024);
  });
});
