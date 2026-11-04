import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FollowTarget, MediaSize } from '../sam/client.js';
import type { Box, FollowedFrame } from '../sam/outlines.js';
import type { ClipFolder } from './clips.js';

export interface Span {
  from: number;
  to: number;
}

export interface Follow {
  id: string;
  name: string;
  frame: number;
  box: Box;
  spans: Span[];
  frames: FollowedFrame[];
}

interface JobProgress {
  names: string[];
  framesDone: number;
  framesTotal: number;
}

export type FollowJob = ({ state: 'running' } & JobProgress) | ({ state: 'done'; follows: Follow[] } & JobProgress) | ({ state: 'failed' } & JobProgress);

export interface FollowModel {
  upload(video: Uint8Array): Promise<string>;
  track(fileId: string, size: MediaSize, frame: number, targets: FollowTarget[], frames: number, onFramesDone: (done: number) => void): Promise<FollowedFrame[][]>;
}

// Tried live with four in one request; the API sets the real limit.
export const MOST_TRACKED_AT_ONCE = 4;
const JOB_ID_JOIN = '+';
export const trackIdsOf = (jobId: string) => jobId.split(JOB_ID_JOIN);

interface Running {
  state: 'running' | 'failed';
  name: string;
  framesDone: number;
  framesTotal: number;
}

type Selected = { name: string; box: Box };

// A thing out of sight for less than this is still the same stretch on the timeline.
const SAME_STRETCH_SECONDS = 1;

export function spansOf(frames: Array<{ frame: number }>, fps: number): Span[] {
  const spans: Span[] = [];
  for (const { frame } of frames) {
    const last = spans[spans.length - 1];
    if (last && frame - last.to <= SAME_STRETCH_SECONDS * fps) last.to = frame;
    else spans.push({ from: frame, to: frame });
  }
  return spans;
}

const followId = (frame: number, box: Box) => `${frame}-${box.left}-${box.top}-${box.right}-${box.bottom}`;

// Follows the selected things in one request, in the background, and keeps each thing's result, so asking again costs nothing.
// A job's id names what it covers, so what a person asked for can be reported whichever request is doing each part of it.
export class Follows {
  readonly #running = new Map<string, Running>();
  readonly #uploaded = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly clips: ClipFolder,
    private readonly sam: FollowModel,
    // Frames tracked before and after the selected one; SAM charges by the frame, so a long clip is tracked around the selection.
    private readonly reachFrames: { before: number; after: number } | null = null,
  ) {}

  // Whether all of this selection has been tracked or is being tracked, so asking again would spend nothing.
  async isKept(clipId: string, frame: number, boxes: Box[]): Promise<boolean> {
    const jobs = await Promise.all(boxes.map((box) => this.get(clipId, followId(frame, box))));
    return jobs.every((job) => job !== null && job.state !== 'failed');
  }

  async start(clipId: string, frame: number, things: Selected[]): Promise<string> {
    const fresh: Selected[] = [];
    for (const thing of things) {
      const id = followId(frame, thing.box);
      if (this.#running.get(`${clipId}/${id}`)?.state === 'running' || (await this.#saved(clipId, id))) continue;
      this.#running.set(`${clipId}/${id}`, { state: 'running', name: thing.name, framesDone: 0, framesTotal: 0 });
      fresh.push(thing);
    }
    if (fresh.length > 0) {
      void this.#follow(clipId, frame, fresh).catch((error: unknown) => {
        console.error(error);
        for (const thing of fresh) this.#running.set(`${clipId}/${followId(frame, thing.box)}`, { state: 'failed', name: thing.name, framesDone: 0, framesTotal: 0 });
      });
    }
    return things.map((thing) => followId(frame, thing.box)).join(JOB_ID_JOIN);
  }

  async get(clipId: string, jobId: string): Promise<FollowJob | null> {
    const parts = await Promise.all(
      jobId.split(JOB_ID_JOIN).map(async (id) => this.#running.get(`${clipId}/${id}`) ?? (await this.#saved(clipId, id))),
    );
    if (parts.some((part) => part === null || part === undefined)) return null;
    const present = parts as Array<Running | Follow>;
    const names = present.map((part) => part.name);
    const running = present.filter((part): part is Running => 'state' in part);
    if (running.some((part) => part.state === 'failed')) return { state: 'failed', names, framesDone: 0, framesTotal: Math.max(...running.map((part) => part.framesTotal)) };
    if (running.length > 0) return { state: 'running', names, framesDone: Math.min(...running.map((part) => part.framesDone)), framesTotal: Math.max(...running.map((part) => part.framesTotal)) };
    const follows = present as Follow[];
    const clip = await this.clips.get(clipId);
    const { from, to } = this.#reach(follows[0]!.frame, clip?.frames ?? 0);
    const framesTotal = to - from + 1;
    return { state: 'done', names, framesDone: framesTotal, framesTotal, follows };
  }

  #reach(frame: number, frames: number): { from: number; to: number } {
    return this.reachFrames === null
      ? { from: 0, to: frames - 1 }
      : { from: Math.max(0, frame - this.reachFrames.before), to: Math.min(frames - 1, frame + this.reachFrames.after) };
  }

  async list(clipId: string): Promise<Follow[]> {
    const dir = join(this.root, 'clips', clipId, 'follows');
    const files = await readdir(dir).catch(() => [] as string[]);
    const saved = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Follow));
    return saved.sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
  }

  async #follow(clipId: string, frame: number, things: Selected[]): Promise<void> {
    const clip = (await this.clips.get(clipId))!;
    const { from, to } = this.#reach(frame, clip.frames);
    const framesTotal = to - from + 1;
    // The last frame is held back, since the results still have to be read and kept after SAM has finished.
    const report = (framesDone: number) => {
      for (const thing of things) this.#running.set(`${clipId}/${followId(frame, thing.box)}`, { state: 'running', name: thing.name, framesDone: Math.min(framesDone, framesTotal - 1), framesTotal });
    };
    report(0);
    const whole = from === 0 && to === clip.frames - 1;
    const uploadKey = `${clipId}/${from}-${to}`;
    const video = async () => (whole ? new Uint8Array(await readFile(clip.video)) : (await this.clips.stretch(clipId, from, to))!);
    const fileId = this.#uploaded.get(uploadKey) ?? (await this.sam.upload(await video()));
    this.#uploaded.set(uploadKey, fileId);
    const tracked = await this.sam
      .track(fileId, { width: clip.width, height: clip.height }, frame - from, things.map((thing) => ({ box: thing.box })), framesTotal, report)
      .catch((error: unknown) => {
        // An upload the API has since dropped would fail every later try, so the next one uploads afresh.
        this.#uploaded.delete(uploadKey);
        throw error;
      });
    const dir = join(this.root, 'clips', clipId, 'follows');
    await mkdir(dir, { recursive: true });
    await Promise.all(
      things.map(async (thing, i) => {
        const id = followId(frame, thing.box);
        const frames = (tracked[i] ?? []).map((f) => ({ ...f, frame: f.frame + from }));
        const follow: Follow = { id, name: thing.name, frame, box: thing.box, spans: spansOf(frames, clip.fps), frames };
        await writeFile(join(dir, `${id}.json`), JSON.stringify(follow));
        this.#running.delete(`${clipId}/${id}`);
      }),
    );
  }

  async #saved(clipId: string, id: string): Promise<Follow | null> {
    const text = await readFile(join(this.root, 'clips', clipId, 'follows', `${id}.json`), 'utf8').catch(() => null);
    return text === null ? null : (JSON.parse(text) as Follow);
  }
}
