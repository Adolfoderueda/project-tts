import { expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNewWavPath, writeNewWav } from '../src/wav-output.js';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const wav = Buffer.from('RIFF0000WAVE');
test('rejects existing files, directories, non-WAV paths and dangling symlinks', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wav-'));
  const path = join(dir, 'original.wav');
  await fs.writeFile(path, 'original');
  await expect(assertNewWavPath(path)).rejects.toThrow();
  expect(await fs.readFile(path, 'utf8')).toBe('original');
  const directory = join(dir, 'directory.wav'); await fs.mkdir(directory);
  await expect(assertNewWavPath(directory)).rejects.toThrow();
  await expect(assertNewWavPath(join(dir, 'new.mp3'))).rejects.toThrow();
  vi.mocked(fs.lstat).mockResolvedValueOnce({ isSymbolicLink: () => true } as Awaited<ReturnType<typeof fs.lstat>>);
  await expect(assertNewWavPath(join(dir, 'dangling.wav'))).rejects.toThrow();
});
test('exclusive writer validates size/signature and never overwrites a racing file', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wav-')); const path = join(dir, 'new.wav');
  await assertNewWavPath(path);
  await expect(writeNewWav(path, Buffer.from('bad'))).rejects.toThrow();
  const oversized = Buffer.alloc(20 * 1024 * 1024 + 1); wav.copy(oversized);
  await expect(writeNewWav(path, oversized)).rejects.toThrow();
  await expect(fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.writeFile(path, 'racing');
  await expect(writeNewWav(path, wav)).rejects.toThrow();
  expect(await fs.readFile(path, 'utf8')).toBe('racing');
});
test('partial write failure cleans up the exclusively created output', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'wav-')); const path = join(dir, 'new.wav');
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    handle.writeFile = async () => { await handle.write('partial'); throw new Error('disk full'); };
    return handle;
  });
  await expect(writeNewWav(path, wav)).rejects.toThrow('disk full');
  await expect(fs.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
