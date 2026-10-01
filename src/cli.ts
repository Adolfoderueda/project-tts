#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadConfig, type ChatLanguage, type ProjectConfig, type TranslationConfig } from './config.js';
import { EventStore } from './store.js';
import { OpenCodeMonitor } from './opencode-monitor.js';
import { selectEvent } from './event-selection.js';
import { VoiceClient } from './voice-client.js';
import { speakEvent } from './speak.js';
import { OpenCodeReply } from './opencode-reply.js';
import { LineTerminalPrompt, replyToEvent } from './reply.js';
import { OpenCodeResponses } from './opencode-responses.js';
import { OllamaTranslator, type Translator } from './translation-client.js';
import { runResponses, runSpeakResponse } from './cli-responses.js';
import { replyBilingualToEvent } from './bilingual-reply.js';
import { resolveChatLanguage } from './chat-language.js';

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
}

export interface CliDependencies {
  createStore(path: string): EventStore;
  createMonitor(projects: readonly ProjectConfig[], store: EventStore): Pick<OpenCodeMonitor, 'run'>;
  createVoice(): Pick<VoiceClient, 'synthesize'>;
  createTranscriber?(): Pick<VoiceClient, 'transcribe'>;
  createReply?(): Pick<OpenCodeReply, 'verify' | 'send'>;
  createTranslator?(config: TranslationConfig): Translator;
  createResponses?(): Pick<OpenCodeResponses, 'list' | 'get' | 'verify'>;
  onSigint(handler: () => void): () => void;
}

const usage = `Usage: project-voice-bridge <command>

Commands:
  start --config <path>
  events --config <path> [--limit <positive-integer>] [--json]
  speak --config <path> --event-id <id> --output <wav>
  responses --config <path> --event-id <id> [--limit <1..20>] [--json]
  speak-response --config <path> --event-id <id> --message-id <id> --output <wav> [--chat-language en|es]
  reply --config <path> --event-id <id> --audio <file> [--chat-language en|es]
`;

const defaultDependencies: CliDependencies = {
  createStore: (path) => new EventStore(path),
  createMonitor: (projects, store) => new OpenCodeMonitor(projects, store),
  createVoice: () => new VoiceClient(),
  createTranscriber: () => new VoiceClient(),
  createReply: () => new OpenCodeReply(),
  createTranslator: (config) => new OllamaTranslator(config),
  createResponses: () => new OpenCodeResponses(),
  onSigint: (handler) => {
    process.on('SIGINT', handler);
    return () => {
      process.off('SIGINT', handler);
    };
  },
};

interface ParsedArgs {
  configPath: string;
  limit: number;
  json: boolean;
}

function parseEventsArgs(args: string[]): ParsedArgs | null {
  let configPath: string | undefined;
  let limit = 20;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      configPath = args[index + 1];
      index += 1;
    } else if (arg === '--limit') {
      const rawLimit = args[index + 1];
      if (rawLimit === undefined || !/^\d+$/.test(rawLimit)) {
        return null;
      }
      limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        return null;
      }
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      return null;
    }
  }

  if (configPath === undefined || configPath.length === 0 || configPath.startsWith('--')) {
    return null;
  }

  return { configPath, limit, json };
}

function parseStartArgs(args: string[]): Pick<ParsedArgs, 'configPath'> | null {
  if (args.length !== 2 || args[0] !== '--config' || args[1] === undefined || args[1].startsWith('--')) {
    return null;
  }

  return { configPath: args[1] };
}

function parseSpeakArgs(args: string[]): { configPath: string; eventId: string; outputPath: string } | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--config', '--event-id', '--output'].includes(key ?? '') || values.has(key) || !value || value.startsWith('--')) return null;
    values.set(key, value);
  }
  if (values.size !== 3) return null;
  return { configPath: values.get('--config')!, eventId: values.get('--event-id')!, outputPath: values.get('--output')! };
}

function parseReplyArgs(args: string[]): { configPath: string; eventId: string; audioPath: string; chatLanguage?: ChatLanguage } | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--config', '--event-id', '--audio', '--chat-language'].includes(key ?? '') || values.has(key) || !value || value.startsWith('--')) return null;
    values.set(key, value);
  }
  if (!values.has('--config') || !values.has('--event-id') || !values.has('--audio')) return null;
  const chatLanguage = values.get('--chat-language');
  if (chatLanguage !== undefined && chatLanguage !== 'en' && chatLanguage !== 'es') return null;
  return { configPath: values.get('--config')!, eventId: values.get('--event-id')!, audioPath: values.get('--audio')!, ...(chatLanguage === undefined ? {} : { chatLanguage }) };
}

function writeUsage(io: CliIo): void {
  io.stderr.write(usage);
}

function conciseDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function runEvents(args: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const parsed = parseEventsArgs(args);
  if (parsed === null) {
    writeUsage(io);
    return 2;
  }

  let store: EventStore | undefined;
  try {
    const config = loadConfig(parsed.configPath);
    store = dependencies.createStore(config.databasePath);
    const events = store.list(parsed.limit);

    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
    } else {
      for (const event of events) {
        io.stdout.write(`${event.occurredAt}\t${event.projectName}\t${event.id}\t${event.sessionId}\t${event.kind}\t${event.summary}\n`);
      }
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${conciseDiagnostic(error)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

function safeReplyDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    if (/^(Unknown event ID:|Configured project does not match stored event:)/.test(error.message)) return 'Selected event is missing or its configured project does not match.';
    if (error.message === 'Audio input must be a regular file.' || error.message === 'Audio input is empty. Supply a WAV or M4A recording.' || error.message === 'Audio input must be under 25 MiB.' || error.message === 'Unsupported audio format or mismatched file signature. Supply a WAV (.wav) or M4A (.m4a) recording.') return error.message;
    if (/^Local transcription service failed \(HTTP \d{3}\)\. Check the service and installed model\.$/.test(error.message)) return error.message;
    if (error.message === 'Local transcription service returned invalid JSON.' || error.message === 'Local transcription service returned invalid transcript JSON.' || error.message === 'Local transcription service returned an empty transcript.' || error.message === 'Local transcription response exceeds the 1 MiB limit.') return error.message;
    if (error.message === 'No healthy OpenCode V2 service was discovered' || /^OpenCode session (ID is missing|ID or location could not be verified|location could not be verified|location does not match the configured project)$/.test(error.message)) return 'OpenCode session could not be verified for the configured project.';
  }
  return 'Reply failed. If a send was attempted, delivery may be uncertain; inspect the OpenCode session before trying again. Check the selected event, local voice service, audio file, and OpenCode session.';
}

async function runSpeak(args: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const parsed = parseSpeakArgs(args);
  if (parsed === null) {
    writeUsage(io);
    return 2;
  }
  let store: EventStore | undefined;
  try {
    const config = loadConfig(parsed.configPath);
    store = dependencies.createStore(config.databasePath);
    const { event } = selectEvent(store, config.projects, parsed.eventId);
    await speakEvent(event, parsed.outputPath, dependencies.createVoice());
    io.stdout.write(`WAV written to ${parsed.outputPath}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${conciseDiagnostic(error)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

async function runReply(args: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const parsed = parseReplyArgs(args);
  if (parsed === null) {
    writeUsage(io);
    return 2;
  }
  const input = io.stdin ?? process.stdin;
  if ((input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY !== true ||
    (io.stdout as NodeJS.WritableStream & { isTTY?: boolean }).isTTY !== true) {
    io.stderr.write('Reply requires an interactive terminal for input and output; piped input cannot confirm a send.\n');
    return 1;
  }
  let store: EventStore | undefined;
  let prompt: LineTerminalPrompt | undefined;
  let bilingual = false;
  try {
    const config = loadConfig(parsed.configPath);
    bilingual = config.translation !== undefined;
    if (!bilingual && parsed.chatLanguage !== undefined) {
      io.stderr.write('--chat-language requires bilingual translation configuration.\n');
      return 2;
    }
    store = dependencies.createStore(config.databasePath);
    const { event, project } = selectEvent(store, config.projects, parsed.eventId);
    const chatLanguage = bilingual ? resolveChatLanguage(project, parsed.chatLanguage) : undefined;
    const voice = dependencies.createTranscriber?.() ?? new VoiceClient();
    const opencode = dependencies.createReply?.() ?? new OpenCodeReply();
    prompt = new LineTerminalPrompt(input, io.stdout, event, { bilingual });
    const result = config.translation
      ? await replyBilingualToEvent(event, project, parsed.audioPath, chatLanguage!, voice,
        dependencies.createTranslator?.(config.translation) ?? new OllamaTranslator(config.translation), opencode, prompt)
      : await replyToEvent(event, project, parsed.audioPath, voice, opencode, prompt);
    if (result === 'cancelled') {
      io.stdout.write('Reply cancelled; nothing sent.\n');
      return 2;
    }
    io.stdout.write('Reply submitted to verified session.\n');
    return 0;
  } catch (error) {
    // Do not echo transport exceptions: they may include authentication headers or transcripts.
    const diagnostic = bilingual && error instanceof Error && error.message === 'Chat language is required: set project chatLanguage or supply --chat-language en|es.'
      ? error.message : safeReplyDiagnostic(error);
    io.stderr.write(`${diagnostic}\n`);
    return 1;
  } finally {
    if (bilingual) {
      let cleanupFailed = false;
      try { prompt?.close(); } catch { cleanupFailed = true; }
      try { store?.close(); } catch { cleanupFailed = true; }
      if (cleanupFailed) {
        io.stderr.write('Reply cleanup failed. If a send was attempted, delivery may be uncertain; inspect the OpenCode session before trying again.\n');
        return 1;
      }
    } else {
      prompt?.close();
      store?.close();
    }
  }
}

async function runStart(args: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  const parsed = parseStartArgs(args);
  if (parsed === null) {
    writeUsage(io);
    return 2;
  }

  let store: EventStore | undefined;
  let unsubscribeSigint: (() => void) | undefined;
  const abortController = new AbortController();
  let runPromise: Promise<void> | undefined;

  try {
    const config = loadConfig(parsed.configPath);
    store = dependencies.createStore(config.databasePath);
    const sharedStore = store;
    const monitor = dependencies.createMonitor(config.projects, sharedStore);
    unsubscribeSigint = dependencies.onSigint(() => {
      abortController.abort();
    });
    runPromise = monitor.run(abortController.signal);
    await runPromise;
    return 0;
  } catch (error) {
    abortController.abort();
    if (runPromise !== undefined) {
      await Promise.allSettled([runPromise]);
    }
    io.stderr.write(`${conciseDiagnostic(error)}\n`);
    return 1;
  } finally {
    unsubscribeSigint?.();
    store?.close();
  }
}

export async function main(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  if (argv.length === 0) {
    writeUsage(io);
    return 2;
  }

  const [command, ...args] = argv;
  if (command === 'responses') return runResponses(args, io, dependencies);
  if (command === 'speak-response') return runSpeakResponse(args, io, dependencies);
  if (command === 'events') {
    return runEvents(args, io, dependencies);
  }
  if (command === 'speak') {
    return runSpeak(args, io, dependencies);
  }
  if (command === 'reply') {
    return runReply(args, io, dependencies);
  }
  if (command === 'start') {
    return runStart(args, io, dependencies);
  }

  writeUsage(io);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
