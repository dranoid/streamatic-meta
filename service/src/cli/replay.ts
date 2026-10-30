// Replays stored camera batches through one rule and prints the checks and alerts.
// A saved rule (--app and --rule) brings its zone from setup; otherwise SAM outlines <word> at <x,y> in the first picture.
// SAM is called only on a change inside the zone, three pictures each time; a drawn box asks Spark Open instead.
// --send sends each alert to the Telegram chat in ../.env. With --app, alerts are kept as the app's events; --store keeps them elsewhere.
// npm run replay -- <batches dir> <out.json> --app=<app folder> --rule=<id> [--send] [--view=outlined|plain|both]
// npm run replay -- <batches dir> <out.json> "<rule sentence>" <word> <x,y inside the thing> [from-hour to-hour]
//   [--name="front door"] [--camera="Table parlour"] [--send] [--view=…] [--store=<event folder>]

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeClip } from '../alerts/clip.js';
import { CLIP_PICTURES_PER_SECOND, sendZoneAlert, type AlertView } from '../alerts/send-alert.js';
import { TelegramSender } from '../alerts/telegram.js';
import { CameraFolder } from '../cameras/camera-folder.js';
import { EventStore } from '../events/store.js';
import { RuleStore } from '../rules/rule-store.js';
import { runZoneRule, zoneOutline, type Frame, type ZoneRule } from '../rules/zone-rule.js';
import { SamClient, type Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';
import { SparkBoxJudge } from '../spark/box-judge.js';
import { SparkClient } from '../spark/client.js';

const SAMPLES = 3;
const SAMPLE_GAP_MS = 3_000;
const COOLDOWN_MS = 5 * 60_000;
const TIME_ZONE = 'Africa/Lagos';
// The clip player shows this much either side of the pictures the deciding check judged.
const FRAMES_AROUND_MS = 10_000;

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [key, value] = a.slice(2).split('=', 2) as [string, string | undefined];
    return [key, value ?? 'true'];
  }),
);
const [dir, outPath, sentence, word, point, fromHour, toHour] = args.filter((a) => !a.startsWith('--'));
const apiKey = process.env.META_MODEL_API_KEY;
const basetenKey = process.env.BASETEN_API_KEY;
const savedRule = flags.app !== undefined && flags.rule !== undefined;
if (!dir || !outPath || !apiKey || (!savedRule && (!sentence || !word || !point))) {
  console.error(
    'Usage: npm run replay -- <batches dir> <out.json> --app=<app folder> --rule=<id>\n' +
      '   or: npm run replay -- <batches dir> <out.json> "<rule>" <word> <x,y> [from-hour to-hour]',
  );
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
const spark = basetenKey ? new SparkClient({ apiKey: basetenKey }) : null;
const timing = { samples: SAMPLES, sampleGapMs: SAMPLE_GAP_MS, cooldownMs: COOLDOWN_MS };
let rule: ZoneRule;
let camera = flags.camera ?? 'Camera';
let eventFolder = flags.store;

if (savedRule) {
  const saved = new RuleStore(join(flags.app!, 'events.db')).get(Number(flags.rule));
  if (!saved) {
    console.error(`No rule ${flags.rule} in ${flags.app}.`);
    process.exit(1);
  }
  camera = (await new CameraFolder(flags.app!).get(saved.camera))?.name ?? saved.camera;
  eventFolder = flags.app;
  rule = {
    sentence: saved.sentence,
    zones: saved.zones,
    ...(saved.activeHours === null ? {} : { activeHours: saved.activeHours }),
    ...timing,
  };
} else {
  const [px, py] = point!.split(',').map(Number) as [number, number];
  const atSetup = (await sam.outline(frames[0]!.picture, word!)).find(
    (o) => px >= o.box.left && px < o.box.right && py >= o.box.top && py < o.box.bottom,
  );
  if (!atSetup) {
    console.error(`SAM found no "${word}" at ${point} in the first picture.`);
    process.exit(1);
  }
  rule = {
    sentence: sentence!,
    zones: [{ name: flags.name ?? word!, kind: 'outline', word: word!, reference: atSetup.box, path: atSetup.path }],
    ...(fromHour && toHour ? { activeHours: { from: Number(fromHour), to: Number(toHour) } } : {}),
    ...timing,
  };
}

if (rule.zones.some((z) => z.kind === 'box') && !spark) throw new Error('A drawn box needs BASETEN_API_KEY in ../.env, for Spark Open to answer its question.');
const judge = spark ? new SparkBoxJudge(spark, SAMPLE_GAP_MS / 1000) : undefined;
const crop = async (picture: Picture, box: Box): Promise<Picture> => {
  const region = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.right - box.left), height: Math.round(box.bottom - box.top) };
  return { ...picture, bytes: new Uint8Array(await sharp(picture.bytes).extract(region).jpeg().toBuffer()) };
};
const result = await runZoneRule({ rule, frames, sam, judge, crop, timeZone: TIME_ZONE });
// Several zones draw as one SVG path of several shapes.
const reference = rule.zones.map(zoneOutline).join(' ');

const time = (at: number) => new Date(at).toLocaleTimeString('en-GB', { timeZone: TIME_ZONE });
console.log(`${frames.length} pictures, ${time(frames[0]!.at)}–${time(frames[frames.length - 1]!.at)}; zones ${rule.zones.map((z) => z.name).join(', ')}`);
for (const c of result.checks) {
  console.log(`check ${time(c.at)}  pictures ${c.pictures.map(time).join(', ')}  ${c.verdict ? `CHANGED, picture ${c.shownIn}` : 'unchanged'}`);
}
for (const a of result.alerts) console.log(`ALERT ${time(a.at)}  ${a.rule}`);

let sender: TelegramSender | null = null;
if (flags.send) {
  const { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_CHAT_ID: chatId } = process.env;
  if (!botToken || !chatId) throw new Error('--send needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in ../.env');
  sender = new TelegramSender({ botToken, chatId });
}
let store: EventStore | null = null;
if (eventFolder) {
  await mkdir(join(eventFolder, 'media'), { recursive: true });
  store = new EventStore(join(eventFolder, 'events.db'), TIME_ZONE);
}

for (const alert of result.alerts) {
  if (store) {
    const media = join(eventFolder!, 'media');
    const picture = alert.picture ? `${alert.at}.jpg` : null;
    const clip = alert.picture ? null : `${alert.at}.mp4`;
    if (alert.picture) await writeFile(join(media, picture!), alert.picture.picture.bytes);
    else await writeFile(join(media, clip!), await makeClip(alert.clip.map((f) => f.picture.bytes), CLIP_PICTURES_PER_SECOND));
    // An event is filed under the rule's first zone, so a question about that zone counts it.
    const outline = alert.outlines.map((o) => o.path).join(' ') || null;
    const eventId = store.add({ camera, zone: alert.zones[0]!, rule: alert.rule, at: alert.at, picture, clip, outline, reference });
    const first = alert.judged[0]?.at ?? alert.at;
    const last = alert.judged[alert.judged.length - 1]?.at ?? alert.at;
    const around = frames.filter((f) => f.at >= first - FRAMES_AROUND_MS && f.at <= last + FRAMES_AROUND_MS);
    for (const f of around) await writeFile(join(media, `${alert.at}_${f.at}.jpg`), f.picture.bytes);
    store.addFrames(
      eventId,
      around.map((f) => ({ at: f.at, file: `${alert.at}_${f.at}.jpg`, outline: alert.judged.find((j) => j.at === f.at)?.outlines.map((o) => o.path).join(' ') || null })),
    );
    console.log(`stored ${time(alert.at)} as event ${eventId}`);
  }
  if (sender) {
    const view = (flags.view ?? 'outlined') as AlertView;
    await sendZoneAlert({ alert, sender, camera, timeZone: TIME_ZONE, makeClip, reference, view });
    console.log(`sent ${time(alert.at)} to Telegram`);
  }
}
await writeFile(
  outPath,
  JSON.stringify({ rule, checks: result.checks, alerts: result.alerts.map((a) => ({ ...a, picture: a.picture?.at ?? null, clip: a.clip.map((f) => f.at) })) }, null, 1),
);
