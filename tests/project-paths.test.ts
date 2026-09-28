import { describe, expect, test } from 'vitest';
import { normalizeProjectDirectory } from '../src/project-paths.js';

describe('normalizeProjectDirectory', () => {
  test('preserves a valid trailing backslash in a POSIX filename', () => {
    const directoryWithBackslash = normalizeProjectDirectory('/tmp/project\\', 'linux');

    expect(directoryWithBackslash).toBe('/tmp/project\\');
    expect(directoryWithBackslash).not.toBe(normalizeProjectDirectory('/tmp/project', 'linux'));
  });

  test('normalizes_windows_project_directories_for_exact_matching', () => {
    const configuredDirectory = normalizeProjectDirectory('C:\\Projects\\Alpha\\', 'win32');
    const eventDirectory = normalizeProjectDirectory('c:/projects/alpha///', 'win32');

    expect(eventDirectory).toBe(configuredDirectory);
  });
});
