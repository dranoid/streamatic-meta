import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { EpisodeLoop, readEpisode } from '../src/live/episode.js';
import type { Frame } from '../src/rules/zone-rule.js';

const jpeg = (shade: number) =>
  sharp({ create: { width: 320, height: 180, channels: 3, background: { r: shade, g: shade, b: shade } } }).jpeg().toBuffer();

describe('readEpisode', () => {
  it('reads a recording kept as gateway batch folders, in the order the pictures were taken', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'episode-'));
    for (const [batch, start] of [['b212245', 15_000], ['b212230', 0]] as const) {
      await mkdir(join(dir, batch));
      const frames = [0, 1].map((k) => ({ file: `00${k + 1}.jpg`, capturedAt: start + k * 1000, width: 320, height: 180 }));
      await writeFile(join(dir, batch, 'manifest.json'), JSON.stringify({ frames }));
      for (const f of frames) await writeFile(join(dir, batch, f.file), await jpeg(start ? 200 : 40));
    }

    const frames = await readEpisode(dir);

    expect(frames.map((f) => f.at)).toEqual([0, 1000, 15_000, 16_000]);
    expect(frames[0]!.gray.width).toBe(160);
  });

  it('reads a recording kept as a video, one picture a second from the time it started', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'episode-'));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=3', '-pix_fmt', 'yuv420p', join(dir, 'recording.mp4')]);
    const startedAt = Date.UTC(2026, 9, 31, 20, 0, 0);
    await writeFile(join(dir, 'episode.json'), JSON.stringify({ startedAt: new Date(startedAt).toISOString() }));

    const frames = await readEpisode(dir);

    expect(frames.map((f) => [f.at - startedAt, f.width, f.height])).toEqual([
      [0, 320, 180],
      [1000, 320, 180],
      [2000, 320, 180],
    ]);
  });
});

describe('EpisodeLoop', () => {
  const recorded = (n: number): Frame[] =>
    Array.from({ length: n }, (_, i) => ({ at: 50_000 + i * 1000, width: 1, height: 1, picture: { bytes: new Uint8Array(), mimeType: 'image/jpeg' }, gray: { width: 1, height: 1, data: new Uint8Array(1) } }));

  it('hands out the recording at the speed it was taken, then plays it again from the start', async () => {
    let now = 0;
    const loop = new EpisodeLoop({ frames: recorded(4), now: () => now, pauseMs: 2000 });
    const times = async () => (await loop.next()).map((f) => f.at - 50_000);

    expect(await times()).toEqual([0]);
    now = 2_500;
    expect(await times()).toEqual([1000, 2000]);
    now = 4_000;
    expect(await times()).toEqual([3000]);
    // The last picture was at 3 s; after a 2 s pause the next pass starts.
    now = 4_900;
    expect(await times()).toEqual([]);
    now = 5_100;
    expect(await times()).toEqual([0]);
    expect(loop.playing?.at).toBe(50_000);
  });
});
