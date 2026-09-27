import type { Event as OpenCodeEvent } from '@opencode-ai/sdk';
import { describe, expect, test } from 'vitest';
import { mapOpenCodeEvent, type ProjectConfig } from '../src/events.js';

const project: ProjectConfig = {
  id: 'project-alpha',
  name: 'Project Alpha',
  baseURL: 'http://127.0.0.1:4096',
};

const occurredAt = new Date('2026-09-27T12:34:56.789Z');

function expectUuid(value: string): void {
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
}

describe('mapOpenCodeEvent', () => {
  test.each([
    [
      'session.idle',
      { type: 'session.idle', properties: { sessionID: 'session-1' } } satisfies Extract<OpenCodeEvent, { type: 'session.idle' }>,
      'turn-ended',
      'OpenCode turn finished',
    ],
    [
      'permission.updated',
      {
        type: 'permission.updated',
        properties: {
          id: 'permission-1',
          type: 'tool',
          sessionID: 'session-2',
          messageID: 'message-1',
          title: 'Approve tool use',
          metadata: {},
          time: { created: 0 },
        },
      } satisfies Extract<OpenCodeEvent, { type: 'permission.updated' }>,
      'waiting-for-input',
      'OpenCode is waiting for input',
    ],
    [
      'session.error',
      { type: 'session.error', properties: { sessionID: 'session-3' } } satisfies Extract<OpenCodeEvent, { type: 'session.error' }>,
      'error',
      'OpenCode session error',
    ],
  ] as const)('maps %s to a captured event', (_type, event, kind, summary) => {
    const mapped = mapOpenCodeEvent(project, event, occurredAt);

    expect(mapped).toMatchObject({
      projectId: project.id,
      projectName: project.name,
      sessionId: event.properties.sessionID,
      kind,
      occurredAt: occurredAt.toISOString(),
      summary,
      rawEventType: event.type,
    });
    expectUuid(mapped?.id ?? '');
  });

  test('uses a stable project-scoped ID when the source event ID is present', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'session-1' } } satisfies Extract<OpenCodeEvent, { type: 'session.idle' }>;

    const first = mapOpenCodeEvent(project, event, occurredAt, 'source-event-1');
    const replay = mapOpenCodeEvent(project, event, occurredAt, 'source-event-1');

    expect(first?.id).toBe(JSON.stringify(['project-alpha', 'source-event-1']));
    expect(replay?.id).toBe(first?.id);
  });

  test('keeps source event IDs distinct across projects', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'session-1' } } satisfies Extract<OpenCodeEvent, { type: 'session.idle' }>;
    const otherProject: ProjectConfig = { ...project, id: 'project-beta', name: 'Project Beta' };

    const first = mapOpenCodeEvent(project, event, occurredAt, 'source-event-1');
    const second = mapOpenCodeEvent(otherProject, event, occurredAt, 'source-event-1');

    expect(first?.id).toBe(JSON.stringify(['project-alpha', 'source-event-1']));
    expect(second?.id).toBe(JSON.stringify(['project-beta', 'source-event-1']));
    expect(second?.id).not.toBe(first?.id);
  });

  test('retains a UUID ID when the source event ID is absent', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'session-1' } } satisfies Extract<OpenCodeEvent, { type: 'session.idle' }>;

    const mapped = mapOpenCodeEvent(project, event, occurredAt);

    expectUuid(mapped?.id ?? '');
  });

  test.each([
    ['unrelated event', { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'idle' } } }],
    ['session.error without session ID', { type: 'session.error', properties: {} }],
    ['malformed event', { type: 'session.idle', properties: {} }],
  ])('ignores %s', (_caseName, event) => {
    expect(mapOpenCodeEvent(project, event, occurredAt)).toBeNull();
  });
});
