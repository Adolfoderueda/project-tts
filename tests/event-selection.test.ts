import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import type { CapturedEvent } from '../src/events.js';
import type { ProjectConfig } from '../src/config.js';
import { EventStore } from '../src/store.js';
import { selectEvent } from '../src/event-selection.js';

const directories: string[] = [];
const projects: ProjectConfig[] = [
  { id: 'alpha', name: 'Alpha', directory: join(tmpdir(), 'alpha') },
  { id: 'bravo', name: 'Bravo', directory: join(tmpdir(), 'bravo') },
];

async function withStore(run: (store: EventStore) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'project-tts-selection-'));
  directories.push(directory);
  const store = new EventStore(join(directory, 'events.sqlite'));
  try {
    run(store);
  } finally {
    store.close();
  }
}

const event: CapturedEvent = {
  id: 'event-alpha',
  projectId: 'alpha',
  projectName: 'Alpha',
  sessionId: 'shared-session',
  kind: 'turn-ended',
  occurredAt: '2026-09-29T10:00:00.000Z',
  summary: 'OpenCode turn finished',
  rawEventType: 'session.idle',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('selectEvent', () => {
  test('selects the exact event and its configured project even when sessions are shared', async () => {
    await withStore((store) => {
      const other = { ...event, id: 'event-bravo', projectId: 'bravo', projectName: 'Bravo' };
      store.insert(event);
      store.insert(other);

      expect(selectEvent(store, projects, 'event-alpha')).toEqual({ event, project: projects[0] });
      expect(selectEvent(store, projects, 'event-bravo')).toEqual({ event: other, project: projects[1] });
    });
  });

  test('rejects an unknown event ID rather than selecting a matching session', async () => {
    await withStore((store) => {
      store.insert(event);
      expect(() => selectEvent(store, projects, 'shared-session')).toThrow();
      expect(() => selectEvent(store, projects, 'unknown-event')).toThrow();
    });
  });

  test('rejects an event whose project ID was removed', async () => {
    await withStore((store) => {
      store.insert(event);
      expect(() => selectEvent(store, [projects[1]!], event.id)).toThrow();
    });
  });

  test('rejects a reused project ID with a changed name', async () => {
    await withStore((store) => {
      store.insert(event);
      expect(() => selectEvent(store, [{ ...projects[0]!, name: 'Renamed Alpha' }], event.id)).toThrow();
    });
  });

  test('rejects a matching project name under a different ID', async () => {
    await withStore((store) => {
      store.insert(event);
      expect(() => selectEvent(store, [{ ...projects[0]!, id: 'replacement' }], event.id)).toThrow();
    });
  });
});
