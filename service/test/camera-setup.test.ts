import { describe, expect, it } from 'vitest';
import type { Picture } from '../src/sam/client.js';
import type { Outline } from '../src/sam/outlines.js';
import { setUpCamera, type Outliner, type SetupPlanner } from '../src/setup/camera-setup.js';

const picture = (tag: number): Picture => ({ bytes: Uint8Array.of(tag), mimeType: 'image/jpeg' });
const pictures = [
  { label: 'day', picture: picture(1) },
  { label: 'night', picture: picture(2) },
];

function outline(word: string): Outline {
  return { word, objectId: '0', box: { left: 0, top: 0, right: 10, bottom: 10 }, path: 'M0 0L10 0L10 10Z' };
}

// SAM stand-in: `seen` says which words it can outline on which picture (by the picture's tag byte).
function fakeSam(seen: Record<string, number[]>): Outliner & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async outlineAll(pic, words) {
      asked.push(...words);
      return Object.fromEntries(words.map((w) => [w, (seen[w] ?? []).includes(pic.bytes[0]!) ? [outline(w)] : []]));
    },
  };
}

function fakeSpark(overrides: Partial<SetupPlanner> = {}): SetupPlanner {
  return {
    listItems: async () => ['gate', 'kiosk'],
    alternatives: async () => ({}),
    proposeRules: async (zones) => zones.map((z) => ({ sentence: `Alert if the ${z.name} changes.`, zones: [z.name] })),
    ...overrides,
  };
}

describe('setUpCamera', () => {
  it('makes a zone only for the words SAM could outline, and says when each was seen', async () => {
    const sam = fakeSam({ gate: [1, 2], kiosk: [1] });

    const setup = await setUpCamera({ pictures, baseWords: [], sam, spark: fakeSpark() });

    expect(setup.zones.map((z) => [z.name, z.seenAt])).toEqual([
      ['gate', ['day', 'night']],
      ['kiosk', ['day']],
    ]);
    expect(setup.zones[0]!.outlines.night).toHaveLength(1);
  });

  it("adds the industry's base words to what Spark listed, once each", async () => {
    const sam = fakeSam({ wall: [1] });

    const setup = await setUpCamera({ pictures, baseWords: ['Gate', 'wall'], sam, spark: fakeSpark() });

    expect(new Set(sam.asked)).toEqual(new Set(['gate', 'kiosk', 'wall']));
    expect(sam.asked.filter((w) => w === 'gate')).toHaveLength(pictures.length);
    expect(setup.zones.map((z) => z.name)).toEqual(['wall']);
  });

  it("asks Spark for other words when SAM finds nothing, and names the zone by the word that worked", async () => {
    const sam = fakeSam({ gate: [1, 2], 'shop': [1, 2] });
    let askedAbout: string[] = [];
    const spark = fakeSpark({
      alternatives: async (items) => {
        askedAbout = items;
        return { kiosk: ['stall', 'shop'] };
      },
    });

    const setup = await setUpCamera({ pictures, baseWords: [], sam, spark });

    expect(askedAbout).toEqual(['kiosk']);
    expect(setup.zones.map((z) => [z.name, z.item])).toEqual([
      ['gate', 'gate'],
      ['shop', 'kiosk'],
    ]);
    expect(setup.notOutlined).toEqual([]);
  });

  it('reports what Spark saw but SAM could not outline under any word, with the words tried', async () => {
    const sam = fakeSam({ gate: [1] });
    const spark = fakeSpark({ alternatives: async () => ({ kiosk: ['stall'] }) });

    const setup = await setUpCamera({ pictures, baseWords: [], sam, spark });

    expect(setup.notOutlined).toEqual([{ item: 'kiosk', triedWords: ['kiosk', 'stall'] }]);
  });

  it('does not report base words that are simply absent from the view', async () => {
    const sam = fakeSam({ gate: [1] });

    const setup = await setUpCamera({ pictures, baseWords: ['gatehouse'], sam, spark: fakeSpark({ listItems: async () => ['gate'] }) });

    expect(setup.notOutlined).toEqual([]);
  });

  it('keeps only rules whose zones were all outlined', async () => {
    const sam = fakeSam({ gate: [1, 2] });
    const spark = fakeSpark({
      proposeRules: async () => [
        { sentence: 'Alert if the gate is open after 10 pm.', zones: ['gate'] },
        { sentence: 'Alert if anyone stands at the kiosk at night.', zones: ['kiosk'] },
      ],
    });

    const setup = await setUpCamera({ pictures, baseWords: [], sam, spark });

    expect(setup.rules).toEqual([{ sentence: 'Alert if the gate is open after 10 pm.', zones: ['gate'] }]);
  });
});
