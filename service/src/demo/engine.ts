import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendClient, DemoAlert as BackendAlert } from '../backend/client.js';
import { captionLanguages, type WriteCaption } from '../spark/alert-caption.js';
import type { DemoAlert, DemoRule, DemoStore, RuleZone } from './store.js';

export type DemoEngineBackend = Pick<BackendClient, 'demoScenario' | 'demoSchedule' | 'typeDemoRule' | 'demoRule'>;

// A rule ticked at a moment takes part from the footage's next 15-second piece, as a rule saved live does, so one copy per piece covers every tick.
const PIECE_MS = 15_000;
// Inside the piece rather than on its edge, since the backend counts a tick on the edge as belonging to the piece before.
const TICK_INTO_PIECE_MS = 1_000;
const FINAL = new Set(['ready', 'refused', 'failed']);

const pieceOf = (ms: number) => Math.max(0, Math.floor(ms / PIECE_MS));

// What a visitor sees for one rule ticked at a moment: the alerts the backend decided for that piece, never before the tick.
export function showing(alerts: DemoAlert[], armedMs: number): DemoAlert[] {
  return alerts.map((a) => ({ ...a, shownMs: Math.max(a.shownMs, armedMs) }));
}

// The demo around the backend: the backend bakes a clip, reads a rule and decides when it alerts. Those decisions are copied
// here once, and everything a visitor does afterwards is answered from the copy.
export class DemoEngine {
  readonly #store: DemoStore;
  readonly #backend: DemoEngineBackend;
  readonly #folder: string;
  readonly #fetch: typeof fetch;
  readonly #writeCaption: WriteCaption | null;
  readonly #refreshing = new Map<string, Promise<void>>();

  // Without writeCaption, as on a copy with no model keys, alerts simply have no other languages.
  constructor({ store, backend, folder, fetch: fetchImpl = fetch, writeCaption = null }: { store: DemoStore; backend: DemoEngineBackend; folder: string; fetch?: typeof fetch; writeCaption?: WriteCaption | null }) {
    this.#writeCaption = writeCaption;
    this.#store = store;
    this.#backend = backend;
    this.#folder = folder;
    this.#fetch = fetchImpl;
  }

  // Safe to run again: what has been copied is not asked for twice.
  async copyClip({ id, scenario }: { id: string; scenario: string }): Promise<void> {
    const found = await this.#backend.demoScenario(scenario);
    const startsAt = Date.parse(found.fromAt);
    const lengthMs = Date.parse(found.toAt) - startsAt;
    this.#store.saveClip({ id, scenario, name: found.name, description: found.description ?? null, position: found.position, startsAt, lengthMs });
    const pieces = Math.ceil(lengthMs / PIECE_MS);
    for (const rule of found.rules) {
      this.#store.addRule({ id: rule.id, clip: id, kind: 'offered', visitor: null, text: rule.name, name: rule.name, readsAs: typeof rule.readsAs === 'string' ? rule.readsAs : null, status: 'ready', zones: [] });
      if (this.#store.isCopied(rule.id)) {
        await this.#writeCaptions(rule.id, rule.name);
        continue;
      }
      const byPiece = [];
      for (let piece = 0; piece < pieces; piece++) {
        const armedAt = new Date(startsAt + piece * PIECE_MS + TICK_INTO_PIECE_MS).toISOString();
        const { alerts } = await this.#backend.demoSchedule(scenario, [{ ruleId: rule.id, armedAt }]);
        byPiece.push({ piece, alerts: await this.#kept(id, startsAt, alerts) });
      }
      this.#store.saveAlerts(rule.id, byPiece);
      await this.#writeCaptions(rule.id, rule.name);
    }
  }

  // What is not written is written on the next copy; an alert never waits on, or fails with, its caption.
  async #writeCaptions(rule: string, name: string): Promise<void> {
    if (!this.#writeCaption) return;
    const kept = this.#store.captions(rule);
    for (const language of captionLanguages.filter((l) => !kept[l])) {
      await this.#writeCaption(name, language)
        .then((text) => this.#store.saveCaption(rule, language, text))
        .catch((error: unknown) => console.error(`Writing a caption: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  alerts(clip: string, visitor: string, ticks: Array<{ rule: string; armedMs: number }>): DemoAlert[] {
    return ticks.flatMap(({ rule: id, armedMs }) => {
      const rule = this.#store.rule(id);
      if (!rule || rule.clip !== clip || (rule.kind === 'typed' && rule.visitor !== visitor)) return [];
      // A typed rule runs from the clip's start, whenever it was typed, so it can be typed and the clip rewound to show it.
      return rule.kind === 'typed' ? this.#store.alerts(id, 0) : showing(this.#store.alerts(id, pieceOf(armedMs)), armedMs);
    });
  }

  async type(clip: { id: string; scenario: string }, visitor: string, text: string, sent: string, zones: RuleZone[]): Promise<string> {
    const id = await this.#backend.typeDemoRule(clip.scenario, sent);
    this.#store.addRule({ id, clip: clip.id, kind: 'typed', visitor, text, name: text, readsAs: null, status: 'parsing', zones });
    return id;
  }

  // Null unless it is this visitor's own rule on this clip. A rule still being worked on is read from the backend, once at a time.
  async typed(clip: { id: string; scenario: string; startsAt: number }, visitor: string, id: string): Promise<DemoRule | null> {
    const rule = this.#store.rule(id);
    if (!rule || rule.clip !== clip.id || rule.kind !== 'typed' || rule.visitor !== visitor) return null;
    if (FINAL.has(rule.status)) return rule;
    let running = this.#refreshing.get(id);
    if (!running) {
      running = this.#refresh(clip, rule).finally(() => this.#refreshing.delete(id));
      this.#refreshing.set(id, running);
    }
    await running;
    return this.#store.rule(id);
  }

  async #refresh(clip: { id: string; scenario: string; startsAt: number }, rule: DemoRule): Promise<void> {
    const latest = await this.#backend.demoRule(clip.scenario, rule.id);
    // The alerts are in place before the rule says it is ready.
    if (latest.status === 'ready' && !this.#store.isCopied(rule.id)) {
      const { alerts } = await this.#backend.demoSchedule(clip.scenario, [{ draftRuleId: rule.id }]);
      this.#store.saveAlerts(rule.id, [{ piece: 0, alerts: await this.#kept(clip.id, clip.startsAt, alerts) }]);
      await this.#writeCaptions(rule.id, latest.rule?.name ?? rule.name);
    }
    this.#store.updateRule(rule.id, {
      name: latest.rule?.name ?? rule.name,
      readsAs: latest.rule?.readsAs ?? null,
      status: latest.status,
      progress: latest.progress,
      rewrites: latest.refusal?.rewrites ?? [],
      reason: latest.refusal?.reason ?? null,
      canAnswer: !latest.probe?.warns,
    });
  }

  // Each alert on the clip's own clock, with its evidence picture fetched here, since the backend's address lapses within the hour.
  async #kept(clip: string, startsAt: number, alerts: BackendAlert[]): Promise<Array<Omit<DemoAlert, 'rule' | 'captions'>>> {
    return Promise.all(
      alerts.map(async (a) => ({
        key: a.key,
        atMs: Date.parse(a.triggeredAt) - startsAt,
        shownMs: Date.parse(a.shownAt) - startsAt,
        delayMs: a.delayMs,
        message: a.message,
        severity: a.severity,
        picture: a.evidenceFrame ? await this.#keepPicture(clip, a.key, a.evidenceFrame.url) : null,
        caption: a.evidenceFrame?.caption ?? null,
      })),
    );
  }

  async #keepPicture(clip: string, key: string, address: string): Promise<string | null> {
    const reply = await this.#fetch(address);
    if (!reply.ok) return null;
    const dir = join(this.#folder, 'clips', clip, 'evidence');
    await mkdir(dir, { recursive: true });
    const file = `${key.replace(/[^\w-]/g, '_')}.jpg`;
    await writeFile(join(dir, file), new Uint8Array(await reply.arrayBuffer()));
    return file;
  }
}
