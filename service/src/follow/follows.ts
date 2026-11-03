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

export type FollowJob =
  | { state: 'running'; name: string; framesSeen: number }
  | { state: 'done'; name: string; framesSeen: number; follow: Follow }
  | { state: 'failed'; name: string; framesSeen: number };

export interface FollowModel {
  upload(video: Uint8Array): Promise<string>;
  track(fileId: string, size: MediaSize, frame: number, target: FollowTarget, onFrames: (seen: number) => void): Promise<FollowedFrame[]>;
}

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

// Follows one selected thing at a time per selection, in the background, and keeps each result, so asking again costs nothing.
export class Follows {
  readonly #running = new Map<string, FollowJob>();
  readonly #uploaded = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly clips: ClipFolder,
    private readonly sam: FollowModel,
  ) {}

  async start(clipId: string, frame: number, thing: { name: string; box: Box }): Promise<string> {
    const id = `${frame}-${thing.box.left}-${thing.box.top}-${thing.box.right}-${thing.box.bottom}`;
    const key = `${clipId}/${id}`;
    if (this.#running.get(key)?.state === 'running' || (await this.#saved(clipId, id))) return id;
    this.#running.set(key, { state: 'running', name: thing.name, framesSeen: 0 });
    void this.#follow(clipId, id, frame, thing).catch((error: unknown) => {
      console.error(error);
      this.#running.set(key, { state: 'failed', name: thing.name, framesSeen: 0 });
    });
    return id;
  }

  async get(clipId: string, id: string): Promise<FollowJob | null> {
    const job = this.#running.get(`${clipId}/${id}`);
    if (job && job.state !== 'done') return job;
    const follow = await this.#saved(clipId, id);
    return follow ? { state: 'done', name: follow.name, framesSeen: follow.frames.length, follow } : null;
  }

  async list(clipId: string): Promise<Follow[]> {
    const dir = join(this.root, 'clips', clipId, 'follows');
    const files = await readdir(dir).catch(() => [] as string[]);
    const saved = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Follow));
    return saved.sort((a, b) => a.frame - b.frame || a.id.localeCompare(b.id));
  }

  async #follow(clipId: string, id: string, frame: number, thing: { name: string; box: Box }): Promise<void> {
    const key = `${clipId}/${id}`;
    const clip = (await this.clips.get(clipId))!;
    const fileId = this.#uploaded.get(clipId) ?? (await this.sam.upload(new Uint8Array(await readFile(clip.video))));
    this.#uploaded.set(clipId, fileId);
    const frames = await this.sam
      .track(fileId, { width: clip.width, height: clip.height }, frame, { box: thing.box }, (framesSeen) => {
        this.#running.set(key, { state: 'running', name: thing.name, framesSeen });
      })
      .catch((error: unknown) => {
        // An upload the API has since dropped would fail every later try, so the next one uploads afresh.
        this.#uploaded.delete(clipId);
        throw error;
      });
    const follow: Follow = { id, name: thing.name, frame, box: thing.box, spans: spansOf(frames, clip.fps), frames };
    const dir = join(this.root, 'clips', clipId, 'follows');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), JSON.stringify(follow));
    this.#running.set(key, { state: 'done', name: thing.name, framesSeen: frames.length, follow });
  }

  async #saved(clipId: string, id: string): Promise<Follow | null> {
    const text = await readFile(join(this.root, 'clips', clipId, 'follows', `${id}.json`), 'utf8').catch(() => null);
    return text === null ? null : (JSON.parse(text) as Follow);
  }
}
