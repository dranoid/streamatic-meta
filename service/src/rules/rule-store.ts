import { DatabaseSync } from 'node:sqlite';
import type { Box } from '../sam/outlines.js';

export type Zone =
  | { name: string; kind: 'outline'; word: string; reference: Box; path: string }
  | { name: string; kind: 'box'; box: Box; question: string };

export const zoneBox = (zone: Zone): Box => (zone.kind === 'outline' ? zone.reference : zone.box);

// The zone as an SVG path in picture pixels, for drawing it on an alert.
export function zonePath(zone: Zone): string {
  if (zone.kind === 'outline') return zone.path;
  const { left, top, right, bottom } = zone.box;
  return `M${left} ${top}H${right}V${bottom}H${left}Z`;
}

export interface NewRule {
  camera: string;
  sentence: string;
  zones: Zone[];
  activeHours: { from: number; to: number } | null;
  // The rule itself lives in the backend, which answers it; these say which it is and how it reads.
  backendRuleId: string;
  readsAs: string;
  severalPictures: boolean;
  guidePlan: unknown;
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
  backend_rule_id: string;
  reads_as: string;
  several_pictures: number;
  guide_plan: string | null;
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
      active_to INTEGER,
      backend_rule_id TEXT NOT NULL UNIQUE,
      reads_as TEXT NOT NULL,
      several_pictures INTEGER NOT NULL,
      guide_plan TEXT
    )`);
  }

  add(rule: NewRule): number {
    const result = this.#db
      .prepare(
        `INSERT INTO rules (camera, sentence, zones, active_from, active_to, backend_rule_id, reads_as, several_pictures, guide_plan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.camera,
        rule.sentence,
        JSON.stringify(rule.zones),
        rule.activeHours?.from ?? null,
        rule.activeHours?.to ?? null,
        rule.backendRuleId,
        rule.readsAs,
        rule.severalPictures ? 1 : 0,
        rule.guidePlan === null ? null : JSON.stringify(rule.guidePlan),
      );
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
    backendRuleId: row.backend_rule_id,
    readsAs: row.reads_as,
    severalPictures: row.several_pictures === 1,
    guidePlan: row.guide_plan === null ? null : (JSON.parse(row.guide_plan) as unknown),
  };
}
