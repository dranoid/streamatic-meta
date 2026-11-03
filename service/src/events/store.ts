import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface NewEvent {
  camera: string;
  zone: string;
  rule: string;
  at: number;
  // File names in the store's media folder; an event has a picture or, when no single picture shows it, a clip.
  picture: string | null;
  clip: string | null;
  outline: string | null;
  reference: string | null;
  // The backend's alert this was copied from, so one alert is kept once; null for a stretch of a recorded run.
  backendId: string | null;
  // Found by running the rule over stored pictures rather than raised as the pictures arrived.
  recorded: boolean;
}

export interface StoredEvent extends NewEvent {
  id: number;
}

// A picture around the event, as a file in the media folder; outline is SAM's, on the pictures the deciding check judged.
export interface EventFrame {
  at: number;
  file: string;
  outline: string | null;
}

export interface EventFilter {
  camera?: string;
  zone?: string;
  from?: number;
  to?: number;
  // Local hours in the store's time zone; from 22 to 6 runs across midnight.
  hours?: { from: number; to: number };
}

interface Row {
  id: number;
  camera: string;
  zone: string;
  rule: string;
  at: number;
  picture: string | null;
  clip: string | null;
  outline: string | null;
  reference: string | null;
  backend_id: string | null;
  recorded: number;
}

// The database does the counting, so an answer about events can be checked against the rows behind it.
export class EventStore {
  readonly #db: DatabaseSync;
  readonly #hour: Intl.DateTimeFormat;

  constructor(path: string, timeZone: string) {
    this.#db = new DatabaseSync(path);
    this.#hour = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone });
    this.#db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      camera TEXT NOT NULL,
      zone TEXT NOT NULL,
      rule TEXT NOT NULL,
      at INTEGER NOT NULL,
      local_hour INTEGER NOT NULL,
      picture TEXT,
      clip TEXT,
      outline TEXT,
      reference TEXT,
      backend_id TEXT UNIQUE,
      recorded INTEGER NOT NULL DEFAULT 0
    )`);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS event_frames (
      event_id INTEGER NOT NULL REFERENCES events (id),
      at INTEGER NOT NULL,
      file TEXT NOT NULL,
      outline TEXT
    )`);
  }

  add(event: NewEvent): number {
    const result = this.#db
      .prepare(
        `INSERT INTO events (camera, zone, rule, at, local_hour, picture, clip, outline, reference, backend_id, recorded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.camera,
        event.zone,
        event.rule,
        event.at,
        Number(this.#hour.format(event.at)),
        event.picture,
        event.clip,
        event.outline,
        event.reference,
        event.backendId,
        event.recorded ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  hasBackendAlert(backendId: string): boolean {
    return this.#db.prepare('SELECT 1 FROM events WHERE backend_id = ?').get(backendId) !== undefined;
  }

  get(id: number): StoredEvent | null {
    const row = this.#db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  count(filter: EventFilter): number {
    const { where, values } = whereClause(filter);
    const row = this.#db.prepare(`SELECT count(*) AS n FROM events ${where}`).get(...values) as { n: number };
    return row.n;
  }

  list(filter: EventFilter): StoredEvent[] {
    const { where, values } = whereClause(filter);
    const rows = this.#db.prepare(`SELECT * FROM events ${where} ORDER BY at DESC, id DESC`).all(...values) as unknown as Row[];
    return rows.map(toEvent);
  }

  addFrames(eventId: number, frames: EventFrame[]): void {
    const insert = this.#db.prepare('INSERT INTO event_frames (event_id, at, file, outline) VALUES (?, ?, ?, ?)');
    for (const frame of frames) insert.run(eventId, frame.at, frame.file, frame.outline);
  }

  frames(eventId: number): EventFrame[] {
    return this.#db
      .prepare('SELECT at, file, outline FROM event_frames WHERE event_id = ? ORDER BY at')
      .all(eventId) as unknown as EventFrame[];
  }

  // Events keep the zone's name as it was, so a rename carries them along to keep counts by zone whole.
  renameZone(camera: string, from: string, to: string): number {
    return Number(this.#db.prepare('UPDATE events SET zone = ? WHERE camera = ? AND zone = ?').run(to, camera, from).changes);
  }

  places(): Array<{ camera: string; zone: string }> {
    return this.#db.prepare('SELECT DISTINCT camera, zone FROM events ORDER BY camera, zone').all() as unknown as Array<{
      camera: string;
      zone: string;
    }>;
  }
}

function whereClause(filter: EventFilter): { where: string; values: SQLInputValue[] } {
  const conditions: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.camera !== undefined) conditions.push('camera = ?'), values.push(filter.camera);
  if (filter.zone !== undefined) conditions.push('zone = ?'), values.push(filter.zone);
  if (filter.from !== undefined) conditions.push('at >= ?'), values.push(filter.from);
  if (filter.to !== undefined) conditions.push('at <= ?'), values.push(filter.to);
  if (filter.hours) {
    const { from, to } = filter.hours;
    conditions.push(from <= to ? '(local_hour >= ? AND local_hour < ?)' : '(local_hour >= ? OR local_hour < ?)');
    values.push(from, to);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

function toEvent(row: Row): StoredEvent {
  return {
    id: row.id,
    camera: row.camera,
    zone: row.zone,
    rule: row.rule,
    at: row.at,
    picture: row.picture,
    clip: row.clip,
    outline: row.outline,
    reference: row.reference,
    backendId: row.backend_id,
    recorded: row.recorded === 1,
  };
}
