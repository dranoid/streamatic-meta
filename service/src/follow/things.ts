import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boxOverlap, type Box, type Outline } from '../sam/outlines.js';

export interface Thing {
  id: string;
  name: string;
  box: Box;
  path: string;
}

// Two words for one thing outline nearly the same box; it stays one thing on the frame, under the first word.
const SAME_THING = 0.8;

// What has been outlined on a frame of a clip. Every search adds to it, so results accumulate on the one frame.
export class ClipThings {
  constructor(private readonly root: string) {}

  async list(clip: string, frame: number): Promise<Thing[]> {
    return JSON.parse(await readFile(this.#file(clip, frame), 'utf8').catch(() => '[]')) as Thing[];
  }

  async add(clip: string, frame: number, outlines: Outline[]): Promise<Thing[]> {
    const things = await this.list(clip, frame);
    let next = things.reduce((highest, t) => Math.max(highest, Number(t.id)), 0) + 1;
    for (const { word, box, path } of outlines) {
      if (things.some((t) => boxOverlap(t.box, box) >= SAME_THING)) continue;
      things.push({ id: String(next++), name: word, box, path });
    }
    const file = this.#file(clip, frame);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(things));
    return things;
  }

  #file(clip: string, frame: number): string {
    return join(this.root, 'clips', clip, 'things', `${frame}.json`);
  }
}
