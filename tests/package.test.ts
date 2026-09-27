import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';

interface PackageJson {
  engines?: {
    node?: string;
  };
}

describe('package metadata', () => {
  test('declares_node_engine_compatible_with_dev_toolchain', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;

    expect(packageJson.engines?.node).toBe('>=22.12.0');
  });
});