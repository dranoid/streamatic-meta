import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { outlinesFromText } from '../src/sam/outlines.js';

const amosuNightGate = readFileSync(new URL('./fixtures/amosu-night-gate.txt', import.meta.url), 'utf8');

function pathPoints(path: string): Array<[number, number]> {
  return [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('outlinesFromText', () => {
  it('returns one outline per object SAM found, with its box', async () => {
    const { outlines } = await outlinesFromText('gate', amosuNightGate);

    expect(outlines.map((o) => o.box)).toEqual([
      { left: 13, top: 146, right: 88, bottom: 309 },
      { left: 167, top: 193, right: 478, bottom: 431 },
    ]);
    expect(outlines.every((o) => o.word === 'gate')).toBe(true);
  });

  it('places each outline in picture pixels, inside its own box', async () => {
    const { outlines } = await outlinesFromText('gate', amosuNightGate);

    expect(outlines).toHaveLength(2);
    for (const outline of outlines) {
      const points = pathPoints(outline.path);
      expect(points.length).toBeGreaterThan(10);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThanOrEqual(outline.box.left - 1);
        expect(x).toBeLessThanOrEqual(outline.box.right);
        expect(y).toBeGreaterThanOrEqual(outline.box.top - 1);
        expect(y).toBeLessThanOrEqual(outline.box.bottom);
      }
    }
  });

  it('returns no outlines when SAM found nothing', async () => {
    const { outlines, diagnostics } = await outlinesFromText('fire extinguisher', '');

    expect(outlines).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});
