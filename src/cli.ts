#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadConfig, type ProjectConfig } from './config.js';
import { EventStore } from './store.js';
import { OpenCodeMonitor } from './opencode-monitor.js';
import { selectEvent } from './event-selection.js';
import { VoiceClient } from './voice-client.js';
import { speakEvent } from './speak.js';

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface CliDependencies {
  createStore(path: string): EventStore;
  createMonitor(projects: readonly ProjectConfig[], store: EventStore): Pick<OpenCodeMonitor, 'run'>;
  createVoice(): Pick<VoiceClient, 'synthesize'>;
  onSigint(handler: () => void): () => void;
}

const usage = `Usage: project-voice-bridge <command>

Commands:
  start --config <path>
  events --config <path> [--limit <positive-integer>] [--json]
  speak --config <path> --event-id <id> --output <wav>
`;

const defaultDependencies: CliDependencies = {
  createStore: (path) => new EventStore(path),
  createMonitor: (projects, store) => new OpenCodeMonitor(projects, store),
  createVoice: () => new VoiceClient(),
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
  if (command === 'events') {
    return runEvents(args, io, dependencies);
  }
  if (command === 'speak') {
    return runSpeak(args, io, dependencies);
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
