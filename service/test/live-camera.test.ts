import { describe, expect, it } from 'vitest';
import { LiveCamera } from '../src/live/live-camera.js';
import type { SavedRule } from '../src/rules/rule-store.js';
import type { Frame } from '../src/rules/zone-rule.js';
import type { Picture } from '../src/sam/client.js';
import type { Outline } from '../src/sam/outlines.js';

const LAGOS_2124 = Date.UTC(2026, 9, 28, 20, 24, 0);
const SECOND = 1000;
const doorClosed = { left: 60, top: 20, right: 90, bottom: 80 };
const doorLeaf = { left: 60, top: 20, right: 68, bottom: 80 };

// Pictures are 100×100 and a second apart; the door moves in the fourth.
const frames: Frame[] = Array.from({ length: 13 }, (_, i) => {
  const data = new Uint8Array(100).fill(50);
  if (i === 3) data[5 * 10 + 7] = 250;
  const at = LAGOS_2124 + i * SECOND;
  return { at, width: 100, height: 100, picture: { bytes: new TextEncoder().encode(String(at)), mimeType: 'image/jpeg' }, gray: { width: 10, height: 10, data } };
});

const doorRule: SavedRule = {
  id: 1,
  camera: 'table-parlour',
  sentence: 'Alert me if the front door opens after 9 pm.',
  zones: [{ name: 'front door', kind: 'outline', word: 'door', reference: doorClosed, path: '' }],
  activeHours: { from: 21, to: 6 },
};

function fakeSam() {
  const asked: number[] = [];
  return {
    asked,
    async outlineAll(p: Picture, words: string[]) {
      const at = Number(new TextDecoder().decode(p.bytes));
      asked.push(at);
      const outlines: Outline[] = [{ word: 'door', objectId: '0', box: at === frames[6]!.at ? doorLeaf : doorClosed, path: '' }];
      return { [words[0]!]: outlines };
    },
  };
}

// The gateway's batches, one per step.
function live(parts: Frame[][], rules: () => SavedRule[], sam = fakeSam()) {
  const source = { next: async () => parts.shift() ?? [] };
  return new LiveCamera({
    source,
    rules,
    sam,
    crop: async (p) => p,
    timeZone: 'Africa/Lagos',
    timing: { samples: 3, sampleGapMs: 3 * SECOND, cooldownMs: 5 * 60 * SECOND },
    aroundMs: 2 * SECOND,
  });
}

describe('LiveCamera', () => {
  it('alerts once the pictures the check needs have arrived, and keeps the event when the pictures after it have too', async () => {
    const camera = live([frames.slice(0, 5), frames.slice(5, 10), frames.slice(10)], () => [doorRule]);

    const first = await camera.step();
    expect(first.alerts).toEqual([]);

    const second = await camera.step();
    expect(second.alerts.map((a) => [a.rule.id, a.alert.picture?.at])).toEqual([[1, frames[6]!.at]]);
    expect(second.settled).toEqual([]);

    const third = await camera.step();
    expect(third.alerts).toEqual([]);
    expect(third.settled.map((s) => [s.rule.id, s.alert.picture?.at])).toEqual([[1, frames[6]!.at]]);
    expect(third.settled[0]!.around.map((f) => f.at)).toEqual(frames.slice(1, 12).map((f) => f.at));
  });

  it('plays a recording again from the start and alerts on each pass', async () => {
    const camera = live([frames, frames], () => [doorRule]);

    const first = await camera.step();
    const second = await camera.step();

    expect(first.alerts.map((a) => a.alert.picture?.at)).toEqual([frames[6]!.at]);
    expect(second.alerts.map((a) => a.alert.picture?.at)).toEqual([frames[6]!.at]);
  });

  it('starts a rule saved while it runs on the pictures that arrive after it', async () => {
    let rules: SavedRule[] = [];
    const sam = fakeSam();
    const camera = live([frames.slice(0, 10), frames.slice(10)], () => rules, sam);

    await camera.step();
    rules = [doorRule];
    const after = await camera.step();

    expect(after.alerts).toEqual([]);
    expect(sam.asked).toEqual([]);
  });
});
