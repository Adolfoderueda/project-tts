import type { CliDependencies, CliIo } from './cli.js';
import { loadConfig, type ChatLanguage } from './config.js';
import { resolveChatLanguage } from './chat-language.js';
import { selectEvent } from './event-selection.js';
import { OpenCodeResponses } from './opencode-responses.js';
import { OllamaTranslator, translationDiagnostic } from './translation-client.js';
import { speakResponse } from './response-speech.js';
import type { EventStore } from './store.js';
import { formatReviewText } from './voice-text.js';

const listingUsage = 'Usage: responses --config <path> --event-id <id> [--limit <1..20>] [--json]\n';
const speechUsage = 'Usage: speak-response --config <path> --event-id <id> --message-id <id> --output <wav> [--chat-language en|es]\n';

function parseFlags(args: string[], required: readonly string[], optional: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if ((!required.includes(key) && !optional.includes(key)) || values.has(key)) return null;
    if (key === '--json') { values.set(key, 'true'); continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) return null;
    values.set(key, value);
  }
  return required.every(key => values.has(key)) ? values : null;
}

export async function runResponses(args: string[], io: CliIo, deps: CliDependencies): Promise<number> {
  const flags = parseFlags(args, ['--config', '--event-id'], ['--limit', '--json']);
  const rawLimit = flags?.get('--limit') ?? '20';
  const limit = Number(rawLimit);
  if (!flags || !/^\d+$/u.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    io.stderr.write(listingUsage); return 2;
  }
  let store: EventStore | undefined;
  try {
    const config = loadConfig(flags.get('--config')!);
    store = deps.createStore(config.databasePath);
    const { event, project } = selectEvent(store, config.projects, flags.get('--event-id')!);
    const responses = deps.createResponses?.() ?? new OpenCodeResponses();
    // Select only metadata fields even when an injected adapter returns extra data.
    const summaries = (await responses.list(project, event.sessionId, limit)).map(({ id, completedAt }) => ({ id, completedAt }));
    const metadata = { projectId: project.id, projectName: project.name, sessionId: event.sessionId, responses: summaries };
    if (flags.has('--json')) {
      io.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    } else {
      io.stdout.write(`Project: ${formatReviewText(project.name)} (${formatReviewText(project.id)})\nSession: ${formatReviewText(event.sessionId)}\n`);
      if (summaries.length === 0) io.stdout.write('No eligible completed assistant responses in the recent page.\n');
      for (const summary of summaries) io.stdout.write(`${formatReviewText(summary.id)}\t${summary.completedAt}\n`);
    }
    return 0;
  } catch {
    // Transport/config/parser errors can contain text or credentials: never echo them.
    io.stderr.write('Response listing failed. Check the configuration, selected event, and OpenCode session.\n');
    return 1;
  } finally {
    try {
      store?.close();
    } catch {
      io.stderr.write('Response command cleanup failed. The event store could not be closed.\n');
      return 1;
    }
  }
}

export async function runSpeakResponse(args: string[], io: CliIo, deps: CliDependencies): Promise<number> {
  const flags = parseFlags(args, ['--config', '--event-id', '--message-id', '--output'], ['--chat-language']);
  const override = flags?.get('--chat-language');
  if (!flags || (override !== undefined && override !== 'en' && override !== 'es')) {
    io.stderr.write(speechUsage); return 2;
  }
  if ((io.stdout as NodeJS.WritableStream & { isTTY?: boolean }).isTTY !== true) {
    io.stderr.write('Response speech requires interactive terminal output for the text preview.\n'); return 1;
  }
  let store: EventStore | undefined;
  try {
    const config = loadConfig(flags.get('--config')!);
    store = deps.createStore(config.databasePath);
    const { event, project } = selectEvent(store, config.projects, flags.get('--event-id')!);
    if (!config.translation) {
      io.stderr.write('Response speech requires bilingual translation configuration.\n'); return 1;
    }
    const chatLanguage = resolveChatLanguage(project, override as ChatLanguage | undefined);
    await speakResponse({ event, project, chatLanguage, messageId: flags.get('--message-id')!, outputPath: flags.get('--output')! },
      deps.createResponses?.() ?? new OpenCodeResponses(),
      deps.createTranslator?.(config.translation) ?? new OllamaTranslator(config.translation),
      deps.createVoice(),
      preview => {
        io.stdout.write(`Project: ${formatReviewText(preview.project.name)} (${formatReviewText(preview.project.id)})\nSession: ${formatReviewText(preview.sessionId)}\nMessage: ${formatReviewText(preview.messageId)}\nOriginal (${preview.sourceLanguage}):\n${formatReviewText(preview.originalText)}\nSpanish playback text:\n${formatReviewText(preview.spanishText)}\n`);
      });
    io.stdout.write(`WAV written to ${formatReviewText(flags.get('--output')!)}; playback is manual.\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${translationDiagnostic(error) ?? 'Response speech failed. Check bilingual configuration/chat language, the selected event/message, verified session, new WAV path, and local voice/translation services.'}\n`);
    return 1;
  } finally {
    try {
      store?.close();
    } catch {
      io.stderr.write('Response command cleanup failed. The event store could not be closed.\n');
      return 1;
    }
  }
}
