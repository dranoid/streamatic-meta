// Replays stored camera batches through one rule and prints the checks and alerts.
// A saved rule (--app and --rule) brings its zone from setup; otherwise SAM outlines <word> at <x,y> in the first picture.
// SAM is called only on a change inside the zone, three pictures each time; a drawn box asks Spark Open instead.
// --send sends each alert to the Telegram chat in ../.env. With --app, alerts are kept as the app's events; --store keeps them elsewhere.
// npm run replay -- <batches dir> <out.json> --app=<app folder> --rule=<id> [--send] [--view=outlined|plain|both]
// npm run replay -- <batches dir> <out.json> "<rule sentence>" <word> <x,y inside the thing> [from-hour to-hour]
//   [--name="front door"] [--camera="Table parlour"] [--send] [--view=…] [--store=<event folder>]

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeClip } from '../alerts/clip.js';
import { sendZoneAlert, type AlertView } from '../alerts/send-alert.js';
import { TelegramSender } from '../alerts/telegram.js';
import { CameraFolder } from '../cameras/camera-folder.js';
import { keepAlert } from '../events/keep-alert.js';
import { EventStore } from '../events/store.js';
import { readEpisode } from '../live/episode.js';
import { cropPicture } from '../rules/frame.js';
import { RULE_TIMING, RuleStore, zoneRule } from '../rules/rule-store.js';
import { runZoneRule, zoneOutline, type ZoneRule } from '../rules/zone-rule.js';
import { SamClient } from '../sam/client.js';
import { SparkBoxJudge } from '../spark/box-judge.js';
import { SparkClient } from '../spark/client.js';

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

const frames = await readEpisode(dir);

const sam = new SamClient({ apiKey });
const spark = basetenKey ? new SparkClient({ apiKey: basetenKey }) : null;
const timing = RULE_TIMING;
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
  rule = zoneRule(saved, timing);
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
const judge = spark ? new SparkBoxJudge(spark, RULE_TIMING.sampleGapMs / 1000) : undefined;
const result = await runZoneRule({ rule, frames, sam, judge, crop: cropPicture, timeZone: TIME_ZONE });
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
    const first = alert.judged[0]?.at ?? alert.at;
    const last = alert.judged[alert.judged.length - 1]?.at ?? alert.at;
    const around = frames.filter((f) => f.at >= first - FRAMES_AROUND_MS && f.at <= last + FRAMES_AROUND_MS);
    const eventId = await keepAlert({ alert, around, camera, reference, store, mediaDir: join(eventFolder!, 'media') });
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
