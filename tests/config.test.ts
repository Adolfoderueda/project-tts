import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const projectRoot = join(tmpdir(), 'project-tts-config-projects');
const alphaDirectory = join(projectRoot, 'alpha');
const betaDirectory = join(projectRoot, 'beta');

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
        { id: 'alpha', name: 'Alpha', directory: alphaDirectory },
        { id: 'beta', name: 'Beta', directory: betaDirectory },
      ],
    });

    expect(loadConfig(path)).toEqual({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', directory: alphaDirectory },
        { id: 'beta', name: 'Beta', directory: betaDirectory },
      ],
    });
  });

  test('rejects duplicate normalized project directories', async () => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', directory: `${alphaDirectory}${sep}` },
        { id: 'beta', name: 'Beta', directory: join(projectRoot, 'child', '..', 'alpha') },
      ],
    });

    expect(() => loadConfig(path)).toThrow(/duplicate project directory/u);
  });

  test.each([
    ['missing project id', { databasePath: './bridge.sqlite', projects: [{ name: 'Alpha', directory: alphaDirectory }] }],
    [
      'duplicate project ids',
      {
        databasePath: './bridge.sqlite',
        projects: [
          { id: 'alpha', name: 'Alpha', directory: alphaDirectory },
          { id: 'alpha', name: 'Other Alpha', directory: betaDirectory },
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
