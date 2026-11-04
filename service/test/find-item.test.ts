import { describe, expect, it } from 'vitest';
import { findItem, framesToLook } from '../src/follow/find-item.js';
import type { Thing } from '../src/follow/things.js';
import { boxOverlap, type Box, type Outline } from '../src/sam/outlines.js';

const bag: Box = { left: 100, top: 100, right: 200, bottom: 200 };
const other: Box = { left: 400, top: 100, right: 500, bottom: 200 };
const outline = (word: string, box: Box): Outline => ({ word, objectId: '0', box, path: `M${box.left} ${box.top}L${box.right} ${box.bottom}Z` });

// A clip of 10 fps where a word finds the item only on the frames given.
function clip({ foundOn, onFrame = [bag], inBox = (box: Box) => box as Box | null }: { foundOn: number[]; onFrame?: Box[]; inBox?: (box: Box, frame: number) => Box | null }) {
  const held = new Map<number, Thing[]>();
  const looked: number[] = [];
  const asked: Array<{ frame: number; box: Box }> = [];
  let charges = 0;
  const frameOf = (picture: { bytes: Uint8Array }) => new DataView(picture.bytes.buffer).getUint32(0);
  const run = (frame: number, frames = 3000, words = ['bag', 'backpack'], limit = Infinity) =>
    findItem({
      clip: 'yard',
      frame,
      frames,
      fps: 10,
      size: { width: 1280, height: 720 },
      item: 'bag',
      words,
      picture: async (f) => {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, f);
        return { bytes, mimeType: 'image/jpeg' };
      },
      outlineAll: async (picture, asking) => {
        const f = frameOf(picture);
        looked.push(f);
        return Object.fromEntries(asking.map((w) => [w, foundOn.includes(f) ? onFrame.map((b) => outline(w, b)) : []]));
      },
      outlineIn: async (picture, _size, box, name) => {
        const f = frameOf(picture);
        asked.push({ frame: f, box });
        const placed = inBox(box, f);
        return placed ? outline(name, placed) : null;
      },
      things: {
        list: async (_clip, f) => held.get(f) ?? [],
        add: async (_clip, f, outlines) => {
          const all = held.get(f) ?? [];
          for (const o of outlines) if (!all.some((t) => boxOverlap(t.box, o.box) >= 0.8)) all.push({ id: String(all.length + 1), name: o.word, box: o.box, path: o.path });
          held.set(f, all);
          return all;
        },
      },
      charge: async () => {
        if (++charges > limit) throw new Error('limit');
      },
    });
  return { run, looked, asked, charged: () => charges, held };
}

describe('framesToLook', () => {
  it('starts on the paused frame and goes outward every 30 seconds, nearest first', () => {
    expect(framesToLook(1000, 3000, 10, 6)).toEqual([1000, 700, 1300, 400, 1600, 100]);
  });
  it('stays inside the clip, and takes the other side when one runs out', () => {
    expect(framesToLook(100, 1000, 10, 12)).toEqual([100, 400, 700]);
  });
});

describe('findItem', () => {
  it('finds the item on the paused frame with one look, under the name the person gave it', async () => {
    const c = clip({ foundOn: [1000] });
    expect(await c.run(1000)).toEqual({ frame: 1000, found: ['1'], looks: 1 });
    expect(c.looked).toEqual([1000]);
    expect(c.charged()).toBe(1);
    expect(c.held.get(1000)![0]!.name).toBe('bag');
  });

  it('returns every separate item it found, so the person can select', async () => {
    const c = clip({ foundOn: [1000], onFrame: [bag, other] });
    expect((await c.run(1000)).found).toEqual(['1', '2']);
  });

  it('looks further through the clip when the item is not on the paused frame, each look charged', async () => {
    const c = clip({ foundOn: [700], inBox: () => null });
    expect(await c.run(1000)).toEqual({ frame: 700, found: ['1'], looks: 3 });
    expect(c.looked).toEqual([1000, 700]);
    expect(c.charged()).toBe(3);
  });

  it('brings the item back to the paused frame when it is still in that place there, since tracking runs around the frame it is on', async () => {
    const c = clip({ foundOn: [700] });
    expect(await c.run(1000)).toEqual({ frame: 1000, found: ['1'], looks: 3 });
    expect(c.asked).toEqual([{ frame: 1000, box: bag }]);
  });

  it('stays on the frame it was found on when something else is in that place on the paused frame', async () => {
    const c = clip({ foundOn: [700], inBox: () => other });
    expect((await c.run(1000)).frame).toBe(700);
  });

  it('asks for the paused frame once per separate item, not once per word', async () => {
    const c = clip({ foundOn: [700] });
    await c.run(1000);
    expect(c.asked).toHaveLength(1);
  });

  it('says so when no look found it, within the cap', async () => {
    const c = clip({ foundOn: [] });
    expect(await c.run(1000, 30000)).toEqual({ frame: 1000, found: [], looks: 12 });
    expect(c.looked).toHaveLength(12);
  });

  it('spends nothing when the item is already kept on the paused frame', async () => {
    const c = clip({ foundOn: [1000] });
    await c.run(1000);
    expect(await c.run(1000)).toEqual({ frame: 1000, found: ['1'], looks: 0 });
    expect(c.charged()).toBe(1);
  });

  it('stops at the limit rather than looking further', async () => {
    const c = clip({ foundOn: [] });
    await expect(c.run(1000, 3000, ['bag'], 2)).rejects.toThrow('limit');
    expect(c.looked).toHaveLength(2);
  });
});
