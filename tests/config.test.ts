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
  test('accepts_multiple_projects_with_http_and_https_endpoints', async () => {
    const path = await writeConfig({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', baseURL: 'http://127.0.0.1:4096' },
        { id: 'beta', name: 'Beta', baseURL: 'https://example.test/opencode' },
      ],
    });

    expect(loadConfig(path)).toEqual({
      databasePath: './bridge.sqlite',
      projects: [
        { id: 'alpha', name: 'Alpha', baseURL: 'http://127.0.0.1:4096' },
        { id: 'beta', name: 'Beta', baseURL: 'https://example.test/opencode' },
      ],
    });
  });

  test.each([
    ['missing project id', { databasePath: './bridge.sqlite', projects: [{ name: 'Alpha', baseURL: 'http://127.0.0.1:4096' }] }],
    [
      'duplicate project ids',
      {
        databasePath: './bridge.sqlite',
        projects: [
          { id: 'alpha', name: 'Alpha', baseURL: 'http://127.0.0.1:4096' },
          { id: 'alpha', name: 'Other Alpha', baseURL: 'https://example.test' },
        ],
      },
    ],
    ['non-http URL', { databasePath: './bridge.sqlite', projects: [{ id: 'alpha', name: 'Alpha', baseURL: 'file:///tmp/socket' }] }],
    ['empty project list', { databasePath: './bridge.sqlite', projects: [] }],
  ])('rejects %s', async (_caseName, config) => {
    const path = await writeConfig(config);

    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});
