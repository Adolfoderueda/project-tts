import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

async function writeConfig(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'project-tts-config-'));
  const path = join(dir, 'bridge-config.json');
  await writeFile(path, JSON.stringify(contents), 'utf8');
  return path;
}

describe('loadConfig', () => {
  test('accepts_multiple_projects_with_absolute_directories', async () => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', directory: 'C:\\Projects\\alpha' },
        { id: 'beta', name: 'Beta', directory: 'D:\\Work\\beta' },
      ],
    });

    expect(loadConfig(path)).toEqual({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', directory: 'C:\\Projects\\alpha' },
        { id: 'beta', name: 'Beta', directory: 'D:\\Work\\beta' },
      ],
    });
  });

  test('rejects duplicate normalized project directories', async () => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', directory: 'C:\\Projects\\Alpha\\' },
        { id: 'beta', name: 'Beta', directory: 'c:/projects/alpha' },
      ],
    });

    expect(() => loadConfig(path)).toThrow(/duplicate project directory/u);
  });

  test.each([
    ['missing project id', { databasePath: './bridge.sqlite', projects: [{ name: 'Alpha', directory: 'C:\\Projects\\alpha' }] }],
    [
      'duplicate project ids',
      {
        databasePath: './bridge.sqlite',
        projects: [
          { id: 'alpha', name: 'Alpha', directory: 'C:\\Projects\\alpha' },
          { id: 'alpha', name: 'Other Alpha', directory: 'D:\\Projects\\alpha' },
        ],
      },
    ],
    ['relative project directory', { databasePath: './bridge.sqlite', projects: [{ id: 'alpha', name: 'Alpha', directory: 'relative/project' }] }],
    ['empty project directory', { databasePath: './bridge.sqlite', projects: [{ id: 'alpha', name: 'Alpha', directory: '' }] }],
    ['empty project list', { databasePath: './bridge.sqlite', projects: [] }],
  ])('rejects %s', async (_caseName, config) => {
    const path = await writeConfig(config);

    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});
