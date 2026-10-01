import type { ChatLanguage, ProjectConfig } from './config.js';
import type { CapturedEvent } from './events.js';
import type { OpenCodeResponses } from './opencode-responses.js';
import type { Translator } from './translation-client.js';
import type { VoiceClient } from './voice-client.js';
import { assertVoiceText } from './voice-text.js';
import { assertNewWavPath, writeNewWav } from './wav-output.js';

export type ResponseSpeechInput = {
  event: CapturedEvent;
  project: ProjectConfig;
  messageId: string;
  outputPath: string;
  chatLanguage: ChatLanguage;
};
export type ResponsePreview = {
  project: ProjectConfig;
  sessionId: string;
  messageId: string;
  sourceLanguage: ChatLanguage;
  originalText: string;
  spanishText: string;
};

export async function speakResponse(
  input: ResponseSpeechInput,
  responses: Pick<OpenCodeResponses, 'get' | 'verify'>,
  translator: Translator,
  voice: Pick<VoiceClient, 'synthesize'>,
  preview: (value: ResponsePreview) => void,
): Promise<void> {
  await assertNewWavPath(input.outputPath);
  const { text } = await responses.get(input.project, input.event.sessionId, input.messageId);
  assertVoiceText(text);
  const spanishText = input.chatLanguage === 'es' ? text : await translator.translate(text, 'en', 'es');
  assertVoiceText(spanishText);
  preview({ project: input.project, sessionId: input.event.sessionId, messageId: input.messageId, sourceLanguage: input.chatLanguage, originalText: text, spanishText });
  await responses.verify(input.project, input.event.sessionId);
  const bytes = await voice.synthesize(spanishText);
  await writeNewWav(input.outputPath, bytes);
}
