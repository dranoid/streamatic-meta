import { boxOverlap, type Box, type Outline } from '../sam/outlines.js';
import type { CameraSetup } from '../setup/camera-setup.js';

// A name someone gave a zone, kept by SAM's word and the zone's place, since SAM numbers its outlines afresh on every run.
export interface ZoneName {
  word: string;
  box: Box;
  name: string;
}

// One thing SAM outlined, matched across the camera's pictures: its outline on each picture, in pieces where SAM cut it up.
export interface CameraZone {
  word: string;
  // What it was first listed as, when SAM only outlined it under another word.
  item: string;
  name: string;
  outlines: Record<string, Outline[]>;
}

export interface ZoneCoverage {
  name: string;
  foundOn: string[];
  missedOn: string[];
  uncertainAtNight: boolean;
}

// The camera does not move, so one thing outlines in nearly the same box on every picture, or as pieces inside that box.
const SAME_BOX = 0.5;
const PIECE_INSIDE = 0.7;

export function cameraZones(setup: CameraSetup, names: ZoneName[]): CameraZone[] {
  return setup.zones.flatMap((setupZone) => {
    const found = Object.entries(setupZone.outlines).flatMap(([label, outlines]) => outlines.map((outline) => ({ label, outline })));
    // Outlines on different pictures in the same place join, and joins carry over: two dusk leaves meet through the day's whole gate.
    const group = found.map((_, i) => i);
    const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i]!)));
    found.forEach((a, i) =>
      found.forEach((b, j) => {
        if (j > i && a.label !== b.label && likeness(a.outline.box, b.outline.box) > 0) group[root(j)] = root(i);
      }),
    );
    const zones = new Map<number, Record<string, Outline[]>>();
    found.forEach(({ label, outline }, i) => {
      const outlines = zones.get(root(i)) ?? zones.set(root(i), {}).get(root(i))!;
      (outlines[label] ??= []).push(outline);
    });
    const ordered = [...zones.values()].sort((a, b) => leftmost(a) - leftmost(b));
    return ordered.map((outlines, i) => {
      const saved = closest(
        names.filter((n) => n.word === setupZone.name),
        (n) => likenessTo(outlines, n.box),
      );
      const numbered = ordered.length > 1 ? `${setupZone.name} ${i + 1}` : setupZone.name;
      return { word: setupZone.name, item: setupZone.item, name: saved?.name ?? numbered, outlines };
    });
  });
}

// Which of the camera's pictures found each zone. A rule on a zone the night picture missed may not hold after dark.
export function nightCoverage(zones: CameraZone[], pictures: string[]): ZoneCoverage[] {
  return zones.map((zone) => {
    const found = (label: string) => (zone.outlines[label]?.length ?? 0) > 0;
    return {
      name: zone.name,
      foundOn: pictures.filter(found),
      missedOn: pictures.filter((label) => !found(label)),
      uncertainAtNight: pictures.includes('night') && !found('night'),
    };
  });
}

// The numbers behind eval/: what setup outlined under each word, read from its results, naming no camera or place.
export function setupMeasure(runs: Array<{ pictures: string[]; setup: CameraSetup }>) {
  const cameras = runs.map(({ pictures, setup }, i) => {
    const found = (seenAt: string[]) => pictures.filter((label) => seenAt.includes(label));
    return {
      camera: `Camera ${i + 1}`,
      outlined: setup.zones.length,
      onEveryPicture: setup.zones.filter((z) => found(z.seenAt).length === pictures.length).length,
      atNight: setup.zones.filter((z) => z.seenAt.includes('night')).length,
      notOutlined: setup.notOutlined.map((m) => m.item),
      words: setup.zones.map((z) => ({ word: z.name, foundOn: found(z.seenAt) })),
    };
  });
  const sum = (count: (c: (typeof cameras)[number]) => number) => cameras.reduce((total, c) => total + count(c), 0);
  return {
    cameras,
    total: { outlined: sum((c) => c.outlined), onEveryPicture: sum((c) => c.onEveryPicture), atNight: sum((c) => c.atNight), notOutlined: sum((c) => c.notOutlined.length) },
  };
}

// The zone a box under this word belongs to: how a saved rule finds its zone again after a rename or a fresh setup.
export function zoneAt(zones: CameraZone[], word: string, box: Box): CameraZone | null {
  return closest(
    zones.filter((z) => z.word === word),
    (z) => likenessTo(z.outlines, box),
  );
}

// How surely two boxes are the same thing: their overlap when they nearly coincide, or the share of the smaller inside
// the larger when one is a piece of the other; 0 when neither holds.
function likeness(a: Box, b: Box): number {
  const area = (r: Box) => (r.right - r.left) * (r.bottom - r.top);
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const overlap = boxOverlap(a, b);
  const inside = (w * h) / Math.min(area(a), area(b));
  return overlap >= SAME_BOX || inside >= PIECE_INSIDE ? Math.max(overlap, inside) : 0;
}

function likenessTo(outlines: Record<string, Outline[]>, box: Box): number {
  return Math.max(0, ...Object.values(outlines).flat().map((o) => likeness(o.box, box)));
}

function leftmost(outlines: Record<string, Outline[]>): number {
  return Math.min(...Object.values(outlines).flat().map((o) => o.box.left));
}

function closest<T>(items: T[], score: (item: T) => number): T | null {
  let best: T | null = null;
  let most = 0;
  for (const item of items) {
    const s = score(item);
    if (s > most) (best = item), (most = s);
  }
  return best;
}
