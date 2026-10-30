import { DatabaseSync } from 'node:sqlite';
import type { Zone, ZoneRule } from './zone-rule.js';

export interface NewRule {
  camera: string;
  sentence: string;
  zones: Zone[];
  activeHours: { from: number; to: number } | null;
}

export interface SavedRule extends NewRule {
  id: number;
}

interface Row {
  id: number;
  camera: string;
  sentence: string;
  zones: string;
  active_from: number | null;
  active_to: number | null;
}

export class RuleStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY,
      camera TEXT NOT NULL,
      sentence TEXT NOT NULL,
      zones TEXT NOT NULL,
      active_from INTEGER,
      active_to INTEGER
    )`);
  }

  add(rule: NewRule): number {
    const result = this.#db
      .prepare('INSERT INTO rules (camera, sentence, zones, active_from, active_to) VALUES (?, ?, ?, ?, ?)')
      .run(rule.camera, rule.sentence, JSON.stringify(rule.zones), rule.activeHours?.from ?? null, rule.activeHours?.to ?? null);
    return Number(result.lastInsertRowid);
  }

  get(id: number): SavedRule | null {
    const row = this.#db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined;
    return row ? toRule(row) : null;
  }

  list(camera?: string): SavedRule[] {
    const rows = (
      camera === undefined
        ? this.#db.prepare('SELECT * FROM rules ORDER BY id').all()
        : this.#db.prepare('SELECT * FROM rules WHERE camera = ? ORDER BY id').all(camera)
    ) as unknown as Row[];
    return rows.map(toRule);
  }

  setZones(id: number, zones: Zone[]): void {
    this.#db.prepare('UPDATE rules SET zones = ? WHERE id = ?').run(JSON.stringify(zones), id);
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes) > 0;
  }
}

function toRule(row: Row): SavedRule {
  return {
    id: row.id,
    camera: row.camera,
    sentence: row.sentence,
    zones: JSON.parse(row.zones) as Zone[],
    activeHours: row.active_from === null || row.active_to === null ? null : { from: row.active_from, to: row.active_to },
  };
}

// Three pictures 3 s apart decide a check; after an alert, a rule stays quiet for 5 minutes.
export const RULE_TIMING = { samples: 3, sampleGapMs: 3_000, cooldownMs: 5 * 60_000 };

export function zoneRule(saved: SavedRule, timing: Pick<ZoneRule, 'samples' | 'sampleGapMs' | 'cooldownMs'>): ZoneRule {
  return { sentence: saved.sentence, zones: saved.zones, ...(saved.activeHours === null ? {} : { activeHours: saved.activeHours }), ...timing };
}
