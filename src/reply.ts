import { createInterface, type Interface } from 'node:readline';
import type { ProjectConfig } from './config.js';
import type { CapturedEvent } from './events.js';
import type { VoiceClient } from './voice-client.js';
import type { OpenCodeReply, VerifiedDestination } from './opencode-reply.js';
import type { BilingualReview, BilingualTerminalPrompt } from './bilingual-reply.js';
import { formatReviewText } from './voice-text.js';

export interface TerminalPrompt {
  edit(initial: string): Promise<string | null>;
  confirm(destination: VerifiedDestination, text: string): Promise<boolean>;
}

export async function replyToEvent(
  event: CapturedEvent,
  project: ProjectConfig,
  audioPath: string,
  voice: Pick<VoiceClient, 'transcribe'>,
  opencode: Pick<OpenCodeReply, 'verify' | 'send'>,
  prompt: TerminalPrompt,
): Promise<'sent' | 'cancelled'> {
  // The destination must be verified before the user can approve a send.
  const destination = await opencode.verify(project, event.sessionId);
  const transcript = await voice.transcribe(audioPath);
  if (!transcript.trim()) return 'cancelled';
  const edited = await prompt.edit(transcript);
  if (edited === null || !edited.trim()) return 'cancelled';
  if (!await prompt.confirm(destination, edited)) return 'cancelled';
  await opencode.send(destination, edited);
  return 'sent';
}

/** One line replaces the transcript; an empty line keeps it unchanged. */
export class LineTerminalPrompt implements TerminalPrompt, BilingualTerminalPrompt {
  readonly #readline: Interface;
  readonly #output: NodeJS.WritableStream;
  readonly #input: NodeJS.ReadableStream;
  readonly #interactive: boolean;
  readonly #onData: (chunk: unknown) => void;
  readonly #lines: string[] = [];
  #pending: ((value: string | null) => void) | undefined;
  #closed = false;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, private readonly event: CapturedEvent, private readonly options: { bilingual?: boolean } = {}) {
    this.#input = input;
    this.#interactive = (input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY === true;
    this.#output = output;
    // Observe interrupts before readline can interpret a line in the same chunk.
    this.#onData = chunk => { if (String(chunk).includes('\x03')) this.close(); };
    input.on('data', this.#onData);
    this.#readline = createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) });
    this.#readline.on('line', line => {
      if (this.#closed) return;
      if (this.#pending) {
        const pending = this.#pending;
        this.#pending = undefined;
        pending(line);
      } else {
        this.#lines.push(line);
      }
    });
    this.#readline.on('SIGINT', () => this.close());
    this.#readline.on('close', () => {
      this.#closed = true;
      this.#input.off('data', this.#onData);
      this.#lines.length = 0;
      this.#pending?.(null);
      this.#pending = undefined;
    });
  }

  async edit(initial: string): Promise<string | null> {
    // Discard pre-typed answers: review must precede every response.
    this.#lines.length = 0;
    this.#output.write(this.options.bilingual
      ? `Spanish source:\n${formatReviewText(initial)}\nEnter replacement on one line (Enter keeps transcript; Ctrl+C/EOF cancels): `
      : `Transcript:\n${initial}\nEnter replacement on one line (Enter keeps transcript; Ctrl+C/EOF cancels): `);
    const line = await this.#readLine();
    return line === null ? null : line === '' ? initial : line;
  }

  async confirm(destination: VerifiedDestination, text: string): Promise<boolean> {
    this.#lines.length = 0;
    this.#output.write(`\nVerified destination:\nProject: ${destination.project.name} (${destination.project.id})\nSession: ${destination.sessionId}\nEvent: ${this.event.id} (${this.event.kind}) — ${this.event.summary}\nFinal text:\n${text}\nSend to this session? Type yes exactly: `);
    return this.#checkAnswer();
  }

  async editTarget(review: BilingualReview): Promise<string | null> {
    this.#lines.length = 0;
    this.#output.write(`\n${this.#formatReview(review)}\n${review.chatLanguage === 'es' ? 'Same-language final-text review.\n' : ''}Enter target replacement on one line (Enter keeps complete target; Ctrl+C/EOF cancels): `);
    const line = await this.#readLine();
    return line === null ? null : line === '' ? review.targetText : line;
  }

  async confirmBilingual(destination: VerifiedDestination, review: BilingualReview): Promise<boolean> {
    this.#lines.length = 0;
    const safe = formatReviewText;
    this.#output.write(`\nVerified destination:\nProject: ${safe(destination.project.name)} (${safe(destination.project.id)})\nSession: ${safe(destination.sessionId)}\nEvent: ${safe(this.event.id)} (${safe(this.event.kind)}) — ${safe(this.event.summary)}\nChat language: ${safe(review.chatLanguage)}\n${this.#formatReview(review)}\nSend to this session? Type yes exactly: `);
    return this.#checkAnswer();
  }

  #formatReview(review: BilingualReview): string {
    return `Spanish source:\n${formatReviewText(review.spanishText)}\nTarget text (${formatReviewText(review.chatLanguage)}):\n${formatReviewText(review.targetText)}`;
  }

  async #checkAnswer(): Promise<boolean> {
    if (!this.#interactive) return false;
    const answer = await this.#readLine();
    // readline may deliver an unterminated last line during EOF, or a line
    // followed immediately by EOF/Ctrl+C. Let stream closure win over yes.
    await new Promise<void>(resolve => setImmediate(resolve));
    return !this.#closed && answer === 'yes';
  }

  close(): void {
    this.#readline.close();
  }

  #readLine(): Promise<string | null> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#lines.length) return Promise.resolve(this.#lines.shift()!);
    return new Promise(resolve => { this.#pending = resolve; });
  }
}
