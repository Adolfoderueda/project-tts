import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speakEvent } from '../src/speak.js';
import type { CapturedEvent } from '../src/events.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const wav = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE'), 0]);
const event: CapturedEvent = { id: 'one', projectId: 'alpha', projectName: 'Proyecto Ñandú', sessionId: 'session', kind: 'turn-ended', occurredAt: '2026-01-01T00:00:00Z', summary: 'untrusted', rawEventType: 'session.idle' };

describe('speakEvent', () => {
  test.each([
    ['turn-ended', /terminó (su )?turno/i],
    ['waiting-for-input', /esperando|necesita/i],
    ['error', /error/i],
  ] as const)('speaks conservative Spanish status for %s', async (kind, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'speak-'));
    const synthesize = vi.fn(async (_text: string) => wav);
    const path = join(directory, 'status.wav');
    await speakEvent({ ...event, kind }, path, { synthesize });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize.mock.calls[0]?.[0]).toContain('Proyecto Ñandú');
    expect(synthesize.mock.calls[0]?.[0]).toMatch(expected);
    expect(synthesize.mock.calls[0]?.[0]).not.toContain('untrusted');
    expect(synthesize.mock.calls[0]?.[0]).not.toMatch(/proyecto (está )?completado/i);
    expect(await readFile(path)).toEqual(Buffer.from(wav));
  });

  test('rejects existing path without synthesizing or overwriting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speak-'));
    const path = join(directory, 'status.wav');
    await writeFile(path, 'original');
    const synthesize = vi.fn(async () => wav);
    await expect(speakEvent(event, path, { synthesize })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('original');
    expect(synthesize).not.toHaveBeenCalled();
  });

  test('rejects non-WAV extension before synthesis', async () => {
    const synthesize = vi.fn(async () => wav);
    await expect(speakEvent(event, 'status.mp3', { synthesize })).rejects.toThrow(/\.wav/i);
    expect(synthesize).not.toHaveBeenCalled();
  });

  test('rejects invalid synthesized bytes and leaves no output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speak-'));
    const path = join(directory, 'status.wav');
    await expect(speakEvent(event, path, { synthesize: async () => Uint8Array.of(0, 1) })).rejects.toThrow(/WAV/i);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not create output when synthesis fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speak-'));
    const path = join(directory, 'status.wav');
    await expect(speakEvent(event, path, { synthesize: async () => { throw new Error('service unavailable'); } })).rejects.toThrow('service unavailable');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('removes only the newly created file on write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speak-'));
    const path = join(directory, 'status.wav');
    const originalOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    const spy = vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      handle.writeFile = async () => { await originalOpen(path, 'r+').then(async (partial) => { await partial.writeFile('partial'); await partial.close(); }); throw new Error('disk full'); };
      return handle;
    });
    try {
      await expect(speakEvent(event, path, { synthesize: async () => wav })).rejects.toThrow('disk full');
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      spy.mockRestore();
    }
  });
});
