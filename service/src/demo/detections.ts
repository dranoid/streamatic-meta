import type { Box } from '../sam/outlines.js';

// Milliseconds into the clip, then the box's left, top, right and bottom in the clip's pixels.
export type TrackPoint = [number, number, number, number, number];

export interface DetectedTrack {
  id: number;
  kind: string;
  points: TrackPoint[];
}

// What service/modal/detect.py found on a clip, once, when the clip was prepared. Nothing here calls a model.
export interface ClipDetections {
  fps: number;
  width: number;
  height: number;
  tracks: DetectedTrack[];
}

export interface Window {
  fromMs?: number;
  toMs?: number;
}

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle']);
const VEHICLE = 'vehicle';
// A tracker's box jitters, so one point in or out of a zone says nothing; this many in a row does.
const POINTS_TO_SETTLE = 2;

export function kindsSeen({ tracks }: ClipDetections): string[] {
  const kinds = new Set(tracks.map((t) => t.kind));
  if ([...kinds].some((k) => VEHICLES.has(k))) kinds.add(VEHICLE);
  return [...kinds].sort();
}

const isKind = (track: DetectedTrack, kind: string) => track.kind === kind || (kind === VEHICLE && VEHICLES.has(track.kind));
const within = (ms: number, { fromMs = 0, toMs = Infinity }: Window) => ms >= fromMs && ms <= toMs;
const feetOf = ([, left, , right, bottom]: TrackPoint) => ({ x: (left + right) / 2, y: bottom });
const heightOf = ([, , top, , bottom]: TrackPoint) => bottom - top;
// A person is where their feet are; the top of their box can overlap a zone they are only standing in front of.
const feetIn = (point: TrackPoint, zone: Box[]) => {
  const { x, y } = feetOf(point);
  return zone.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
};

const LONGEST_SPLIT_MS = 3_000;
const SMALLEST_SPLIT_REACH = 25;

const sameThing = (end: TrackPoint, start: TrackPoint) => {
  const gap = start[0] - end[0];
  const sizes = heightOf(start) / Math.max(1, heightOf(end));
  return gap > 0 && gap <= LONGEST_SPLIT_MS && sizes >= 0.5 && sizes <= 2 && distanceApart(end, start) <= Math.max(SMALLEST_SPLIT_REACH, 0.6 * Math.max(heightOf(end), heightOf(start)));
};
const distanceApart = (a: TrackPoint, b: TrackPoint) => Math.hypot(feetOf(a).x - feetOf(b).x, feetOf(a).y - feetOf(b).y);

// A tracker gives one person a new id whenever it loses them for a moment, so a track that starts where and soon after another ended continues it.
function joinedTracks({ tracks }: ClipDetections, kind: string): TrackPoint[][] {
  const joined: TrackPoint[][] = [];
  for (const track of tracks.filter((t) => isKind(t, kind) && t.points.length > 0).sort((a, b) => a.points[0]![0] - b.points[0]![0])) {
    const start = track.points[0]!;
    const before = joined.filter((points) => sameThing(points.at(-1)!, start)).sort((a, b) => distanceApart(a.at(-1)!, start) - distanceApart(b.at(-1)!, start))[0];
    if (before) before.push(...track.points);
    else joined.push([...track.points]);
  }
  return joined;
}

// Each change of state that held, with the moment it began; the state a track starts in is not a change.
function settledChanges(points: TrackPoint[], zone: Box[]): Array<{ inside: boolean; atMs: number }> {
  const changes: Array<{ inside: boolean; atMs: number }> = [];
  let state: boolean | null = null;
  let runInside: boolean | null = null;
  let runFromMs = 0;
  let runLength = 0;
  for (const point of points) {
    const inside = feetIn(point, zone);
    if (inside === runInside) runLength++;
    else (runInside = inside), (runFromMs = point[0]), (runLength = 1);
    if (runLength < POINTS_TO_SETTLE || inside === state) continue;
    if (state !== null) changes.push({ inside, atMs: runFromMs });
    state = inside;
  }
  return changes;
}

const settlesIn = (points: TrackPoint[], zone: Box[]) => points.some((point, i) => i + 1 < points.length && feetIn(point, zone) && feetIn(points[i + 1]!, zone));

export function countInView(detections: ClipDetections, asked: Window & { kind: string; zone?: Box[] }): { distinct: number; mostAtOnce: number; mostAtOnceAtMs: number | null } {
  const { kind, zone } = asked;
  const atMoment = new Map<number, number>();
  let distinct = 0;
  for (const track of joinedTracks(detections, kind)) {
    const points = track.filter((p) => within(p[0], asked));
    if (zone ? !settlesIn(points, zone) : points.length === 0) continue;
    distinct++;
    for (const point of zone ? points.filter((p) => feetIn(p, zone)) : points) atMoment.set(point[0], (atMoment.get(point[0]) ?? 0) + 1);
  }
  let mostAtOnce = 0;
  let mostAtOnceAtMs: number | null = null;
  for (const [ms, count] of [...atMoment].sort((a, b) => a[0] - b[0])) {
    if (count > mostAtOnce) (mostAtOnce = count), (mostAtOnceAtMs = ms);
  }
  return { distinct, mostAtOnce, mostAtOnceAtMs };
}

export function zoneCrossings(detections: ClipDetections, asked: Window & { kind: string; zone: Box[] }): { entered: number[]; left: number[] } {
  const changes = joinedTracks(detections, asked.kind).flatMap((t) => settledChanges(t, asked.zone));
  const moments = (inside: boolean) => changes.filter((c) => c.inside === inside && within(c.atMs, asked)).map((c) => c.atMs).sort((a, b) => a - b);
  return { entered: moments(true), left: moments(false) };
}

const STILL_IN_VIEW_MS = 1_000;

// Feet stop on the ground in front of an opening, a little below its outline, and rarely inside it.
const openingAt = (point: TrackPoint, openings: Box[]) =>
  openings.find((box) => {
    const { x, y } = feetOf(point);
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const margin = Math.max(10, 0.25 * width);
    return x >= box.left - margin && x <= box.right + margin && y >= box.bottom - 0.35 * height && y <= box.bottom + 0.3 * height;
  });

const fromTheBase = (point: TrackPoint, box: Box) => Math.hypot(feetOf(point).x - (box.left + box.right) / 2, feetOf(point).y - box.bottom);

// Someone going through an opening passes out of sight there, so their track ends or begins at it, whereas someone walking past is seen on both sides.
// A track never seen away from the opening says nothing: someone standing there breaks into such tracks, and a false detection on the opening is one.
export function throughOpening(detections: ClipDetections, asked: Window & { kind: string; openings: Box[] }): { wentIn: number[]; cameOut: number[] } {
  const clipEndsMs = Math.max(0, ...detections.tracks.map((t) => t.points.at(-1)?.[0] ?? 0));
  const wentIn: number[] = [];
  const cameOut: number[] = [];
  for (const track of joinedTracks(detections, asked.kind)) {
    if (track.every((point) => openingAt(point, asked.openings))) continue;
    const first = track[0]!;
    const last = track.at(-1)!;
    const whereItBegan = first[0] > STILL_IN_VIEW_MS ? openingAt(first, asked.openings) : undefined;
    const whereItEnded = last[0] < clipEndsMs - STILL_IN_VIEW_MS ? openingAt(last, asked.openings) : undefined;
    const goesIn = whereItEnded && (!whereItBegan || fromTheBase(last, whereItEnded) < fromTheBase(first, whereItEnded));
    if (goesIn) wentIn.push(last[0]);
    else if (whereItBegan) cameOut.push(first[0]);
  }
  const inTime = (moments: number[]) => moments.filter((ms) => within(ms, asked)).sort((a, b) => a - b);
  return { wentIn: inTime(wentIn), cameOut: inTime(cameOut) };
}
