import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import type { CapturedEvent } from '../src/events.js';
import { EventStore } from '../src/store.js';

const tempDirs: string[] = [];

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'project-tts-store-'));
  tempDirs.push(directory);
  return join(directory, 'events.sqlite');
}

function capturedEvent(overrides: Partial<CapturedEvent> = {}): CapturedEvent {
  return {
    id: 'event-1',
    projectId: 'project-1',
    projectName: 'Project One',
    sessionId: 'session-1',
    kind: 'turn-ended',
    occurredAt: '2026-09-27T10:00:00.000Z',
    summary: 'OpenCode turn finished',
    rawEventType: 'session.idle',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('EventStore', () => {
  test('persists events across close and reopen', async () => {
    const databasePath = await createDatabasePath();
    const event = capturedEvent();

    const firstStore = new EventStore(databasePath);
    firstStore.insert(event);
    firstStore.close();

    const secondStore = new EventStore(databasePath);
    expect(secondStore.list(10)).toEqual([event]);
    secondStore.close();
  });

  test('lists events newest first and uses insertion order to break timestamp ties', async () => {
    const store = new EventStore(await createDatabasePath());
    const older = capturedEvent({ id: 'older', occurredAt: '2026-09-27T09:59:00.000Z' });
    const tiedFirst = capturedEvent({ id: 'tied-first', occurredAt: '2026-09-27T10:00:00.000Z' });
    const tiedSecond = capturedEvent({ id: 'tied-second', occurredAt: '2026-09-27T10:00:00.000Z' });

    store.insert(older);
    store.insert(tiedFirst);
    store.insert(tiedSecond);

    expect(store.list(10)).toEqual([tiedSecond, tiedFirst, older]);
    store.close();
  });

  test('ignores duplicate event IDs idempotently', async () => {
    const store = new EventStore(await createDatabasePath());
    const original = capturedEvent({ id: 'duplicate-id', summary: 'OpenCode turn finished' });
    const duplicate = capturedEvent({ id: 'duplicate-id', summary: 'OpenCode session error', kind: 'error' });

    store.insert(original);
    store.insert(duplicate);

    expect(store.list(10)).toEqual([original]);
    store.close();
  });

  test('persists the same session ID under different project IDs as distinct records', async () => {
    const store = new EventStore(await createDatabasePath());
    const firstProject = capturedEvent({ id: 'project-a-event', projectId: 'project-a', sessionId: 'shared-session' });
    const secondProject = capturedEvent({ id: 'project-b-event', projectId: 'project-b', projectName: 'Project B', sessionId: 'shared-session' });

    store.insert(firstProject);
    store.insert(secondProject);

    expect(store.list(10)).toEqual([secondProject, firstProject]);
    store.close();
  });

  test('gets only the exact event ID when session IDs are shared', async () => {
    const store = new EventStore(await createDatabasePath());
    try {
      const first = capturedEvent({ id: 'event-first', sessionId: 'shared-session' });
      const second = capturedEvent({ id: 'event-second', sessionId: 'shared-session', summary: 'Later turn' });
      store.insert(first);
      store.insert(second);

      expect(store.get('event-first')).toEqual(first);
      expect(store.get('event-second')).toEqual(second);
      expect(store.get('shared-session')).toBeUndefined();
      expect(store.get('unknown-event')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
