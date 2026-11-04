import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ClipDetections } from './detections.js';

// What the detector deployed from service/modal/detect.py offers. A result of null means it is still running.
export interface DetectionClient {
  start(video: Uint8Array<ArrayBuffer>): Promise<string>;
  result(call: string): Promise<ClipDetections | null>;
}

const detections = z.object({
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  tracks: z.array(z.object({ id: z.number(), kind: z.string(), points: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()])) })),
});

export function detectionClient({ url, secret, fetch: fetchImpl = fetch }: { url: string; secret: string; fetch?: typeof fetch }): DetectionClient {
  const headers = { 'x-detect-secret': secret };
  return {
    async start(video) {
      const reply = await fetchImpl(`${url}/start`, { method: 'POST', headers, body: video });
      if (!reply.ok) throw new Error(`The detector refused the clip with status ${reply.status}`);
      return z.object({ call: z.string() }).parse(await reply.json()).call;
    },
    async result(call) {
      const reply = await fetchImpl(`${url}/result/${encodeURIComponent(call)}`, { headers });
      if (reply.status === 202) return null;
      if (!reply.ok) throw new Error(`The detector failed with status ${reply.status}`);
      return detections.parse(await reply.json());
    },
  };
}

export type DetectionState = 'none' | 'running' | 'ready' | 'failed';

const POLL_MS = 5_000;
// Each run is paid for on Modal, so a clip that keeps failing stops being tried.
const MOST_RUNS_PER_CLIP = 3;

// This stands in for a detector running live: each clip is detected once and what was found is recorded beside it, then read back
// on every start, because a Modal GPU could not be set up in time and each CPU run costs money. The agent still asks its questions
// live over those tracks, and a visitor's own zones come in only when a question is counted.
export class ClipDetection {
  readonly #client: DetectionClient | null;
  readonly #videoOf: (clip: string) => string;
  readonly #savedOf: (clip: string) => string;
  readonly #pollMs: number;
  readonly #clips = new Map<string, { state: DetectionState; runs: number; found: ClipDetections | null }>();

  constructor({ client, videoOf, savedOf, pollMs = POLL_MS }: { client: DetectionClient | null; videoOf: (clip: string) => string; savedOf: (clip: string) => string; pollMs?: number }) {
    this.#client = client;
    this.#videoOf = videoOf;
    this.#savedOf = savedOf;
    this.#pollMs = pollMs;
  }

  state(clip: string): DetectionState {
    return this.#clips.get(clip)?.state ?? 'none';
  }

  found(clip: string): ClipDetections | null {
    return this.#clips.get(clip)?.found ?? null;
  }

  // Starts a clip not yet detected, or one whose last run failed. Safe to call as often as a question arrives.
  ensure(clip: string): void {
    const held = this.#clips.get(clip) ?? { state: 'none' as DetectionState, runs: 0, found: null };
    if (held.state === 'running' || held.state === 'ready' || held.runs >= MOST_RUNS_PER_CLIP) return;
    held.state = 'running';
    held.runs += 1;
    this.#clips.set(clip, held);
    void this.#run(clip, held).catch((error: unknown) => {
      held.state = 'failed';
      console.error(`Detecting ${clip}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async #run(clip: string, held: { state: DetectionState; found: ClipDetections | null }): Promise<void> {
    const saved = await readFile(this.#savedOf(clip), 'utf8').catch(() => null);
    if (saved !== null) {
      held.found = detections.parse(JSON.parse(saved));
      held.state = 'ready';
      return;
    }
    if (!this.#client) {
      held.state = 'none';
      return;
    }
    const call = await this.#client.start(new Uint8Array(await readFile(this.#videoOf(clip))));
    for (;;) {
      const found = await this.#client.result(call);
      if (found) {
        await writeFile(this.#savedOf(clip), JSON.stringify(found));
        held.found = found;
        held.state = 'ready';
        return;
      }
      await new Promise((done) => setTimeout(done, this.#pollMs));
    }
  }
}
