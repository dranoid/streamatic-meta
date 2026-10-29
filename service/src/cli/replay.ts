// Replays stored camera batches through one rule on a SAM zone and prints the checks and alerts.
// Spends one SAM call at setup, then three per change inside the zone.
// npm run replay -- <batches dir> <out.json> "<rule sentence>" <word> <x,y inside the thing> [from-hour to-hour]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { SamClient, type Picture } from '../sam/client.js';
import { runZoneRule, type Frame, type ZoneRule } from '../rules/zone-rule.js';

const [dir, outPath, sentence, word, point, fromHour, toHour] = process.argv.slice(2);
const apiKey = process.env.META_MODEL_API_KEY;
if (!dir || !outPath || !sentence || !word || !point || !apiKey) {
  console.error('Usage: npm run replay -- <batches dir> <out.json> "<rule>" <word> <x,y> [from-hour to-hour]');
  process.exit(1);
}

const frames: Frame[] = [];
for (const batch of (await readdir(dir)).sort()) {
  const manifest = JSON.parse(await readFile(join(dir, batch, 'manifest.json'), 'utf8')) as {
    frames: Array<{ file: string; capturedAt: number; width: number; height: number }>;
  };
  for (const f of manifest.frames) {
    const bytes = await readFile(join(dir, batch, f.file));
    const { data, info } = await sharp(bytes).resize(160).greyscale().raw().toBuffer({ resolveWithObject: true });
    frames.push({
      at: f.capturedAt,
      width: f.width,
      height: f.height,
      picture: { bytes, mimeType: 'image/jpeg' },
      gray: { width: info.width, height: info.height, data: new Uint8Array(data) },
    });
  }
}
frames.sort((a, b) => a.at - b.at);

const sam = new SamClient({ apiKey });
const [px, py] = point.split(',').map(Number) as [number, number];
const atSetup = (await sam.outline(frames[0]!.picture, word)).find(
  (o) => px >= o.box.left && px < o.box.right && py >= o.box.top && py < o.box.bottom,
);
if (!atSetup) {
  console.error(`SAM found no "${word}" at ${point} in the first picture.`);
  process.exit(1);
}

const rule: ZoneRule = {
  sentence,
  zone: { name: word, kind: 'outline', word, reference: atSetup.box, path: atSetup.path },
  ...(fromHour && toHour ? { activeHours: { from: Number(fromHour), to: Number(toHour) } } : {}),
  samples: 3,
  sampleGapMs: 3_000,
  cooldownMs: 5 * 60_000,
};
const crop = async (picture: Picture) => picture;
const result = await runZoneRule({ rule, frames, sam, crop, timeZone: 'Africa/Lagos' });

const time = (at: number) => new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos' });
console.log(`${frames.length} pictures, ${time(frames[0]!.at)}–${time(frames[frames.length - 1]!.at)}; zone ${JSON.stringify(atSetup.box)}`);
for (const c of result.checks) {
  console.log(`check ${time(c.at)}  pictures ${c.pictures.map(time).join(', ')}  ${c.verdict ? `CHANGED, picture ${c.shownIn}` : 'unchanged'}`);
}
for (const a of result.alerts) console.log(`ALERT ${time(a.at)}  ${a.rule}`);
await writeFile(
  outPath,
  JSON.stringify({ rule: { ...rule, zone: { ...rule.zone } }, checks: result.checks, alerts: result.alerts.map((a) => ({ ...a, picture: a.picture?.at ?? null, clip: a.clip.map((f) => f.at) })) }, null, 1),
);
