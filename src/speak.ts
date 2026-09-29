import { open, stat, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import type { CapturedEvent } from './events.js';
import type { VoiceClient } from './voice-client.js';
import { isWav } from './voice-client.js';

export async function speakEvent(event: CapturedEvent, outputPath: string, voice: Pick<VoiceClient, 'synthesize'>): Promise<void> {
  if (extname(outputPath).toLowerCase() !== '.wav') {
    throw new Error('Output path must end in .wav');
  }
  // Reject before inference when possible. The exclusive open below protects against races.
  try {
    await stat(outputPath);
    throw new Error(`Output path already exists: ${outputPath}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const messages: Record<CapturedEvent['kind'], string> = {
    'turn-ended': 'terminó su turno',
    'waiting-for-input': 'está esperando una respuesta',
    error: 'encontró un error',
  };
  const bytes = await voice.synthesize(`En el proyecto ${event.projectName}, OpenCode ${messages[event.kind]}.`);
  if (!isWav(bytes) || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Invalid WAV audio from local speech service.');

  const handle = await open(outputPath, 'wx');
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    // Only remove the path if it still points to this file; never remove a replacement.
    const created = await handle.stat().catch(() => null);
    await handle.close();
    const current = await stat(outputPath).catch(() => null);
    if (created && current && created.ino === current.ino && created.dev === current.dev) {
      await unlink(outputPath).catch(() => undefined);
    }
    throw error;
  }
  await handle.close();
}
