const SPEECH_URL = 'http://127.0.0.1:8000/v1/audio/speech';
const MAX_WAV_BYTES = 20 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 120_000;

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WAVE';
}

export class VoiceClient {
  constructor(private readonly fetchClient: typeof fetch = fetch) {}

  async synthesize(text: string): Promise<Uint8Array> {
    const response = await this.fetchClient(SPEECH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'ef_dora', input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Local speech service failed (HTTP ${response.status}). Check the service and installed model.`);
    }
    if (response.body === null) {
      throw new Error('Local speech service returned no WAV audio.');
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_WAV_BYTES) {
          await reader.cancel();
          throw new Error('Local speech WAV response exceeds the 20 MiB limit.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!isWav(bytes)) throw new Error('Local speech service returned invalid WAV audio.');
    return bytes;
  }
}
