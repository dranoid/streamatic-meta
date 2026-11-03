import type { RuleBackend, StoredAsk } from './client.js';

export interface TrialView {
  state: 'running' | 'done' | 'failed';
  read: number;
  total: number;
  // Each time the answer would have become true; a stretch's picture is served by its index, never by its signed address.
  stretches: Array<{ from: number; to: number; picture: number | null }>;
}

const FINISHED: Record<string, TrialView['state']> = { completed: 'done', failed: 'failed', stopped: 'failed' };

// Asks a draft's question over stored pictures through the backend's replay. Nothing is saved or sent.
export class Trials {
  readonly #finished = new Map<string, TrialView>();
  readonly #pictures = new Map<string, Uint8Array[]>();

  constructor(
    private readonly backend: Pick<RuleBackend, 'startQuestion' | 'replay'>,
    private readonly download: (url: string) => Promise<Uint8Array | null>,
  ) {}

  start(ask: StoredAsk, sentence: string, confirmedCostMicroUsd: number | null): Promise<string> {
    return this.backend.startQuestion(ask, sentence, confirmedCostMicroUsd);
  }

  async view(id: string): Promise<TrialView> {
    const kept = this.#finished.get(id);
    if (kept) return kept;
    const replay = await this.backend.replay(id);
    const state = FINISHED[replay.status] ?? 'running';
    const pictures: Uint8Array[] = [];
    const stretches: TrialView['stretches'] = [];
    for (const stretch of replay.stretches ?? []) {
      const bytes = state === 'done' && stretch.frameUrl ? await this.download(stretch.frameUrl) : null;
      if (bytes) pictures.push(bytes);
      stretches.push({ from: Date.parse(stretch.startIso), to: Date.parse(stretch.endIso), picture: bytes ? pictures.length - 1 : null });
    }
    const coverage = replay.counted?.coverage;
    const view: TrialView = { state, read: coverage?.framesRead ?? 0, total: coverage?.framesRecorded ?? 0, stretches };
    if (state !== 'running') {
      this.#finished.set(id, view);
      this.#pictures.set(id, pictures);
    }
    return view;
  }

  // A finished trial's stretches with their pictures, each under a key of its own; empty until it has finished well.
  stretches(id: string): Array<{ key: string; from: number; bytes: Uint8Array | null }> {
    const view = this.#finished.get(id);
    if (view?.state !== 'done') return [];
    return view.stretches.map((s) => ({ key: `${id}-${s.from}`, from: s.from, bytes: s.picture === null ? null : this.picture(id, s.picture) }));
  }

  picture(id: string, index: number): Uint8Array | null {
    return this.#pictures.get(id)?.[index] ?? null;
  }
}
