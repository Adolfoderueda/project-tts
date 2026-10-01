export const MAX_VOICE_TEXT_CODE_POINTS = 2000;

export function assertVoiceText(text: string): void {
  if (text.trim().length === 0) {
    throw new Error('Voice text must not be empty or whitespace-only.');
  }
  if ([...text].length > MAX_VOICE_TEXT_CODE_POINTS) {
    throw new Error(`Voice text must not exceed ${MAX_VOICE_TEXT_CODE_POINTS} Unicode code points.`);
  }
}

export function formatReviewText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, (control) =>
    `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
