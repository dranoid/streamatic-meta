import type { MediaSize, Picture } from '../sam/client.js';
import { boxOverlap, withoutSpecks, type Box, type Outline } from '../sam/outlines.js';
import type { ClipThings } from './things.js';

const STEP_SECONDS = 30;
const MOST_LOOKS = 12;
// Two names for one thing outline nearly the same box.
const SAME_THING = 0.8;
// An item that has not moved, outlined on another frame. Lower than SAME_THING, since someone in front of it changes what shows.
const SAME_PLACE = 0.5;

// The paused frame, then outward from it, nearest first, since a track runs around the frame the item is on.
export function framesToLook(frame: number, frames: number, fps: number, most: number): number[] {
  const step = STEP_SECONDS * fps;
  const order = [frame];
  for (let away = step; order.length < most && (frame - away >= 0 || frame + away < frames); away += step) {
    if (frame - away >= 0) order.push(frame - away);
    if (frame + away < frames && order.length < most) order.push(frame + away);
  }
  return order;
}

function separate(outlines: Outline[]): Outline[] {
  return outlines.filter((outline, i) => !outlines.slice(0, i).some((earlier) => boxOverlap(earlier.box, outline.box) >= SAME_THING));
}

export interface FindItemOptions {
  clip: string;
  frame: number;
  frames: number;
  fps: number;
  size: MediaSize;
  item: string;
  words: string[];
  picture: (frame: number) => Promise<Picture | null>;
  outlineAll: (picture: Picture, words: string[]) => Promise<Record<string, Outline[]>>;
  outlineIn: (picture: Picture, size: MediaSize, box: Box, name: string) => Promise<Outline | null>;
  things: Pick<ClipThings, 'list' | 'add'>;
  charge: () => Promise<void>;
}

// Searches for an item by name from the paused frame outward. SAM can miss a word on one frame and find it on another with the
// item in the same place, so an item found elsewhere is asked for again on the paused frame by its box.
export async function findItem({ clip, frame, frames, fps, size, item, words, picture, outlineAll, outlineIn, things, charge }: FindItemOptions): Promise<{ frame: number; found: string[]; looks: number }> {
  const kept = (await things.list(clip, frame)).filter((t) => t.name === item);
  if (kept.length > 0) return { frame, found: kept.map((t) => t.id), looks: 0 };

  let looks = 0;
  for (const looked of framesToLook(frame, frames, fps, MOST_LOOKS)) {
    const seen = await picture(looked);
    if (!seen) continue;
    await charge();
    looks += 1;
    const outlines = separate(Object.values(await outlineAll(seen, words)).flat().map((o) => withoutSpecks({ ...o, word: item })));
    if (outlines.length === 0) continue;

    let onFrame = looked;
    let placed = outlines;
    const paused = looked === frame ? null : await picture(frame);
    if (paused) {
      await charge();
      looks += 1;
      const stillThere = (await Promise.all(outlines.map((o) => outlineIn(paused, size, o.box, item)))).filter(
        (o, i): o is Outline => o !== null && boxOverlap(o.box, outlines[i]!.box) >= SAME_PLACE,
      );
      if (stillThere.length > 0) {
        onFrame = frame;
        placed = stillThere.map((o) => withoutSpecks(o));
      }
    }
    const all = await things.add(clip, onFrame, placed);
    return { frame: onFrame, found: all.filter((t) => placed.some((o) => boxOverlap(t.box, o.box) >= SAME_THING)).map((t) => t.id), looks };
  }
  return { frame, found: [], looks };
}
