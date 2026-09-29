import { describe, expect, test } from 'vitest';
import { Writable, PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliDependencies } from '../src/cli.js';
import { EventStore } from '../src/store.js';
import type { CapturedEvent } from '../src/events.js';
import type { ProjectConfig } from '../src/config.js';

const alphaDirectory = join(tmpdir(), 'project-voice-bridge-projects', 'alpha');
const bravoDirectory = join(tmpdir(), 'project-voice-bridge-projects', 'bravo');

function captureWritable() {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    output: () => output,
  };
}

describe('cli', () => {
  test('reply sends only after explicit yes, closes store and reports cancellation separately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const db = join(directory, 'events.sqlite');
    const config = await writeConfig(directory, db);
    seedEvents(db, 1);
    let closes = 0;
    const sends: string[] = [];
    const stdout = captureWritable();
    const stderr = captureWritable();
    const input = new PassThrough();
    const dependencies: CliDependencies = {
      createStore: path => {
        const store = new EventStore(path);
        return { get: store.get.bind(store), close: () => { closes++; store.close(); } } as EventStore;
      },
      createVoice: () => ({ synthesize: async () => new Uint8Array() }),
      createTranscriber: () => ({ transcribe: async () => 'original' }),
      createReply: () => ({ verify: async project => ({ project, sessionId: 'session-0' }), send: async (_destination, text) => { sends.push(text); } }),
      createMonitor: () => { throw new Error('not used'); },
      onSigint: () => () => undefined,
    };
    const run = main(['reply', '--config', config, '--event-id', 'event-0', '--audio', 'recording.wav'],
      { stdout: stdout.stream, stderr: stderr.stream, stdin: input }, dependencies);
    await waitForOutput(stdout, 'Enter replacement');
    input.write('final edit\n');
    await waitForOutput(stdout, 'Type yes exactly');
    input.write('yes\n');
    expect(await run).toBe(0);
    expect(sends).toEqual(['final edit']);
    expect(stdout.output()).toContain('session-0');
    expect(stdout.output()).toContain('final edit');
    expect(closes).toBe(1);
    expect(stderr.output()).toBe('');

    const cancelledInput = new PassThrough();
    const cancelled = main(['reply', '--config', config, '--event-id', 'event-0', '--audio', 'recording.wav'],
      { stdout: captureWritable().stream, stderr: stderr.stream, stdin: cancelledInput }, dependencies);
    cancelledInput.end();
    expect(await cancelled).toBe(2);
    expect(sends).toHaveLength(1);
    expect(closes).toBe(2);
  });

  test('reply fails closed for unknown event, bad session and send failure without exposing raw errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const db = join(directory, 'events.sqlite');
    const config = await writeConfig(directory, db);
    seedEvents(db, 1);
    let closes = 0;
    let transcriptions = 0;
    let sends = 0;
    let failVerify = false;
    const stderr = captureWritable();
    const dependencies: CliDependencies = {
      createStore: path => { const store = new EventStore(path); return { get: store.get.bind(store), close: () => { closes++; store.close(); } } as EventStore; },
      createVoice: () => ({ synthesize: async () => new Uint8Array() }),
      createTranscriber: () => ({ transcribe: async () => { transcriptions++; return 'texto'; } }),
      createReply: () => ({ verify: async project => { if (failVerify) throw new Error('Bearer secret-token'); return { project, sessionId: 'session-0' }; }, send: async () => { sends++; throw new Error('Bearer secret-token'); } }),
      createMonitor: () => { throw new Error('not used'); }, onSigint: () => () => undefined,
    };
    const io = { stdout: captureWritable().stream, stderr: stderr.stream, stdin: new PassThrough() };
    expect(await main(['reply', '--config', config, '--event-id', 'unknown', '--audio', 'recording.wav'], io, dependencies)).toBe(1);
    expect(transcriptions).toBe(0);
    failVerify = true;
    expect(await main(['reply', '--config', config, '--event-id', 'event-0', '--audio', 'recording.wav'], io, dependencies)).toBe(1);
    expect(sends).toBe(0);
    failVerify = false;
    const input = new PassThrough();
    const output = captureWritable();
    const failure = main(['reply', '--config', config, '--event-id', 'event-0', '--audio', 'recording.wav'], { ...io, stdout: output.stream, stdin: input }, dependencies);
    await waitForOutput(output, 'Enter replacement');
    input.write('\n');
    await waitForOutput(output, 'Type yes exactly');
    input.write('yes\n');
    expect(await failure).toBe(1);
    expect(sends).toBe(1);
    expect(closes).toBe(3);
    expect(stderr.output()).toContain('delivery may be uncertain');
    expect(stderr.output()).not.toContain('secret-token');
  });

  test('reply reports local transcription failure without prompting or sending and closes store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const db = join(directory, 'events.sqlite');
    const config = await writeConfig(directory, db);
    seedEvents(db, 1);
    let closes = 0;
    let sends = 0;
    const stderr = captureWritable();
    const output = captureWritable();
    const code = await main(['reply', '--config', config, '--event-id', 'event-0', '--audio', 'missing.wav'],
      { stdout: output.stream, stderr: stderr.stream, stdin: new PassThrough() }, {
        createStore: path => { const store = new EventStore(path); return { get: store.get.bind(store), close: () => { closes++; store.close(); } } as EventStore; },
        createVoice: () => ({ synthesize: async () => new Uint8Array() }),
        createTranscriber: () => ({ transcribe: async () => { throw new Error('Local transcription service returned an empty transcript.'); } }),
        createReply: () => ({ verify: async project => ({ project, sessionId: 'session-0' }), send: async () => { sends++; } }),
        createMonitor: () => { throw new Error('not used'); }, onSigint: () => () => undefined,
      });
    expect(code).toBe(1);
    expect(closes).toBe(1);
    expect(sends).toBe(0);
    expect(output.output()).not.toContain('Type yes exactly');
    expect(stderr.output()).toContain('empty transcript');
  });

  test.each([{ args: ['--yes'] }, { args: ['--audio', ''] }, { args: ['--config', 'x', '--event-id', 'id'] }])('reply rejects invalid args $args', async ({ args }) => {
    const stderr = captureWritable();
    expect(await main(['reply', ...args], { stdout: captureWritable().stream, stderr: stderr.stream })).toBe(2);
    expect(stderr.output()).toContain('Usage:');
  });
  test('speak selects exact event and project, writes WAV, and closes store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const db = join(directory, 'events.sqlite');
    const config = await writeConfig(directory, db);
    seedEvents(db, 2);
    const output = join(directory, 'spoken.wav');
    const stdout = captureWritable();
    const stderr = captureWritable();
    const spoken: string[] = [];
    let closes = 0;
    const wav = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE'), 0]);
    const exitCode = await main(['speak', '--config', config, '--event-id', 'event-0', '--output', output],
      { stdout: stdout.stream, stderr: stderr.stream }, {
        createStore: (path) => {
          const store = new EventStore(path);
          return { get: store.get.bind(store), close: () => { closes++; store.close(); } } as EventStore;
        },
        createVoice: () => ({ synthesize: async (text: string) => { spoken.push(text); return wav; } }),
        createMonitor: () => { throw new Error('not used'); },
        onSigint: () => () => undefined,
      });
    expect(exitCode).toBe(0);
    expect(closes).toBe(1);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('Demo Project');
    expect(stdout.output()).toContain(output);
    expect(stderr.output()).toBe('');
    expect(await readFile(output)).toEqual(Buffer.from(wav));
  });

  test.each(['missing', 'wrong-project'])('speak fails closed for %s and closes store', async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const db = join(directory, 'events.sqlite');
    const config = await writeConfig(directory, db);
    seedEvents(db, 1);
    let closes = 0;
    let calls = 0;
    const stderr = captureWritable();
    const code = await main(['speak', '--config', config, '--event-id', scenario === 'missing' ? 'unknown' : 'event-0', '--output', join(directory, 'out.wav')],
      { stdout: captureWritable().stream, stderr: stderr.stream }, {
        createStore: (path) => {
          const store = new EventStore(path);
          return { get: (id: string) => scenario === 'wrong-project' ? { ...store.get(id)!, projectId: 'other' } : store.get(id), close: () => { closes++; store.close(); } } as EventStore;
        },
        createVoice: () => ({ synthesize: async () => { calls++; return new Uint8Array(); } }),
        createMonitor: () => { throw new Error('not used'); },
        onSigint: () => () => undefined,
      });
    expect(code).toBe(1);
    expect(closes).toBe(1);
    expect(calls).toBe(0);
    expect(stderr.output()).toMatch(/event|project/i);
  });

  test('speak rejects incomplete arguments with usage', async () => {
    const stderr = captureWritable();
    expect(await main(['speak', '--event-id', 'id'], { stdout: captureWritable().stream, stderr: stderr.stream })).toBe(2);
    expect(stderr.output()).toContain('Usage:');
  });

  test('main_returns_usage_for_missing_command', async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await main([], { stdout: stdout.stream, stderr: stderr.stream });

    expect(exitCode).toBe(2);
    expect(stderr.output()).toContain('Usage:');
    expect(stdout.output()).toBe('');
  });

  test('events_prints_latest_events_as_json_with_default_limit_20', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const databasePath = join(directory, 'events.sqlite');
    const configPath = await writeConfig(directory, databasePath);
    seedEvents(databasePath, 25);
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await main(['events', '--config', configPath, '--json'], { stdout: stdout.stream, stderr: stderr.stream });

    expect(exitCode).toBe(0);
    expect(stderr.output()).toBe('');
    const events = JSON.parse(stdout.output()) as CapturedEvent[];
    expect(events).toHaveLength(20);
    expect(events[0]?.sessionId).toBe('session-24');
    expect(events.at(-1)?.sessionId).toBe('session-5');
  });

  test('events_prints_human_readable_rows_with_selected_fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const databasePath = join(directory, 'events.sqlite');
    const configPath = await writeConfig(directory, databasePath);
    seedEvents(databasePath, 1);
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await main(['events', '--config', configPath, '--limit', '1'], { stdout: stdout.stream, stderr: stderr.stream });

    expect(exitCode).toBe(0);
    expect(stderr.output()).toBe('');
    expect(stdout.output()).toContain('2026-01-01T00:00:00.000Z');
    expect(stdout.output()).toContain('Demo Project');
    expect(stdout.output()).toContain('session-0');
    expect(stdout.output()).toMatch(/event-0\t.*session-0/);
    expect(stdout.output()).toContain('turn-ended');
    expect(stdout.output()).toContain('OpenCode turn finished 0');
  });

  test.each(['0', '1.5', 'nope'])('events_rejects_non_positive_integer_limit_%s', async (limit) => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const configPath = await writeConfig(directory, join(directory, 'events.sqlite'));
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await main(['events', '--config', configPath, '--limit', limit], { stdout: stdout.stream, stderr: stderr.stream });

    expect(exitCode).toBe(2);
    expect(stderr.output()).toContain('Usage:');
    expect(stdout.output()).toBe('');
  });

  test('start_creates_one_monitor_for_all_configured_projects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const configPath = await writeConfig(directory, join(directory, 'events.sqlite'), [
      { id: 'alpha', name: 'Alpha', directory: alphaDirectory },
      { id: 'bravo', name: 'Bravo', directory: bravoDirectory },
    ]);
    const startedProjects: string[][] = [];
    let closeCount = 0;
    let sigintHandler: (() => void) | undefined;
    const dependencies = createStartDependencies({
      close: () => {
        closeCount += 1;
      },
      onSigint: (handler) => {
        sigintHandler = handler;
        return () => undefined;
      },
      onRun: (configuredProjects, signal) => {
        startedProjects.push(configuredProjects.map(({ id }) => id));
        sigintHandler?.();
        return waitForAbort(signal);
      },
    });
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await main(['start', '--config', configPath], { stdout: stdout.stream, stderr: stderr.stream }, dependencies);

    expect(exitCode).toBe(0);
    expect(startedProjects).toEqual([['alpha', 'bravo']]);
    expect(closeCount).toBe(1);
    expect(stderr.output()).toBe('');
  });

  test('start_closes_store_after_global_monitor_failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const stderr = captureWritable();
    const configPath = await writeConfig(directory, join(directory, 'events.sqlite'), [
      { id: 'alpha', name: 'Alpha', directory: alphaDirectory },
      { id: 'bravo', name: 'Bravo', directory: bravoDirectory },
    ]);
    let closeCount = 0;
    const dependencies = createStartDependencies({
      close: () => {
        closeCount += 1;
      },
      onSigint: () => () => undefined,
      onRun: async () => {
        throw new Error('global monitor failed');
      },
    });

    const exitCode = await main(['start', '--config', configPath], { stdout: captureWritable().stream, stderr: stderr.stream }, dependencies);

    expect(exitCode).toBe(1);
    expect(closeCount).toBe(1);
    expect(stderr.output()).toContain('global monitor failed');
  });

  test('invalid_config_returns_one_with_concise_diagnostic', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const configPath = join(directory, 'invalid.json');
    await writeFile(configPath, JSON.stringify({ databasePath: '', projects: [] }));
    const stdout = captureWritable();
    const stderr = captureWritable();

    const exitCode = await main(['events', '--config', configPath], { stdout: stdout.stream, stderr: stderr.stream });

    expect(exitCode).toBe(1);
    expect(stderr.output()).toContain('Invalid configuration');
    expect(stderr.output()).not.toContain('ZodError');
    expect(stdout.output()).toBe('');
  });
});

async function writeConfig(
  directory: string,
  databasePath: string,
  projects: ProjectConfig[] = [{ id: 'demo', name: 'Demo Project', directory: join(tmpdir(), 'project-voice-bridge-projects', 'demo') }],
): Promise<string> {
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ databasePath, projects }, null, 2));
  return configPath;
}

function seedEvents(databasePath: string, count: number): void {
  const store = new EventStore(databasePath);
  try {
    for (let index = 0; index < count; index += 1) {
      store.insert({
        id: `event-${index}`,
        projectId: 'demo',
        projectName: 'Demo Project',
        sessionId: `session-${index}`,
        kind: 'turn-ended',
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        summary: `OpenCode turn finished ${index}`,
        rawEventType: 'session.idle',
      });
    }
  } finally {
    store.close();
  }
}

function createStartDependencies(options: {
  close?: () => void;
  onSigint: (handler: () => void) => () => void;
  onRun: (projects: readonly ProjectConfig[], signal: AbortSignal) => Promise<void>;
}): CliDependencies {
  return {
    createStore: () => ({
      close: options.close ?? (() => undefined),
      insert: () => undefined,
      list: () => [],
    } as unknown as EventStore),
    createMonitor: (projects) => ({
      run: (signal) => options.onRun(projects, signal),
    }),
    createVoice: () => { throw new Error('not used'); },
    onSigint: options.onSigint,
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function waitForOutput(output: { output(): string }, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.output().includes(text)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Prompt did not display ${text}`);
}
