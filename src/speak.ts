import type { CapturedEvent } from './events.js';
import type { VoiceClient } from './voice-client.js';
import { assertNewWavPath, writeNewWav } from './wav-output.js';

export async function speakEvent(event: CapturedEvent, outputPath: string, voice: Pick<VoiceClient, 'synthesize'>): Promise<void> {
  await assertNewWavPath(outputPath);

  const messages: Record<CapturedEvent['kind'], string> = {
    'turn-ended': 'terminó su turno',
    'waiting-for-input': 'está esperando una respuesta',
    error: 'encontró un error',
  };
  const bytes = await voice.synthesize(`En el proyecto ${event.projectName}, OpenCode ${messages[event.kind]}.`);
  await writeNewWav(outputPath, bytes);
}
