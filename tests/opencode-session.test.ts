import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { assertSessionLocation } from '../src/opencode-session.js';

const project = { id: 'demo', name: 'Demo', directory: join(tmpdir(), 'demo') };
const session = (directory = project.directory, id = 'ses-one') => ({ id, location: { directory } });

test('shared assertion accepts only the exact ID and normalized absolute project directory', () => {
  expect(() => assertSessionLocation(session(join(project.directory, 'child', '..')), project, 'ses-one')).not.toThrow();
});

test('shared assertion rejects wrong session ID', () => {
  expect(() => assertSessionLocation(session(project.directory, 'ses-other'), project, 'ses-one'))
    .toThrow('OpenCode session ID or location could not be verified');
});

test.each([undefined, null, {}, { id: 'ses-one' }, { id: 'ses-one', location: {} }])(
  'shared assertion rejects missing or malformed sessions: %j', (value) => {
    expect(() => assertSessionLocation(value, project, 'ses-one')).toThrow('OpenCode session ID or location could not be verified');
  },
);

test('shared assertion rejects relative returned location', () => {
  expect(() => assertSessionLocation(session('demo'), project, 'ses-one')).toThrow('OpenCode session location could not be verified');
});

test('shared assertion rejects a different project', () => {
  expect(() => assertSessionLocation(session(join(tmpdir(), 'other')), project, 'ses-one'))
    .toThrow('OpenCode session location does not match the configured project');
});

test('shared assertion requires absolute configured directory and nonempty session ID', () => {
  expect(() => assertSessionLocation(session(), { ...project, directory: 'demo' }, 'ses-one')).toThrow(/absolute/);
  expect(() => assertSessionLocation(session(), project, '')).toThrow('OpenCode session ID is missing');
});
