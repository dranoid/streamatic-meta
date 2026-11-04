import { DatabaseSync } from 'node:sqlite';
import type { CameraSetup } from '../setup/camera-setup.js';
import type { CaptionLanguage } from '../spark/alert-caption.js';

export interface DemoClipRow {
  id: string;
  scenario: string;
  name: string;
  description: string | null;
  position: number;
  // The capture time of the clip's first second; every moment below is counted from it.
  startsAt: number;
  lengthMs: number;
}

export interface RuleZone {
  name: string;
  paths: string[];
}

// One visitor's change to a camera's zone, kept under the name setup gave it: a new name, or null when they deleted it.
export interface ZoneEdit {
  zone: string;
  name: string | null;
}

export interface DemoRule {
  id: string;
  clip: string;
  kind: 'offered' | 'typed';
  // Whose typed rule this is; an offered rule belongs to every visitor.
  visitor: string | null;
  text: string;
  name: string;
  readsAs: string | null;
  status: string;
  progress: { done: number; total: number | null };
  rewrites: string[];
  reason: string | null;
  canAnswer: boolean;
  zones: RuleZone[];
}

export interface DemoAlert {
  key: string;
  rule: string;
  atMs: number;
  shownMs: number;
  delayMs: number;
  message: string;
  severity: string;
  // A file in the clip's evidence folder.
  picture: string | null;
  caption: string | null;
  // What this rule's alerts say in other languages, written once and kept; a language missing here simply has none yet.
  captions: Partial<Record<CaptionLanguage, string>>;
}

interface ClipRow {
  id: string;
  scenario: string;
  name: string;
  description: string | null;
  position: number;
  starts_at: number;
  length_ms: number;
}

interface AlertRow {
  key: string;
  at_ms: number;
  shown_ms: number;
  delay_ms: number;
  message: string;
  severity: string;
  picture: string | null;
  caption: string | null;
}

interface RuleRow {
  id: string;
  clip: string;
  kind: string;
  visitor: string | null;
  text: string;
  name: string;
  reads_as: string | null;
  status: string;
  done: number;
  total: number | null;
  rewrites: string;
  reason: string | null;
  can_answer: number;
  zones: string;
}

const ruleOf = (row: RuleRow): DemoRule => ({
  id: row.id,
  clip: row.clip,
  kind: row.kind as DemoRule['kind'],
  visitor: row.visitor,
  text: row.text,
  name: row.name,
  readsAs: row.reads_as,
  status: row.status,
  progress: { done: row.done, total: row.total },
  rewrites: JSON.parse(row.rewrites) as string[],
  reason: row.reason,
  canAnswer: row.can_answer === 1,
  zones: JSON.parse(row.zones) as RuleZone[],
});

// The public page's clips, their rules and each rule's alert points, kept here so that playing a clip asks nothing of anyone.
export class DemoStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS demo_clips (
        id TEXT PRIMARY KEY, scenario TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        position INTEGER NOT NULL, starts_at INTEGER NOT NULL, length_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_rules (
        id TEXT PRIMARY KEY, clip TEXT NOT NULL REFERENCES demo_clips(id), kind TEXT NOT NULL, visitor TEXT,
        text TEXT NOT NULL, name TEXT NOT NULL, reads_as TEXT, status TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, total INTEGER,
        rewrites TEXT NOT NULL DEFAULT '[]', reason TEXT, can_answer INTEGER NOT NULL DEFAULT 1, zones TEXT NOT NULL DEFAULT '[]',
        copied INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS demo_alerts (
        rule TEXT NOT NULL REFERENCES demo_rules(id), piece INTEGER NOT NULL, key TEXT NOT NULL, at_ms INTEGER NOT NULL, shown_ms INTEGER NOT NULL,
        delay_ms INTEGER NOT NULL, message TEXT NOT NULL, severity TEXT NOT NULL, picture TEXT, caption TEXT,
        PRIMARY KEY (rule, piece, key)
      );
      CREATE TABLE IF NOT EXISTS demo_captions (
        rule TEXT NOT NULL REFERENCES demo_rules(id), language TEXT NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY (rule, language)
      );
      CREATE TABLE IF NOT EXISTS demo_zone_edits (
        visitor TEXT NOT NULL, camera TEXT NOT NULL, zone TEXT NOT NULL, name TEXT,
        PRIMARY KEY (visitor, camera, zone)
      );
      CREATE TABLE IF NOT EXISTS demo_live_setups (
        visitor TEXT NOT NULL, camera TEXT NOT NULL, setup TEXT NOT NULL,
        PRIMARY KEY (visitor, camera)
      );
      CREATE TABLE IF NOT EXISTS demo_tracks (
        visitor TEXT NOT NULL, clip TEXT NOT NULL, track TEXT NOT NULL,
        PRIMARY KEY (visitor, clip, track)
      );
    `);
  }

  saveClip(clip: DemoClipRow): void {
    this.#db
      .prepare(
        `INSERT INTO demo_clips (id, scenario, name, description, position, starts_at, length_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scenario = excluded.scenario, name = excluded.name, description = excluded.description,
           position = excluded.position, starts_at = excluded.starts_at, length_ms = excluded.length_ms`,
      )
      .run(clip.id, clip.scenario, clip.name, clip.description, clip.position, clip.startsAt, clip.lengthMs);
  }

  clips(): DemoClipRow[] {
    const rows = this.#db.prepare('SELECT * FROM demo_clips ORDER BY position, id').all() as unknown as ClipRow[];
    return rows.map(({ id, scenario, name, description, position, starts_at, length_ms }) => ({ id, scenario, name, description, position, startsAt: starts_at, lengthMs: length_ms }));
  }

  clip(id: string): DemoClipRow | null {
    return this.clips().find((c) => c.id === id) ?? null;
  }

  addRule(rule: Pick<DemoRule, 'id' | 'clip' | 'kind' | 'visitor' | 'text' | 'name' | 'readsAs' | 'status' | 'zones'>): void {
    this.#db
      .prepare(
        `INSERT INTO demo_rules (id, clip, kind, visitor, text, name, reads_as, status, zones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, reads_as = excluded.reads_as`,
      )
      .run(rule.id, rule.clip, rule.kind, rule.visitor, rule.text, rule.name, rule.readsAs, rule.status, JSON.stringify(rule.zones));
  }

  // The rules a visitor may see on a clip: the offered ones, and the ones they typed.
  rules(clip: string, visitor: string): DemoRule[] {
    const rows = this.#db.prepare(`SELECT * FROM demo_rules WHERE clip = ? AND (kind = 'offered' OR visitor = ?) ORDER BY kind, rowid`).all(clip, visitor) as unknown as RuleRow[];
    return rows.map(ruleOf);
  }

  rule(id: string): DemoRule | null {
    const row = this.#db.prepare('SELECT * FROM demo_rules WHERE id = ?').get(id) as unknown as RuleRow | undefined;
    return row ? ruleOf(row) : null;
  }

  updateRule(id: string, update: Pick<DemoRule, 'name' | 'readsAs' | 'status' | 'progress' | 'rewrites' | 'reason' | 'canAnswer'>): void {
    this.#db
      .prepare('UPDATE demo_rules SET name = ?, reads_as = ?, status = ?, done = ?, total = ?, rewrites = ?, reason = ?, can_answer = ? WHERE id = ?')
      .run(update.name, update.readsAs, update.status, update.progress.done, update.progress.total, JSON.stringify(update.rewrites), update.reason, update.canAnswer ? 1 : 0, id);
  }

  removeRule(id: string): void {
    this.#db.prepare('DELETE FROM demo_captions WHERE rule = ?').run(id);
    this.#db.prepare('DELETE FROM demo_alerts WHERE rule = ?').run(id);
    this.#db.prepare('DELETE FROM demo_rules WHERE id = ?').run(id);
  }

  liveSetup(visitor: string, camera: string): CameraSetup | null {
    const row = this.#db.prepare('SELECT setup FROM demo_live_setups WHERE visitor = ? AND camera = ?').get(visitor, camera) as { setup: string } | undefined;
    return row ? (JSON.parse(row.setup) as CameraSetup) : null;
  }

  saveLiveSetup(visitor: string, camera: string, setup: CameraSetup): void {
    this.#db.prepare('INSERT OR REPLACE INTO demo_live_setups (visitor, camera, setup) VALUES (?, ?, ?)').run(visitor, camera, JSON.stringify(setup));
  }

  clearLiveSetup(visitor: string, camera: string): void {
    this.#db.prepare('DELETE FROM demo_live_setups WHERE visitor = ? AND camera = ?').run(visitor, camera);
  }

  addTrack(visitor: string, clip: string, track: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO demo_tracks (visitor, clip, track) VALUES (?, ?, ?)').run(visitor, clip, track);
  }

  tracks(visitor: string, clip: string): string[] {
    return (this.#db.prepare('SELECT track FROM demo_tracks WHERE visitor = ? AND clip = ?').all(visitor, clip) as unknown as Array<{ track: string }>).map((row) => row.track);
  }

  removeTrack(visitor: string, clip: string, track: string): boolean {
    return Number(this.#db.prepare('DELETE FROM demo_tracks WHERE visitor = ? AND clip = ? AND track = ?').run(visitor, clip, track).changes) > 0;
  }

  // Everything this visitor did on the page; what the clips themselves hold stays.
  forgetVisitor(visitor: string): void {
    const typed = this.#db.prepare(`SELECT id FROM demo_rules WHERE kind = 'typed' AND visitor = ?`).all(visitor) as unknown as Array<{ id: string }>;
    for (const { id } of typed) this.removeRule(id);
    this.#db.prepare('DELETE FROM demo_zone_edits WHERE visitor = ?').run(visitor);
    this.#db.prepare('DELETE FROM demo_live_setups WHERE visitor = ?').run(visitor);
    this.#db.prepare('DELETE FROM demo_tracks WHERE visitor = ?').run(visitor);
  }

  zoneEdits(visitor: string, camera: string): ZoneEdit[] {
    return this.#db.prepare('SELECT zone, name FROM demo_zone_edits WHERE visitor = ? AND camera = ?').all(visitor, camera) as unknown as ZoneEdit[];
  }

  saveZoneEdit(visitor: string, camera: string, edit: ZoneEdit): void {
    this.#db.prepare('INSERT OR REPLACE INTO demo_zone_edits (visitor, camera, zone, name) VALUES (?, ?, ?, ?)').run(visitor, camera, edit.zone, edit.name);
  }

  clearZoneEdits(visitor: string, camera: string): void {
    this.#db.prepare('DELETE FROM demo_zone_edits WHERE visitor = ? AND camera = ?').run(visitor, camera);
  }

  // A rule keeps its zones' outlines from when it was made, so a new name is written into the visitor's rules that show it.
  renameZoneOnRules(clip: string, visitor: string, from: string, to: string): void {
    const update = this.#db.prepare('UPDATE demo_rules SET zones = ? WHERE id = ?');
    for (const rule of this.rules(clip, visitor).filter((r) => r.kind === 'typed' && r.zones.some((z) => z.name === from))) {
      update.run(JSON.stringify(rule.zones.map((z) => (z.name === from ? { ...z, name: to } : z))), rule.id);
    }
  }

  isCopied(rule: string): boolean {
    return (this.#db.prepare('SELECT copied FROM demo_rules WHERE id = ?').get(rule) as { copied: number } | undefined)?.copied === 1;
  }

  // A rule's alerts for each piece of the clip it could be ticked in, all at once, so a half-finished copy is never read.
  saveAlerts(rule: string, byPiece: Array<{ piece: number; alerts: Array<Omit<DemoAlert, 'rule' | 'captions'>> }>): void {
    this.#writeAlerts(rule, byPiece, true);
  }

  // What a rule still reading the clip has raised so far: it replaces what was shown, and the rule is not yet copied.
  saveAlertsSoFar(rule: string, alerts: Array<Omit<DemoAlert, 'rule' | 'captions'>>): void {
    this.#writeAlerts(rule, [{ piece: 0, alerts }], false);
  }

  #writeAlerts(rule: string, byPiece: Array<{ piece: number; alerts: Array<Omit<DemoAlert, 'rule' | 'captions'>> }>, copied: boolean): void {
    const insert = this.#db.prepare(
      'INSERT OR REPLACE INTO demo_alerts (rule, piece, key, at_ms, shown_ms, delay_ms, message, severity, picture, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM demo_alerts WHERE rule = ?').run(rule);
      for (const { piece, alerts } of byPiece) {
        for (const a of alerts) insert.run(rule, piece, a.key, a.atMs, a.shownMs, a.delayMs, a.message, a.severity, a.picture, a.caption);
      }
      if (copied) this.#db.prepare('UPDATE demo_rules SET copied = 1 WHERE id = ?').run(rule);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  alerts(rule: string, piece: number): DemoAlert[] {
    const rows = this.#db.prepare('SELECT * FROM demo_alerts WHERE rule = ? AND piece = ? ORDER BY at_ms, key').all(rule, piece) as unknown as AlertRow[];
    const captions = this.captions(rule);
    return rows.map(({ key, at_ms, shown_ms, delay_ms, message, severity, picture, caption }) => ({ key, rule, atMs: at_ms, shownMs: shown_ms, delayMs: delay_ms, message, severity, picture, caption, captions }));
  }

  alert(rule: string, key: string): DemoAlert | null {
    const row = this.#db.prepare('SELECT * FROM demo_alerts WHERE rule = ? AND key = ? LIMIT 1').get(rule, key) as unknown as AlertRow | undefined;
    if (!row) return null;
    const { at_ms, shown_ms, delay_ms, message, severity, picture, caption } = row;
    return { key, rule, atMs: at_ms, shownMs: shown_ms, delayMs: delay_ms, message, severity, picture, caption, captions: this.captions(rule) };
  }

  captions(rule: string): DemoAlert['captions'] {
    const rows = this.#db.prepare('SELECT language, text FROM demo_captions WHERE rule = ?').all(rule) as unknown as Array<{ language: CaptionLanguage; text: string }>;
    return Object.fromEntries(rows.map(({ language, text }) => [language, text]));
  }

  saveCaption(rule: string, language: CaptionLanguage, text: string): void {
    this.#db.prepare('INSERT OR REPLACE INTO demo_captions (rule, language, text) VALUES (?, ?, ?)').run(rule, language, text);
  }

  // How many alerts a rule gives when it is ticked from the clip's start.
  alertCount(clip: string): number {
    return (this.#db.prepare(`SELECT count(*) AS n FROM demo_alerts a JOIN demo_rules r ON r.id = a.rule WHERE r.clip = ? AND r.kind = 'offered' AND a.piece = 0`).get(clip) as { n: number }).n;
  }
}
