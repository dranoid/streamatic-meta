import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// H.264 in yuv420p with even dimensions, so the clip plays inline on phones.
export async function makeClip(jpegs: Uint8Array[], picturesPerSecond: number): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'streamatic-clip-'));
  try {
    await Promise.all(jpegs.map((jpeg, i) => writeFile(join(dir, `${String(i).padStart(4, '0')}.jpg`), jpeg)));
    const out = join(dir, 'clip.mp4');
    await run('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-framerate', String(picturesPerSecond),
      '-i', join(dir, '%04d.jpg'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264', '-movflags', '+faststart',
      out,
    ]);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
