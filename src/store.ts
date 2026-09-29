import Database from 'better-sqlite3';
import type { CapturedEvent } from './events.js';

type EventRow = {
  id: string;
  project_id: string;
  project_name: string;
  session_id: string;
  kind: CapturedEvent['kind'];
  occurred_at: string;
  summary: string;
  raw_event_type: string;
};

function toCapturedEvent(row: EventRow): CapturedEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    sessionId: row.session_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    summary: row.summary,
    rawEventType: row.raw_event_type,
  };
}

export class EventStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    this.#database = new Database(databasePath);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        raw_event_type TEXT NOT NULL
      )
    `);
  }

  insert(event: CapturedEvent): void {
    this.#database
      .prepare(`
        INSERT OR IGNORE INTO events (
          id,
          project_id,
          project_name,
          session_id,
          kind,
          occurred_at,
          summary,
          raw_event_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.projectId,
        event.projectName,
        event.sessionId,
        event.kind,
        event.occurredAt,
        event.summary,
        event.rawEventType,
      );
  }

  get(id: string): CapturedEvent | undefined {
    const row = this.#database
      .prepare('SELECT id, project_id, project_name, session_id, kind, occurred_at, summary, raw_event_type FROM events WHERE id = ?')
      .get(id) as EventRow | undefined;
    return row === undefined ? undefined : toCapturedEvent(row);
  }

  list(limit: number): CapturedEvent[] {
    const rows = this.#database
      .prepare(`
        SELECT
          id,
          project_id,
          project_name,
          session_id,
          kind,
          occurred_at,
          summary,
          raw_event_type
        FROM events
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(limit) as EventRow[];

    return rows.map(toCapturedEvent);
  }

  close(): void {
    this.#database.close();
  }
}
