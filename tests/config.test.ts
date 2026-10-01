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
  const digest = '7fbdbf8f5e45a75bb122155ed546e765b4d9c53a1285f62fd9f506baa1c5a47e';

  test.each(['en', 'es'])('accepts opt-in translation with %s chat language', async (chatLanguage) => {
    const config = {
      databasePath: './bridge.sqlite',
      translation: { model: 'gemma4:e2b', digest },
      projects: [{ id: 'alpha', name: 'Alpha', directory: alphaDirectory, chatLanguage }],
    };

    expect(loadConfig(await writeConfig(config))).toEqual(config);
  });

  test('accepts translation without a project language for a later command override', async () => {
    const config = {
      databasePath: './bridge.sqlite',
      translation: { model: 'gemma4:e2b', digest },
      projects: [{ id: 'alpha', name: 'Alpha', directory: alphaDirectory }],
    };

    expect(loadConfig(await writeConfig(config))).toEqual(config);
  });

  test('project language alone does not enable translation', async () => {
    const config = {
      databasePath: './bridge.sqlite',
      projects: [{ id: 'alpha', name: 'Alpha', directory: alphaDirectory, chatLanguage: 'es' }],
    };

    expect(loadConfig(await writeConfig(config))).toEqual(config);
    expect(loadConfig(await writeConfig(config))).not.toHaveProperty('translation');
  });

  test.each(['fr', '', 'EN', null])('rejects unsupported chat language %s', async (chatLanguage) => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      projects: [{ id: 'alpha', name: 'Alpha', directory: alphaDirectory, chatLanguage }],
    });

    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test.each(['gemma4', 'gemma4:latest', 'gemma4:31b', 'gemma4:e2b-cloud', 'other:e2b', ''])('rejects unsupported translation model %s', async (model) => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      translation: { model, digest },
      projects: [{ id: 'alpha', name: 'Alpha', directory: alphaDirectory }],
    });

    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test.each([undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${digest}\n`, ` ${digest}`])('rejects invalid translation digest %s', async (invalidDigest) => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      translation: { model: 'gemma4:e2b', digest: invalidDigest },
      projects: [{ id: 'alpha', name: 'Alpha', directory: alphaDirectory }],
    });

    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

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
