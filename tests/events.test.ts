import { describe, expect, test } from 'vitest';
import { mapOpenCodeEvent, type ProjectConfig } from '../src/events.js';

const projects: ProjectConfig[] = [
  { id: 'project-alpha', name: 'Project Alpha', directory: 'C:\\Projects\\alpha' },
  { id: 'project-beta', name: 'Project Beta', directory: 'D:\\Work\\beta' },
];

const occurredAt = new Date('2026-09-27T12:34:56.789Z');

describe('mapOpenCodeEvent', () => {
  test.each([
    ['session.idle', 'session-1', 'turn-ended', 'OpenCode turn finished'],
    ['permission.asked', 'session-2', 'waiting-for-input', 'OpenCode is waiting for input'],
    ['permission.v2.asked', 'session-3', 'waiting-for-input', 'OpenCode is waiting for input'],
    ['session.error', 'session-4', 'error', 'OpenCode session error'],
  ] as const)('maps V2 %s to a project-scoped captured event', (type, sessionID, kind, summary) => {
    const event = {
      id: `source-${type}`,
      type,
      data: { sessionID },
      location: { directory: 'C:/Projects/alpha/' },
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
      location: { directory: 'D:/work/BETA' },
    };

    expect(mapOpenCodeEvent(projects, event, occurredAt)).toMatchObject({
      id: JSON.stringify(['project-beta', 'source-beta']),
      projectId: 'project-beta',
      projectName: 'Project Beta',
      sessionId: 'session-beta',
    });
  });

  test('uses_project_scoped_v2_event_ids_and_ignores_missing_ids', () => {
    const event = {
      id: 'source-event-1',
      type: 'session.idle',
      data: { sessionID: 'session-1' },
      location: { directory: 'C:\\Projects\\alpha' },
    };

    const first = mapOpenCodeEvent(projects, event, occurredAt);
    const replay = mapOpenCodeEvent(projects, event, occurredAt);
    const missingId = mapOpenCodeEvent(projects, { ...event, id: '' }, occurredAt);

    expect(first?.id).toBe(JSON.stringify(['project-alpha', 'source-event-1']));
    expect(replay?.id).toBe(first?.id);
    expect(missingId).toBeNull();
  });

  test('normalizes_windows_project_directories_for_exact_matching', () => {
    const event = {
      id: 'source-event-1',
      type: 'session.idle',
      data: { sessionID: 'session-1' },
      location: { directory: 'c:/projects/ALPHA///' },
    };

    expect(mapOpenCodeEvent(projects, event, occurredAt)?.projectId).toBe('project-alpha');
  });

  test.each([
    ['unknown event', { id: 'source-unknown', type: 'session.status', data: { sessionID: 'session-1' }, location: { directory: 'C:/Projects/alpha' } }],
    ['malformed event', { id: 'source-malformed', type: 'session.idle', data: null, location: { directory: 'C:/Projects/alpha' } }],
    ['event without session ID', { id: 'source-sessionless', type: 'session.error', data: {}, location: { directory: 'C:/Projects/alpha' } }],
    ['event without location', { id: 'source-no-location', type: 'session.idle', data: { sessionID: 'session-1' } }],
    ['event without location directory', { id: 'source-no-directory', type: 'session.idle', data: { sessionID: 'session-1' }, location: {} }],
    ['event from unconfigured location', { id: 'source-other', type: 'session.idle', data: { sessionID: 'session-1' }, location: { directory: 'E:/Other' } }],
    ['event without ID', { type: 'session.idle', data: { sessionID: 'session-1' }, location: { directory: 'C:/Projects/alpha' } }],
  ])('ignores_events_without_a_configured_location_or_valid_payload (%s)', (_caseName, event) => {
    expect(mapOpenCodeEvent(projects, event, occurredAt)).toBeNull();
  });
});
