import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function validateAudioInput(path: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Audio input must be a regular file.');
    if (stat.size === 0) throw new Error('Audio input is empty. Supply a WAV or M4A recording.');
    if (stat.size >= MAX_AUDIO_BYTES) throw new Error('Audio input must be under 25 MiB.');

    // Read at most the limit, even if the file grows after stat(). Never write to the recording.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: 64 * 1024 })) {
      size += chunk.length;
      if (size >= MAX_AUDIO_BYTES) throw new Error('Audio input must be under 25 MiB.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    if (size === 0) throw new Error('Audio input is empty. Supply a WAV or M4A recording.');
    const extension = extname(path).toLowerCase();
    const wav = size >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
    const boxSize = size >= 12 ? bytes.readUInt32BE(0) : 0;
    const m4a = size >= 16 && boxSize >= 16 && boxSize <= size && bytes.toString('ascii', 4, 8) === 'ftyp' &&
      ['M4A ', 'M4B ', 'isom', 'iso2', 'mp42'].includes(bytes.toString('ascii', 8, 12));
    if (extension !== '.wav' && extension !== '.m4a' || extension === '.wav' && !wav || extension === '.m4a' && !m4a) {
      throw new Error('Unsupported audio format or mismatched file signature. Supply a WAV (.wav) or M4A (.m4a) recording.');
    }
    return { bytes: new Uint8Array(bytes), filename: basename(path), mimeType: wav ? 'audio/wav' : 'audio/mp4' };
  } finally {
    await handle.close();
  }
}
