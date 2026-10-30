import { describe, expect, it } from 'vitest';
import { cameraZones, zoneAt, type CameraZone } from '../src/cameras/camera-zones.js';
import type { Outline } from '../src/sam/outlines.js';
import type { CameraSetup } from '../src/setup/camera-setup.js';

const front = { left: 864, top: 317, right: 1063, bottom: 593 };
const store = { left: 381, top: 306, right: 438, bottom: 720 };
const tv = { left: 500, top: 200, right: 640, bottom: 300 };
const nudge = (b: typeof front, by: number) => ({ left: b.left + by, top: b.top + by, right: b.right + by, bottom: b.bottom + by });
const outline = (word: string, objectId: string, box: typeof front): Outline => ({ word, objectId, box, path: `M${box.left} ${box.top}Z` });
const ids = (zone: CameraZone) => Object.fromEntries(Object.entries(zone.outlines).map(([label, os]) => [label, os.map((o) => o.objectId)]));

// SAM numbers its outlines afresh on each picture, so the store door is 1 by day and 0 at night.
const setup: CameraSetup = {
  zones: [
    {
      name: 'door',
      item: 'door',
      seenAt: ['day', 'evening', 'night'],
      outlines: {
        day: [outline('door', '0', front), outline('door', '1', store)],
        evening: [outline('door', '0', nudge(front, 3))],
        night: [outline('door', '0', nudge(store, -2)), outline('door', '1', nudge(front, 5))],
      },
    },
    { name: 'television', item: 'television', seenAt: ['day'], outlines: { day: [outline('television', '0', tv)] } },
  ],
  notOutlined: [],
  rules: [],
};

describe('cameraZones', () => {
  it('matches each thing across the pictures by its position, so two doors are two zones', () => {
    const doors = cameraZones(setup, []).filter((z) => z.word === 'door');
    expect(doors.map((z) => z.name)).toEqual(['door 1', 'door 2']);
    expect(ids(doors[0]!)).toEqual({ day: ['1'], night: ['0'] });
    expect(ids(doors[1]!)).toEqual({ day: ['0'], evening: ['0'], night: ['1'] });
  });

  it("names a zone after SAM's word when the word outlines one thing", () => {
    expect(cameraZones(setup, []).find((z) => z.word === 'television')?.name).toBe('television');
  });

  it('gives a saved name to the zone in its place, whatever numbers a fresh setup gives the outlines', () => {
    const zones = cameraZones(setup, [{ word: 'door', box: nudge(front, -4), name: 'front door' }]);
    expect(zones.filter((z) => z.word === 'door').map((z) => z.name)).toEqual(['door 1', 'front door']);
  });

  it("does not give a saved name to another word's outline in the same place", () => {
    const zones = cameraZones(setup, [{ word: 'window', box: front, name: 'front window' }]);
    expect(zones.map((z) => z.name)).not.toContain('front window');
  });
});

describe('cameraZones on a thing SAM cuts differently on each picture', () => {
  // Amosu's gate: one shape by day, its two leaves at dusk; SAM also finds the same shape under "fence".
  const wholeGate = { left: 6, top: 145, right: 307, bottom: 432 };
  const leftLeaf = { left: 9, top: 141, right: 171, bottom: 432 };
  const rightLeaf = { left: 158, top: 314, right: 304, bottom: 432 };
  const amosu: CameraSetup = {
    zones: [
      { name: 'gate', item: 'gate', seenAt: ['day', 'dusk'], outlines: { day: [outline('gate', '0', wholeGate)], dusk: [outline('gate', '0', rightLeaf), outline('gate', '1', leftLeaf)] } },
      { name: 'fence', item: 'fence', seenAt: ['day'], outlines: { day: [outline('fence', '0', wholeGate)] } },
    ],
    notOutlined: [],
    rules: [],
  };

  it('joins the pieces that lie inside the whole into one zone', () => {
    const gates = cameraZones(amosu, []).filter((z) => z.word === 'gate');
    expect(gates).toHaveLength(1);
    expect(ids(gates[0]!)).toEqual({ day: ['0'], dusk: ['0', '1'] });
  });

  it('never joins outlines under different words, however close', () => {
    expect(cameraZones(amosu, []).map((z) => z.name)).toEqual(['gate', 'fence']);
  });
});

describe('zoneAt', () => {
  it("finds the zone a rule's box belongs to, and none for a box elsewhere", () => {
    const zones = cameraZones(setup, []);
    expect(zoneAt(zones, 'door', nudge(front, 2))?.name).toBe('door 2');
    expect(zoneAt(zones, 'door', tv)).toBeNull();
  });
});
