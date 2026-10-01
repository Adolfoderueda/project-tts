import { lstat, open, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { isWav } from './voice-client.js';

export async function assertNewWavPath(path: string): Promise<void> {
  if (extname(path).toLowerCase() !== '.wav') throw new Error('Output path must end in .wav');
  try {
    // A dangling symlink is an existing path too.
    await lstat(path);
    throw new Error(`Output path already exists: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export async function writeNewWav(path: string, bytes: Uint8Array): Promise<void> {
  if (!isWav(bytes) || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Invalid WAV audio from local speech service.');
  const handle = await open(path, 'wx');
  let created: Awaited<ReturnType<typeof handle.stat>> | undefined;
  try {
    created = await handle.stat();
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    // Best effort only: inode comparison avoids known replacements, but the
    // lstat/unlink pair cannot protect against a replacement between those calls.
    created ??= await handle.stat().catch(() => undefined);
    await handle.close().catch(() => undefined);
    const current = await lstat(path).catch(() => null);
    if (created && current && created.ino === current.ino && created.dev === current.dev) {
      await unlink(path).catch(() => undefined);
    }
    throw error;
  }
}
