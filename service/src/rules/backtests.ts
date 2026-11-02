import type { Camera } from '../cameras/camera-folder.js';
import { readEpisode } from '../live/episode.js';
import type { Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';
import type { Outliner } from '../setup/camera-setup.js';
import { backtest } from './backtest.js';
import { zoneRule, type NewRule } from './rule-store.js';
import type { BoxJudge, Frame } from './zone-rule.js';

export interface BacktestAlert {
  at: number;
  // The stored picture the alert would have sent, by its time; null when the alert would have been a clip.
  pictureAt: number | null;
  zones: string[];
  // SAM's outline on that picture at each outline zone, as SVG paths.
  outlines: string[];
}

export interface BacktestJob {
  id: number;
  state: 'running' | 'done' | 'failed';
  pictures: number;
  checked: number;
  checks: number;
  alerts: BacktestAlert[];
}

export interface StoredPictures {
  pictures: number;
  from: number;
  to: number;
}

export interface BacktestRunner {
  start(camera: Camera, rule: NewRule): Promise<number>;
  get(id: number): BacktestJob | null;
  summary(camera: Camera): Promise<StoredPictures | null>;
  picture(camera: Camera, at: number): Promise<Uint8Array | null>;
}

// Jobs older than the last this many are forgotten.
const KEPT_JOBS = 50;

// Tries rules on each camera's stored pictures in the background; the pictures are read once and kept in memory.
export class Backtests implements BacktestRunner {
  readonly #frames = new Map<string, Promise<Frame[]>>();
  readonly #jobs = new Map<number, BacktestJob>();
  #nextId = 1;

  constructor(
    private readonly options: {
      sam: Outliner;
      judge: BoxJudge;
      crop: (picture: Picture, box: Box) => Promise<Picture>;
      timeZone: string;
      parts: number;
    },
  ) {}

  async summary(camera: Camera): Promise<StoredPictures | null> {
    const frames = await this.#stored(camera);
    return frames?.length ? { pictures: frames.length, from: frames[0]!.at, to: frames[frames.length - 1]!.at } : null;
  }

  async start(camera: Camera, rule: NewRule): Promise<number> {
    const frames = (await this.#stored(camera)) ?? [];
    const job: BacktestJob = { id: this.#nextId++, state: 'running', pictures: frames.length, checked: 0, checks: 0, alerts: [] };
    this.#jobs.set(job.id, job);
    for (const id of this.#jobs.keys()) if (this.#jobs.size > KEPT_JOBS) this.#jobs.delete(id);
    const { sam, judge, crop, timeZone, parts } = this.options;
    backtest({ rule: zoneRule({ id: 0, ...rule }), frames, sam, judge, crop, timeZone, parts, onProgress: (checked) => (job.checked = checked) }).then(
      (result) => {
        job.checks = result.checks;
        job.alerts = result.alerts.map((a) => ({ at: a.at, pictureAt: a.picture?.at ?? null, zones: a.zones, outlines: a.outlines.map((o) => o.path) }));
        job.state = 'done';
      },
      (error: unknown) => {
        console.error(error);
        job.state = 'failed';
      },
    );
    return job.id;
  }

  get(id: number): BacktestJob | null {
    return this.#jobs.get(id) ?? null;
  }

  async picture(camera: Camera, at: number): Promise<Uint8Array | null> {
    return (await this.#stored(camera))?.find((f) => f.at === at)?.picture.bytes ?? null;
  }

  #stored(camera: Camera): Promise<Frame[]> | null {
    if (!camera.stored) return null;
    if (!this.#frames.has(camera.id)) this.#frames.set(camera.id, readEpisode(camera.stored));
    return this.#frames.get(camera.id)!;
  }
}
