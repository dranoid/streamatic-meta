import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendAlert, SampledFrame } from '../backend/client.js';
import { zoneBox, zonePath, type SavedRule, type Zone } from '../rules/rule-store.js';
import type { Picture } from '../sam/client.js';
import { boxOverlap, type Outline } from '../sam/outlines.js';
import type { EventStore } from './store.js';

// The player shows this many pictures either side of what the alert looked at; a batch holds one picture a second.
const AROUND_SECONDS = 10;
const BATCH_MEMBER = /^(.+\.tar)#(\d+)\.jpg$/;

export interface CopyDeps {
  store: EventStore;
  mediaDir: string;
  pictureUrls: (keys: string[]) => Promise<Record<string, string>>;
  download: (url: string) => Promise<Uint8Array | null>;
  pickPicture: (event: string, pictures: Picture[]) => Promise<number>;
  outlineAll: (picture: Picture, words: string[]) => Promise<Record<string, Outline[]>>;
}

const asPicture = (bytes: Uint8Array): Picture => ({ bytes, mimeType: 'image/jpeg' });

// A picture's neighbours in its batch, whose names and times follow from its own: member n of a batch was taken n - 1 seconds in.
export function picturesAround(frames: SampledFrame[]): SampledFrame[] {
  const wanted = new Map<string, SampledFrame>(frames.map((f) => [f.objectKey, f]));
  for (const frame of frames) {
    const member = BATCH_MEMBER.exec(frame.objectKey);
    if (!member) continue;
    const index = Number(member[2]);
    for (let n = Math.max(1, index - AROUND_SECONDS); n <= index + AROUND_SECONDS; n++) {
      const key = `${member[1]}#${String(n).padStart(member[2]!.length, '0')}.jpg`;
      if (!wanted.has(key)) wanted.set(key, { ...frame, objectKey: key, capturedAt: frame.capturedAt + (n - index) * 1000 });
    }
  }
  return [...wanted.values()].sort((a, b) => a.capturedAt - b.capturedAt);
}

// Where SAM finds each of the rule's zones on one picture, by the zone's place; a drawn box is drawn as it is.
async function outlinesOn(picture: Picture, zones: Zone[], outlineAll: CopyDeps['outlineAll']): Promise<string | null> {
  const words = [...new Set(zones.flatMap((z) => (z.kind === 'outline' ? [z.word] : [])))];
  const found = words.length ? await outlineAll(picture, words) : {};
  const paths = zones.flatMap((zone) => {
    if (zone.kind === 'box') return [zonePath(zone)];
    const nearest = (found[zone.word] ?? [])
      .map((o) => ({ o, overlap: boxOverlap(o.box, zoneBox(zone)) }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    return nearest && nearest.overlap > 0 ? [nearest.o.path] : [];
  });
  return paths.join(' ') || null;
}

// Keeps a backend alert as an event once: Spark Open chooses the picture, SAM outlines the zones on what the rule looked at.
export async function copyAlert(alert: BackendAlert, rule: SavedRule, camera: string, deps: CopyDeps): Promise<number | null> {
  const { store, mediaDir, pictureUrls, download, pickPicture, outlineAll } = deps;
  if (store.hasBackendAlert(alert.id)) return null;
  const sampled = alert.evidence.sampledFrames ?? [];
  const around = picturesAround(sampled);
  const urls = around.length ? await pictureUrls(around.map((f) => f.objectKey)) : {};
  const fetched = await Promise.all(
    around.map(async (frame) => {
      const url = urls[frame.objectKey];
      const bytes = url ? await download(url) : null;
      return bytes ? { frame, bytes } : null;
    }),
  );
  const pictures = fetched.filter((f): f is NonNullable<typeof f> => f !== null);
  const looked = pictures.filter((p) => sampled.some((s) => s.objectKey === p.frame.objectKey));

  const chosen = looked.length ? looked[await pickPicture(alert.evidence.question ?? alert.message, looked.map((l) => asPicture(l.bytes)))] : undefined;
  const outlines = new Map<string, string | null>();
  for (const { frame, bytes } of looked) outlines.set(frame.objectKey, await outlinesOn(asPicture(bytes), rule.zones, outlineAll));

  const at = chosen?.frame.capturedAt ?? Date.parse(alert.triggeredAt);
  const name = (frame: SampledFrame) => `${alert.id}_${frame.capturedAt}.jpg`;
  await Promise.all(pictures.map(({ frame, bytes }) => writeFile(join(mediaDir, name(frame)), bytes)));
  const id = store.add({
    camera,
    zone: rule.zones[0]!.name,
    rule: rule.sentence,
    at,
    picture: chosen ? name(chosen.frame) : null,
    clip: null,
    outline: chosen ? (outlines.get(chosen.frame.objectKey) ?? null) : null,
    reference: rule.zones.map(zonePath).join(' '),
    backendId: alert.id,
    recorded: false,
  });
  store.addFrames(id, pictures.map(({ frame }) => ({ at: frame.capturedAt, file: name(frame), outline: outlines.get(frame.objectKey) ?? null })));
  return id;
}

export type KeepDeps = Pick<CopyDeps, 'store' | 'mediaDir' | 'outlineAll'>;

// Keeps a stretch of a trial as an event of the saved rule, labelled as a recorded run; it is kept once.
export async function keepStretch(
  stretch: { key: string; from: number; bytes: Uint8Array | null },
  rule: SavedRule,
  camera: string,
  { store, mediaDir, outlineAll }: KeepDeps,
): Promise<number | null> {
  if (store.hasBackendAlert(stretch.key)) return null;
  const outline = stretch.bytes ? await outlinesOn(asPicture(stretch.bytes), rule.zones, outlineAll) : null;
  const file = `${stretch.key}.jpg`;
  if (stretch.bytes) await writeFile(join(mediaDir, file), stretch.bytes);
  const id = store.add({
    camera,
    zone: rule.zones[0]!.name,
    rule: rule.sentence,
    at: stretch.from,
    picture: stretch.bytes ? file : null,
    clip: null,
    outline,
    reference: rule.zones.map(zonePath).join(' '),
    backendId: stretch.key,
    recorded: true,
  });
  if (stretch.bytes) store.addFrames(id, [{ at: stretch.from, file, outline }]);
  return id;
}
