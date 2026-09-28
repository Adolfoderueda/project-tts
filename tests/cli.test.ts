import { describe, expect, test } from 'vitest';
import { Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliDependencies } from '../src/cli.js';
import { EventStore } from '../src/store.js';
import type { CapturedEvent } from '../src/events.js';
import type { ProjectConfig } from '../src/config.js';

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
      { id: 'alpha', name: 'Alpha', directory: 'C:\\Projects\\alpha' },
      { id: 'bravo', name: 'Bravo', directory: 'D:\\Work\\bravo' },
    ]);
    const startedProjects: string[][] = [];
    let sigintHandler: (() => void) | undefined;
    const dependencies = createStartDependencies({
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
    expect(stderr.output()).toBe('');
  });

  test('start_closes_store_after_global_monitor_failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-voice-bridge-cli-'));
    const stderr = captureWritable();
    const configPath = await writeConfig(directory, join(directory, 'events.sqlite'), [
      { id: 'alpha', name: 'Alpha', directory: 'C:\\Projects\\alpha' },
      { id: 'bravo', name: 'Bravo', directory: 'D:\\Work\\bravo' },
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
  projects: ProjectConfig[] = [{ id: 'demo', name: 'Demo Project', directory: 'C:\\Projects\\demo' }],
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
