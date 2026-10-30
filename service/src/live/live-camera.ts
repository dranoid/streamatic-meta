import { zoneRule, type SavedRule } from '../rules/rule-store.js';
import { runZoneRule, type BoxJudge, type Frame, type RuleProgress, type ZoneAlert, type ZoneRule } from '../rules/zone-rule.js';
import type { Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';
import type { Outliner } from '../setup/camera-setup.js';

export interface PictureSource {
  next(): Promise<Frame[]>;
}

export interface RuleAlert {
  alert: ZoneAlert;
  rule: SavedRule;
}

// Pictures older than this are dropped; it covers a check's pictures and the pictures kept either side of an alert.
const KEEP_MS = 90_000;

const lastJudged = (alert: ZoneAlert) => alert.judged[alert.judged.length - 1]?.at ?? alert.at;

// One camera's saved rules, run on its pictures as they arrive.
export class LiveCamera {
  readonly #buffer: Frame[] = [];
  readonly #progress = new Map<number, RuleProgress>();
  #pending: RuleAlert[] = [];

  constructor(
    private readonly options: {
      source: PictureSource;
      // Read on every step, so a rule saved or removed in the app takes effect at once.
      rules: () => SavedRule[];
      sam: Outliner;
      judge?: BoxJudge;
      crop: (picture: Picture, box: Box) => Promise<Picture>;
      timeZone: string;
      timing: Pick<ZoneRule, 'samples' | 'sampleGapMs' | 'cooldownMs'>;
      // The event keeps the pictures this long before the first picture judged and after the last.
      aroundMs: number;
    },
  ) {}

  get lastPictureAt(): number | null {
    return this.#buffer[this.#buffer.length - 1]?.at ?? null;
  }

  async step(): Promise<{ alerts: RuleAlert[]; settled: Array<RuleAlert & { around: Frame[] }> }> {
    const fresh = (await this.options.source.next()).sort((a, b) => a.at - b.at);
    // A recording on a loop starts again with earlier pictures: the last pass's alerts settle with what arrived,
    // and every rule watches the new pass from its start.
    const restarted = fresh.length > 0 && this.lastPictureAt !== null && fresh[0]!.at <= this.lastPictureAt;
    const carried = restarted ? this.#settle(() => true) : [];
    if (restarted) {
      this.#buffer.length = 0;
      this.#progress.clear();
    }
    const before = this.lastPictureAt ?? -Infinity;
    this.#buffer.push(...fresh);
    const latest = this.lastPictureAt ?? -Infinity;
    while (this.#buffer.length > 0 && this.#buffer[0]!.at < latest - KEEP_MS) this.#buffer.shift();

    const alerts: RuleAlert[] = [];
    const rules = this.options.rules();
    for (const saved of rules) {
      // A rule first seen now watches only the pictures that arrived with it.
      const progress = this.#progress.get(saved.id) ?? { scannedTo: before, quietUntil: -Infinity };
      const result = await runZoneRule({ ...this.options, rule: zoneRule(saved, this.options.timing), frames: this.#buffer, live: true, progress });
      this.#progress.set(saved.id, result.progress);
      alerts.push(...result.alerts.map((alert) => ({ alert, rule: saved })));
    }
    for (const id of this.#progress.keys()) if (!rules.some((r) => r.id === id)) this.#progress.delete(id);

    this.#pending.push(...alerts);
    const settled = [...carried, ...this.#settle((alert) => latest >= lastJudged(alert) + this.options.aroundMs)];
    return { alerts, settled };
  }

  // Alerts whose pictures around them are here, with those pictures.
  #settle(ready: (alert: ZoneAlert) => boolean): Array<RuleAlert & { around: Frame[] }> {
    const { aroundMs } = this.options;
    const done = this.#pending.filter((p) => ready(p.alert));
    this.#pending = this.#pending.filter((p) => !done.includes(p));
    return done.map((p) => {
      const first = p.alert.judged[0]?.at ?? p.alert.at;
      return { ...p, around: this.#buffer.filter((f) => f.at >= first - aroundMs && f.at <= lastJudged(p.alert) + aroundMs) };
    });
  }
}
