import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import { pictureFrame } from '../rules/frame.js';
import type { Frame } from '../rules/zone-rule.js';
import type { PictureSource } from './live-camera.js';

const run = promisify(execFile);
const VIDEO = /\.(mp4|mov|m4v)$/i;
// The gateway takes one picture a second, so a video is cut at the same rate.
const PICTURES_PER_SECOND = 1;
const manifest = z.object({
  frames: z.array(z.object({ file: z.string(), capturedAt: z.number(), width: z.number(), height: z.number() })),
});
const episodeInfo = z.object({ startedAt: z.iso.datetime({ offset: true }) });

// A recording is a video with episode.json giving when it started, or gateway batch folders, each with its manifest.json.
export async function readEpisode(dir: string): Promise<Frame[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const video = entries.find((e) => e.isFile() && VIDEO.test(e.name));
  if (video) {
    const { startedAt } = episodeInfo.parse(JSON.parse(await readFile(join(dir, 'episode.json'), 'utf8')));
    return readVideo(join(dir, video.name), Date.parse(startedAt));
  }
  const batches = entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  const frames = (await Promise.all([dir, ...batches].map(readBatchFolder))).flat();
  return frames.sort((a, b) => a.at - b.at);
}

async function readBatchFolder(dir: string): Promise<Frame[]> {
  const listed = await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null);
  if (listed === null) return [];
  const { frames } = manifest.parse(JSON.parse(listed));
  return Promise.all(
    frames.map(async (f) => pictureFrame({ bytes: new Uint8Array(await readFile(join(dir, f.file))), at: f.capturedAt, width: f.width, height: f.height })),
  );
}

async function readVideo(path: string, startedAt: number): Promise<Frame[]> {
  const dir = await mkdtemp(join(tmpdir(), 'streamatic-episode-'));
  try {
    await run('ffmpeg', ['-loglevel', 'error', '-i', path, '-vf', `fps=${PICTURES_PER_SECOND}`, '-q:v', '3', join(dir, '%05d.jpg')]);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    return Promise.all(
      files.map(async (file, i) => {
        const bytes = new Uint8Array(await readFile(join(dir, file)));
        const { width = 0, height = 0 } = await sharp(bytes).metadata();
        return pictureFrame({ bytes, at: startedAt + (i * 1000) / PICTURES_PER_SECOND, width, height });
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Plays a recording at the speed it was taken, then again from the start after a pause; pictures keep their recorded times.
export class EpisodeLoop implements PictureSource {
  readonly #frames: Frame[];
  readonly #now: () => number;
  readonly #pauseMs: number;
  #passStart: number | null = null;
  #handed = 0;

  constructor({ frames, now = Date.now, pauseMs = 5_000 }: { frames: Frame[]; now?: () => number; pauseMs?: number }) {
    this.#frames = frames;
    this.#now = now;
    this.#pauseMs = pauseMs;
  }

  get playing(): Frame | null {
    return this.#handed > 0 ? this.#frames[this.#handed - 1]! : null;
  }

  async next(): Promise<Frame[]> {
    const first = this.#frames[0];
    if (!first) return [];
    const now = this.#now();
    this.#passStart ??= now;
    const length = this.#frames[this.#frames.length - 1]!.at - first.at;
    if (this.#handed === this.#frames.length && now - this.#passStart >= length + this.#pauseMs) {
      this.#passStart = now;
      this.#handed = 0;
    }
    const elapsed = now - this.#passStart;
    const start = this.#handed;
    while (this.#handed < this.#frames.length && this.#frames[this.#handed]!.at - first.at <= elapsed) this.#handed++;
    return this.#frames.slice(start, this.#handed);
  }
}
