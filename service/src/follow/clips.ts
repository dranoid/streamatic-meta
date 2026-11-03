import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Clip {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  // The file on disk; kept off what the browser is sent.
  video: string;
}

// One folder per clip under <root>/clips: clip.json naming it and its video file.
export class ClipFolder {
  readonly #read = new Map<string, Clip>();

  constructor(private readonly root: string) {}

  async list(): Promise<Clip[]> {
    const ids = await readdir(join(this.root, 'clips')).catch(() => [] as string[]);
    const clips = await Promise.all(ids.sort().map((id) => this.get(id)));
    return clips.filter((c): c is Clip => c !== null);
  }

  async get(id: string): Promise<Clip | null> {
    if (basename(id) !== id || id.startsWith('.')) return null;
    const known = this.#read.get(id);
    if (known) return known;
    const dir = join(this.root, 'clips', id);
    const config = await readFile(join(dir, 'clip.json'), 'utf8').catch(() => null);
    if (config === null) return null;
    const { name, video } = JSON.parse(config) as { name: string; video: string };
    const path = join(dir, basename(video));
    const { stdout } = await run('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_packets', '-of', 'json', path]);
    const stream = (JSON.parse(stdout) as { streams: Array<{ width: number; height: number; r_frame_rate: string; nb_read_packets: string }> }).streams[0]!;
    const [over, under] = stream.r_frame_rate.split('/').map(Number);
    const clip = { id, name, width: stream.width, height: stream.height, fps: over! / (under ?? 1), frames: Number(stream.nb_read_packets), video: path };
    this.#read.set(id, clip);
    return clip;
  }

  // The frame by its number in the video, which is what SAM counts, so an outline drawn on it lands where SAM saw it.
  async picture(id: string, frame: number): Promise<Uint8Array | null> {
    const clip = await this.get(id);
    if (!clip || !Number.isInteger(frame) || frame < 0 || frame >= clip.frames) return null;
    const dir = join(this.root, 'clips', id, 'frames');
    const file = join(dir, `${frame}.jpg`);
    if (!(await stat(file).catch(() => null))) {
      await mkdir(dir, { recursive: true });
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', clip.video, '-vf', `select=eq(n\\,${frame})`, '-vsync', '0', '-frames:v', '1', '-q:v', '2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
      await writeFile(file, stdout);
    }
    return new Uint8Array(await readFile(file));
  }
}
