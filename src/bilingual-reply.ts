import type { ChatLanguage, ProjectConfig } from './config.js';
import type { CapturedEvent } from './events.js';
import type { VoiceClient } from './voice-client.js';
import type { Translator } from './translation-client.js';
import type { OpenCodeReply, VerifiedDestination } from './opencode-reply.js';
import { assertVoiceText } from './voice-text.js';

export type BilingualReview = { spanishText: string; targetText: string; chatLanguage: ChatLanguage };
export type BilingualTerminalPrompt = {
  edit(initial: string): Promise<string | null>;
  editTarget(review: BilingualReview): Promise<string | null>;
  confirmBilingual(destination: VerifiedDestination, review: BilingualReview): Promise<boolean>;
};

export async function replyBilingualToEvent(
  event: CapturedEvent,
  project: ProjectConfig,
  audioPath: string,
  chatLanguage: ChatLanguage,
  voice: Pick<VoiceClient, 'transcribe'>,
  translator: Translator,
  opencode: Pick<OpenCodeReply, 'verify' | 'send'>,
  prompt: BilingualTerminalPrompt,
): Promise<'sent' | 'cancelled'> {
  const destination = await opencode.verify(project, event.sessionId);
  const transcript = await voice.transcribe(audioPath);
  if (!transcript.trim()) return 'cancelled';
  const spanishText = await prompt.edit(transcript);
  if (spanishText === null || !spanishText.trim()) return 'cancelled';
  assertVoiceText(spanishText);
  const translated = chatLanguage === 'es' ? spanishText : await translator.translate(spanishText, 'es', 'en');
  assertVoiceText(translated);
  const targetText = await prompt.editTarget({ spanishText, targetText: translated, chatLanguage });
  if (targetText === null || !targetText.trim()) return 'cancelled';
  assertVoiceText(targetText);
  // Keep the approved bytes in a local immutable string, independent of the review object.
  if (!await prompt.confirmBilingual(destination, { spanishText, targetText, chatLanguage })) return 'cancelled';
  await opencode.send(destination, targetText);
  return 'sent';
}
