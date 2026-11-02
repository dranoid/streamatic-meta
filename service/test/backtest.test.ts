import { describe, expect, it } from 'vitest';
import { backtest } from '../src/rules/backtest.js';
import { runZoneRule, type Frame, type ZoneRule } from '../src/rules/zone-rule.js';
import type { Picture } from '../src/sam/client.js';
import type { Outline } from '../src/sam/outlines.js';

const LAGOS_2300 = Date.UTC(2026, 9, 28, 22, 0, 0);
const SECOND = 1000;
const gateClosed = { left: 60, top: 20, right: 90, bottom: 80 };
const gateOpen = { left: 60, top: 20, right: 68, bottom: 80 };

// Thirty pictures a second apart, 100×100 with 10×10 change-check copies; the gate moves in the pictures named.
function pictures(movedAt: number[]): Frame[] {
  return Array.from({ length: 30 }, (_, i) => {
    const data = new Uint8Array(100).fill(50);
    if (movedAt.includes(i)) data[5 * 10 + 7] = 250;
    const at = LAGOS_2300 + i * SECOND;
    return { at, width: 100, height: 100, picture: { bytes: new TextEncoder().encode(String(at)), mimeType: 'image/jpeg' }, gray: { width: 10, height: 10, data } };
  });
}

// SAM finds the gate open on the pictures that moved.
function fakeSam(frames: Frame[], movedAt: number[]) {
  const open = new Set(movedAt.map((i) => frames[i]!.at));
  return {
    async outlineAll(p: Picture, words: string[]) {
      const at = Number(new TextDecoder().decode(p.bytes));
      const outlines: Outline[] = [{ word: 'gate', objectId: '0', box: open.has(at) ? gateOpen : gateClosed, path: '' }];
      return { [words[0]!]: outlines };
    },
  };
}

const gateRule = (cooldownMs: number): ZoneRule => ({
  sentence: 'Alert me if the gate opens after 10 pm.',
  zones: [{ name: 'gate', kind: 'outline', word: 'gate', reference: gateClosed, path: '' }],
  activeHours: { from: 22, to: 6 },
  samples: 1,
  sampleGapMs: 0,
  cooldownMs,
});

const common = { crop: async (p: Picture) => p, timeZone: 'Africa/Lagos' };

describe('backtest', () => {
  it('finds the same alerts in parts run side by side as in one pass over the stored pictures', async () => {
    const moved = [5, 15, 25];
    const frames = pictures(moved);
    const whole = await runZoneRule({ ...common, rule: gateRule(0), frames, sam: fakeSam(frames, moved) });

    const result = await backtest({ ...common, rule: gateRule(0), frames, sam: fakeSam(frames, moved), parts: 3 });

    expect(result.alerts.map((a) => a.at)).toEqual(whole.alerts.map((a) => a.at));
    expect(result.alerts.map((a) => a.at)).toEqual(moved.map((i) => frames[i]!.at));
  });

  it('keeps the quiet time after an alert across the edge between two parts', async () => {
    const moved = [9, 11];
    const frames = pictures(moved);
    const whole = await runZoneRule({ ...common, rule: gateRule(5 * SECOND), frames, sam: fakeSam(frames, moved) });

    const result = await backtest({ ...common, rule: gateRule(5 * SECOND), frames, sam: fakeSam(frames, moved), parts: 3 });

    expect(whole.alerts.map((a) => a.at)).toEqual([frames[9]!.at]);
    expect(result.alerts.map((a) => a.at)).toEqual([frames[9]!.at]);
  });

  it('alerts once for a gate that opens in one part and is still open in the next', async () => {
    const frames = pictures([8, 12]);
    const open = new Set(frames.slice(8, 16).map((f) => f.at));
    const sam = {
      async outlineAll(p: Picture, words: string[]) {
        const at = Number(new TextDecoder().decode(p.bytes));
        return { [words[0]!]: [{ word: 'gate', objectId: '0', box: open.has(at) ? gateOpen : gateClosed, path: '' }] };
      },
    };
    const whole = await runZoneRule({ ...common, rule: gateRule(0), frames, sam });

    const result = await backtest({ ...common, rule: gateRule(0), frames, sam, parts: 3 });

    expect(whole.alerts.map((a) => a.at)).toEqual([frames[8]!.at]);
    expect(result.alerts.map((a) => a.at)).toEqual([frames[8]!.at]);
  });

  it('reports how far through the stored pictures it has checked, ending at the last', async () => {
    const frames = pictures([5]);
    const reached: number[] = [];

    await backtest({ ...common, rule: gateRule(0), frames, sam: fakeSam(frames, [5]), parts: 2, onProgress: (checked) => reached.push(checked) });

    expect(reached[reached.length - 1]).toBe(frames.length);
  });
});
