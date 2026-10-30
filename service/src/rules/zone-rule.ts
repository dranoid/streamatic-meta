import type { Picture } from '../sam/client.js';
import type { Box, Outline } from '../sam/outlines.js';
import type { LabelledPicture, Outliner } from '../setup/camera-setup.js';

export interface Gray {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Frame {
  at: number;
  width: number;
  height: number;
  picture: Picture;
  gray: Gray;
}

export type Zone =
  | { name: string; kind: 'outline'; word: string; reference: Box; path: string }
  | { name: string; kind: 'box'; box: Box; question: string };

export interface ZoneRule {
  sentence: string;
  // Every zone must show its change in the same check: "the light is off while the door is open" is two zones.
  zones: Zone[];
  activeHours?: { from: number; to: number };
  samples: number;
  sampleGapMs: number;
  cooldownMs: number;
}

export interface BoxJudge {
  judge(question: string, crops: LabelledPicture[]): Promise<{ answer: boolean | null; shownIn: number | null }>;
}

export interface ZoneCheck {
  at: number;
  pictures: number[];
  verdict: boolean;
  shownIn: number | null;
}

export interface ZoneAlert {
  rule: string;
  zones: string[];
  at: number;
  picture: Frame | null;
  // On the alert's picture, the outline SAM drew at each outline zone, where it found one there.
  outlines: Outline[];
  clip: Frame[];
  // Each picture the deciding check looked at, with the outlines SAM drew at the rule's outline zones.
  judged: Array<{ at: number; outlines: Outline[] }>;
}

// A pixel counts as changed past this grey-level difference; the zone changes when this share of its pixels does.
const PIXEL_DIFFERENCE = 25;
const CHANGED_SHARE = 0.02;
// Below this overlap with the reference outline, the thing is no longer as it was at setup.
const SAME_OUTLINE_OVERLAP = 0.7;

interface ZoneVerdict {
  verdict: boolean;
  shownIn: number | null;
  // Per picture of the window, SAM's outline at this zone; always null on a box zone.
  outlines: Array<Outline | null>;
}

export async function runZoneRule({
  rule,
  frames,
  sam,
  judge,
  crop,
  timeZone,
}: {
  rule: ZoneRule;
  frames: Frame[];
  sam: Outliner;
  judge?: BoxJudge;
  crop: (picture: Picture, box: Box) => Promise<Picture>;
  timeZone: string;
}): Promise<{ checks: ZoneCheck[]; alerts: ZoneAlert[] }> {
  const boxes = rule.zones.map(zoneBox);
  const words = [...new Set(rule.zones.flatMap((z) => (z.kind === 'outline' ? [z.word] : [])))];
  const checks: ZoneCheck[] = [];
  const alerts: ZoneAlert[] = [];
  let quietUntil = -Infinity;

  for (let i = 1; i < frames.length; i++) {
    const current = frames[i]!;
    if (current.at < quietUntil || !isActive(rule, current.at, timeZone)) continue;
    if (!boxes.some((box) => zoneChanged(frames[i - 1]!, current, box))) continue;

    const window = pickWindow(frames, i, rule);
    // One SAM call a picture covers every outline zone, however many the rule has.
    const outlined = words.length ? await Promise.all(window.map((f) => sam.outlineAll(f.picture, words))) : [];
    const verdicts: ZoneVerdict[] = [];
    for (const zone of rule.zones) {
      verdicts.push(
        zone.kind === 'outline'
          ? judgeOutline(outlined.map((o) => o[zone.word] ?? []), zone.reference)
          : { ...(await judgeBox(judge, zone.question, zone.box, window, crop)), outlines: window.map(() => null) },
      );
    }
    const verdict = verdicts.every((v) => v.verdict);
    // The picture where the last of the changes shows; a zone seen only as a change between pictures makes it a clip.
    const shownIn = verdict && verdicts.every((v) => v.shownIn !== null) ? Math.max(...verdicts.map((v) => v.shownIn!)) : null;
    checks.push({ at: current.at, pictures: window.map((f) => f.at), verdict, shownIn });

    if (verdict) {
      const picture = shownIn === null ? null : window[shownIn - 1]!;
      const last = window[window.length - 1]!;
      const outlinesAt = (k: number) => verdicts.flatMap((v) => (v.outlines[k] ? [v.outlines[k]!] : []));
      alerts.push({
        rule: rule.sentence,
        zones: rule.zones.map((z) => z.name),
        at: picture?.at ?? current.at,
        picture,
        outlines: shownIn === null ? [] : outlinesAt(shownIn - 1),
        clip: picture ? [] : frames.filter((f) => f.at >= current.at && f.at <= last.at),
        judged: window.map((f, k) => ({ at: f.at, outlines: outlinesAt(k) })),
      });
      quietUntil = current.at + rule.cooldownMs;
    }
    // The pictures the check looked at are spent; scanning resumes after the last of them.
    i = frames.indexOf(window[window.length - 1]!);
  }
  return { checks, alerts };
}

function pickWindow(frames: Frame[], start: number, rule: ZoneRule): Frame[] {
  const first = frames[start]!;
  const window = [first];
  for (let k = 1; k < rule.samples; k++) {
    const next = frames.find((f, j) => j > start && f.at >= first.at + k * rule.sampleGapMs && !window.includes(f));
    if (next) window.push(next);
  }
  return window;
}

// SAM's outline nearest the zone on each picture; the zone changed where that overlaps the reference least, below the bar.
function judgeOutline(perPicture: Outline[][], reference: Box): ZoneVerdict {
  let shownIn: number | null = null;
  let leastLike = 1;
  const outlines = perPicture.map((found, k) => {
    const nearest = found.reduce<Outline | null>(
      (best, o) => (best === null || boxOverlap(o.box, reference) > boxOverlap(best.box, reference) ? o : best),
      null,
    );
    const overlap = nearest ? boxOverlap(nearest.box, reference) : 0;
    if (overlap < SAME_OUTLINE_OVERLAP && overlap < leastLike) {
      leastLike = overlap;
      shownIn = k + 1;
    }
    // An outline that does not touch the zone is another thing of the same kind, not this zone.
    return overlap > 0 ? nearest : null;
  });
  return { verdict: shownIn !== null, shownIn, outlines };
}

async function judgeBox(
  judge: BoxJudge | undefined,
  question: string,
  box: Box,
  window: Frame[],
  crop: (picture: Picture, box: Box) => Promise<Picture>,
) {
  if (!judge) throw new Error('A box zone needs a judge to answer its question.');
  const crops = await Promise.all(window.map(async (f, k) => ({ label: `picture ${k + 1}`, picture: await crop(f.picture, box) })));
  const { answer, shownIn } = await judge.judge(question, crops);
  const valid = shownIn !== null && Number.isInteger(shownIn) && shownIn >= 1 && shownIn <= window.length;
  return { verdict: answer === true, shownIn: valid ? shownIn : null };
}

function zoneChanged(previous: Frame, current: Frame, box: Box): boolean {
  const { width, height, data } = current.gray;
  const sx = width / current.width;
  const sy = height / current.height;
  const x0 = Math.max(0, Math.floor(box.left * sx));
  const x1 = Math.min(width, Math.ceil(box.right * sx));
  const y0 = Math.max(0, Math.floor(box.top * sy));
  const y1 = Math.min(height, Math.ceil(box.bottom * sy));
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (Math.abs(data[y * width + x]! - previous.gray.data[y * width + x]!) > PIXEL_DIFFERENCE) changed++;
    }
  }
  return changed > CHANGED_SHARE * (x1 - x0) * (y1 - y0);
}

export function boxOverlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const shared = w * h;
  const area = (r: Box) => (r.right - r.left) * (r.bottom - r.top);
  return shared / (area(a) + area(b) - shared);
}

function isActive(rule: ZoneRule, at: number, timeZone: string): boolean {
  if (!rule.activeHours) return true;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(at));
  const { from, to } = rule.activeHours;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

function zoneBox(zone: Zone): Box {
  return zone.kind === 'outline' ? zone.reference : zone.box;
}

// The zone as an SVG path in picture pixels, for drawing it on an alert.
export function zoneOutline(zone: Zone): string {
  if (zone.kind === 'outline') return zone.path;
  const { left, top, right, bottom } = zone.box;
  return `M${left} ${top}H${right}V${bottom}H${left}Z`;
}
