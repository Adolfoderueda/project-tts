import { describe, expect, test } from 'vitest';
import type { OpenCodeEvent } from '@opencode/client';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mapOpenCodeEvent, type ProjectConfig } from '../src/events.js';

const alphaDirectory = join(tmpdir(), 'project-tts-events', 'alpha');
const betaDirectory = join(tmpdir(), 'project-tts-events', 'beta');
const projects: ProjectConfig[] = [
  { id: 'project-alpha', name: 'Project Alpha', directory: alphaDirectory },
  { id: 'project-beta', name: 'Project Beta', directory: betaDirectory },
];

const occurredAt = new Date('2026-09-27T12:34:56.789Z');

describe('mapOpenCodeEvent', () => {
  test.each([
    ['session.idle', 'session-1', 'turn-ended', 'OpenCode turn finished'],
    ['permission.asked', 'session-2', 'waiting-for-input', 'OpenCode is waiting for input'],
    ['session.execution.failed', 'session-4', 'error', 'OpenCode session error'],
  ] as const)('maps V2 %s to a project-scoped captured event', (type, sessionID, kind, summary) => {
    const event = {
      id: `source-${type}`,
      type,
      data: { sessionID },
      location: { directory: `${alphaDirectory}${sep}` },
    };

    const mapped = mapOpenCodeEvent(projects, event, occurredAt);

    expect(mapped).toEqual({
      id: JSON.stringify(['project-alpha', `source-${type}`]),
      projectId: 'project-alpha',
      projectName: 'Project Alpha',
      sessionId: sessionID,
      kind,
      occurredAt: occurredAt.toISOString(),
      summary,
      rawEventType: type,
    });
  });

  test('routes events from multiple configured directories to the matching project', () => {
    const event = {
      id: 'source-beta',
      type: 'session.idle',
      data: { sessionID: 'session-beta' },
      location: { directory: `${betaDirectory}${sep}` },
    };

    expect(mapOpenCodeEvent(projects, event, occurredAt)).toMatchObject({
      id: JSON.stringify(['project-beta', 'source-beta']),
      projectId: 'project-beta',
      projectName: 'Project Beta',
      sessionId: 'session-beta',
    });
  });

  test('maps the V2 SDK session execution failure contract to a session error', () => {
    const event = {
      id: 'source-failed',
      created: 1,
      type: 'session.execution.failed',
      durable: { aggregateID: 'session-failed', seq: 1, version: 1 },
      data: { sessionID: 'session-failed', error: { type: 'ProviderError', message: 'model failed' } },
      location: { directory: alphaDirectory },
    } satisfies Extract<OpenCodeEvent, { type: 'session.execution.failed' }>;

    expect(mapOpenCodeEvent(projects, event, occurredAt)).toMatchObject({
      id: JSON.stringify(['project-alpha', 'source-failed']),
      projectId: 'project-alpha',
      sessionId: 'session-failed',
      kind: 'error',
      rawEventType: 'session.execution.failed',
    });
  });

  test('uses_project_scoped_v2_event_ids_and_ignores_missing_ids', () => {
    const event = {
      id: 'source-event-1',
      type: 'session.idle',
      data: { sessionID: 'session-1' },
      location: { directory: alphaDirectory },
    };

    const first = mapOpenCodeEvent(projects, event, occurredAt);
    const replay = mapOpenCodeEvent(projects, event, occurredAt);
    const missingId = mapOpenCodeEvent(projects, { ...event, id: '' }, occurredAt);

    expect(first?.id).toBe(JSON.stringify(['project-alpha', 'source-event-1']));
    expect(replay?.id).toBe(first?.id);
    expect(missingId).toBeNull();
  });

  test('routes a directory with trailing platform separators to its exact project', () => {
    const event = {
      id: 'source-event-1',
      type: 'session.idle',
      data: { sessionID: 'session-1' },
      location: { directory: `${alphaDirectory}${sep}${sep}` },
    };

    expect(mapOpenCodeEvent(projects, event, occurredAt)?.projectId).toBe('project-alpha');
  });

  test.each([
    ['unknown event', { id: 'source-unknown', type: 'session.status', data: { sessionID: 'session-1' }, location: { directory: alphaDirectory } }],
    ['unsupported permission event', { id: 'source-unsupported', type: 'permission.v2.asked', data: { sessionID: 'session-1' }, location: { directory: alphaDirectory } }],
    ['malformed event', { id: 'source-malformed', type: 'session.idle', data: null, location: { directory: alphaDirectory } }],
    ['event without session ID', { id: 'source-sessionless', type: 'session.execution.failed', data: {}, location: { directory: alphaDirectory } }],
    ['event without location', { id: 'source-no-location', type: 'session.idle', data: { sessionID: 'session-1' } }],
    ['event without location directory', { id: 'source-no-directory', type: 'session.idle', data: { sessionID: 'session-1' }, location: {} }],
    ['event from unconfigured location', { id: 'source-other', type: 'session.idle', data: { sessionID: 'session-1' }, location: { directory: join(tmpdir(), 'unconfigured-project') } }],
    ['event without ID', { type: 'session.idle', data: { sessionID: 'session-1' }, location: { directory: alphaDirectory } }],
  ])('ignores_events_without_a_configured_location_or_valid_payload (%s)', (_caseName, event) => {
    expect(mapOpenCodeEvent(projects, event, occurredAt)).toBeNull();
  });
});
