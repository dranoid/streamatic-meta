import { describe, expect, it } from 'vitest';
import type { Picture } from '../src/sam/client.js';
import type { Outline } from '../src/sam/outlines.js';
import { runZoneRule, type Frame, type ZoneRule } from '../src/rules/zone-rule.js';

const LAGOS_2124 = Date.UTC(2026, 9, 28, 20, 24, 0);
const SECOND = 1000;

// Pictures are 100×100; their change-check copies are 10×10, so picture pixels divide by 10.
function frame(at: number, changed: Array<[number, number]> = [], tag = at): Frame {
  const data = new Uint8Array(100).fill(50);
  for (const [x, y] of changed) data[y * 10 + x] = 250;
  return { at, width: 100, height: 100, picture: picture(tag), gray: { width: 10, height: 10, data } };
}

function picture(tag: number): Picture {
  return { bytes: new TextEncoder().encode(String(tag)), mimeType: 'image/jpeg' };
}

const tagOf = (p: Picture) => Number(new TextDecoder().decode(p.bytes));

const doorClosed = { left: 60, top: 20, right: 90, bottom: 80 };
const doorLeaf = { left: 60, top: 20, right: 68, bottom: 80 };

// SAM stand-in: returns the door's box for each picture by its tag, and records what it was asked.
function fakeSam(boxFor: (tag: number) => typeof doorClosed | null) {
  const asked: number[] = [];
  return {
    asked,
    async outlineAll(p: Picture, words: string[]) {
      asked.push(tagOf(p));
      const box = boxFor(tagOf(p));
      const outlines: Outline[] = box ? [{ word: words[0]!, objectId: '0', box, path: '' }] : [];
      return { [words[0]!]: outlines };
    },
  };
}

const doorRule: ZoneRule = {
  sentence: 'Alert me if the front door opens after 9 pm.',
  zone: { name: 'front door', kind: 'outline', word: 'door', reference: doorClosed, path: '' },
  activeHours: { from: 21, to: 6 },
  samples: 3,
  sampleGapMs: 3 * SECOND,
  cooldownMs: 5 * 60 * SECOND,
};

// Ten pictures a second apart; the door moves in the fourth.
function doorFrames(changedAt = 3, start = LAGOS_2124) {
  return Array.from({ length: 10 }, (_, i) => frame(start + i * SECOND, i === changedAt ? [[7, 5]] : []));
}

const run = (rule: ZoneRule, frames: Frame[], sam: ReturnType<typeof fakeSam>, judge?: any) =>
  runZoneRule({ rule, frames, sam, judge, crop: async (p) => p, timeZone: 'Africa/Lagos' });

describe('runZoneRule on a SAM zone', () => {
  it('never calls SAM while nothing changes inside the zone', async () => {
    const sam = fakeSam(() => doorClosed);
    const quiet = Array.from({ length: 10 }, (_, i) => frame(LAGOS_2124 + i * SECOND, [[1, 1]]));

    const result = await run(doorRule, quiet, sam);

    expect(sam.asked).toEqual([]);
    expect(result.alerts).toEqual([]);
  });

  it('alerts when the outline no longer matches the closed door, with the picture that shows it most', async () => {
    const frames = doorFrames();
    const opened = frames[6]!.at;
    const sam = fakeSam((tag) => (tag === opened ? doorLeaf : doorClosed));

    const result = await run(doorRule, frames, sam);

    expect(sam.asked).toEqual([frames[3]!.at, frames[6]!.at, frames[9]!.at]);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.picture?.at).toBe(opened);
    expect(result.alerts[0]!.zone).toBe('front door');
  });

  it('records a check but does not alert when the door is still closed in every picture', async () => {
    const sam = fakeSam(() => doorClosed);

    const result = await run(doorRule, doorFrames(), sam);

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.verdict).toBe(false);
    expect(result.alerts).toEqual([]);
  });

  it('counts the door as changed when SAM no longer finds it where it was', async () => {
    const frames = doorFrames();
    const sam = fakeSam((tag) => (tag === frames[6]!.at ? null : doorClosed));

    const result = await run(doorRule, frames, sam);

    expect(result.alerts[0]!.picture?.at).toBe(frames[6]!.at);
  });

  it('ignores a change outside the rule hours without calling SAM', async () => {
    const sam = fakeSam(() => doorLeaf);

    const result = await run(doorRule, doorFrames(3, Date.UTC(2026, 9, 28, 19, 0, 0)), sam);

    expect(sam.asked).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it('alerts once and stays quiet through the cooldown', async () => {
    const sam = fakeSam((tag) => (tag % 2 === 0 ? doorLeaf : doorLeaf));
    const frames = Array.from({ length: 20 }, (_, i) =>
      frame(LAGOS_2124 + i * SECOND, i === 3 || i === 13 ? [[7, 5]] : []),
    );

    const result = await run(doorRule, frames, sam);

    expect(result.alerts).toHaveLength(1);
    expect(sam.asked).toHaveLength(3);
  });
});

describe('runZoneRule on a box zone', () => {
  const counterRule: ZoneRule = {
    ...doorRule,
    sentence: 'Alert me if anyone is behind the counter after 9 pm.',
    zone: { name: 'behind the counter', kind: 'box', box: doorClosed },
    question: 'Is anyone behind the counter?',
  };

  it("asks the judge about the zone's crops and sends the picture it names", async () => {
    const frames = doorFrames();
    let asked: { question: string; crops: number[] } | undefined;
    const judge = {
      async judge(question: string, crops: Array<{ label: string; picture: Picture }>) {
        asked = { question, crops: crops.map((c) => tagOf(c.picture)) };
        return { answer: true, shownIn: 2 };
      },
    };

    const result = await run(counterRule, frames, fakeSam(() => null), judge);

    expect(asked).toEqual({ question: 'Is anyone behind the counter?', crops: [frames[3]!.at, frames[6]!.at, frames[9]!.at] });
    expect(result.alerts[0]!.picture?.at).toBe(frames[6]!.at);
    expect(result.alerts[0]!.clip).toEqual([]);
  });

  it('offers the moment as a clip when the judge says yes but no single picture shows it', async () => {
    const frames = doorFrames();
    const judge = { judge: async () => ({ answer: true, shownIn: null }) };

    const result = await run(counterRule, frames, fakeSam(() => null), judge);

    expect(result.alerts[0]!.picture).toBeNull();
    expect(result.alerts[0]!.clip.map((f) => f.at)).toEqual(frames.slice(3).map((f) => f.at));
  });
});
