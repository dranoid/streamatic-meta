// Serves the app over one folder, on this computer only: events.db (events and rules), media/ (event pictures and clips)
// and cameras/ (one folder per camera). Setup and questions call SAM 3.1 and Muse Spark Open, so both keys must be in ../.env.
// A camera with a recording in cameras/<id>/episode/ plays it on a loop as its pictures. Rules live in Streamatic's backend,
// reached with STREAMATIC_API, STREAMATIC_COMPANY, STREAMATIC_EMAIL and STREAMATIC_PASSWORD; its alerts are copied here as events.
// With --public it serves the public page instead: only the demo, the clips and the About page, with spending limited per visitor.
// DEMO_TELEGRAM_TOKEN is a bot of this app's own, never Streamatic's: on the public page visitors link it from a clip; on the app its
// alerts go to TELEGRAM_CHAT_ID, in TELEGRAM_ALERT_LANGUAGE if set.
// npm run serve -- <app folder> [port] [--public]

import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CameraFolder, type Camera } from '../cameras/camera-folder.js';
import { requireMediaTools } from '../cameras/media-tools.js';
import { AlertCopier } from '../backend/alert-copier.js';
import { BackendClient } from '../backend/client.js';
import { Trials } from '../backend/trials.js';
import { ClipDetection, detectionClient } from '../demo/clip-detection.js';
import { DemoEngine } from '../demo/engine.js';
import { DemoLimits } from '../demo/limits.js';
import { COST_MICRO_USD, demoHandler, NEEDS_KEYS, publicOnly, visitorOf } from '../demo/routes.js';
import { DemoStore } from '../demo/store.js';
import { ClipFolder } from '../follow/clips.js';
import { Follows } from '../follow/follows.js';
import { ClipThings } from '../follow/things.js';
import { EventStore } from '../events/store.js';
import { EpisodeLoop, readEpisode } from '../live/episode.js';
import { cropAround } from '../rules/frame.js';
import { RuleStore } from '../rules/rule-store.js';
import { SamClient } from '../sam/client.js';
import { setUpCamera } from '../setup/camera-setup.js';
import { SparkAlertPicture } from '../spark/alert-picture.js';
import { SparkClient } from '../spark/client.js';
import { SparkFollowPlanner } from '../spark/follow-planner.js';
import { SparkGuidePlanner } from '../spark/guide-planner.js';
import { SparkQuestionPlanner } from '../spark/question-planner.js';
import { SparkSetupPlanner } from '../spark/setup-planner.js';
import { pollUpdates, TelegramApi } from '../telegram/api.js';
import { sendEventAlert } from '../telegram/demo-alert.js';
import { DemoBot } from '../telegram/demo-bot.js';
import { TelegramLinks } from '../telegram/links.js';
import { appHandler } from '../web/server.js';
import { CAPTION_LANGUAGES, SparkAlertCaption, type CaptionLanguage } from '../spark/alert-caption.js';
import { VoiceClient, VoiceNotes } from '../voice/voice-note.js';

const args = process.argv.slice(2);
const isPublic = args.includes('--public');
const [folder, port = '8787'] = args.filter((a) => a !== '--public');
const { META_MODEL_API_KEY: metaKey, BASETEN_API_KEY: basetenKey } = process.env;
const hasModels = Boolean(metaKey && basetenKey);
// The public page plays its recorded clips with no keys at all; the app itself needs them.
if (!folder || (!isPublic && !hasModels)) {
  console.error('Usage: npm run serve -- <app folder> [port] [--public]   (META_MODEL_API_KEY and BASETEN_API_KEY in ../.env)');
  process.exit(1);
}

await requireMediaTools();

const timeZone = 'Africa/Lagos';
// How often the backend's alerts are read.
const COPY_ALERTS_MS = 30_000;
// On the public page a track reaches this far either side of the selected frame; the page's clips run at TRACK_FPS.
const TRACK_SECONDS = 30;
const TRACK_FPS = 10;
const sam = new SamClient({ apiKey: metaKey ?? '' });
const spark = new SparkClient({ apiKey: basetenKey ?? '' });
const database = join(folder, 'events.db');
const events = new EventStore(database, timeZone);
const rules = new RuleStore(database);
const cameras = new CameraFolder(folder);
const clips = new ClipFolder(folder);
const followPlanner = new SparkFollowPlanner(spark);
const guidePlanner = new SparkGuidePlanner(spark);
const voiceNotes = new VoiceNotes(new VoiceClient({ apiKey: metaKey ?? '' }));
const mediaDir = join(folder, 'media');
await mkdir(mediaDir, { recursive: true });

const { STREAMATIC_API, STREAMATIC_COMPANY, STREAMATIC_EMAIL, STREAMATIC_PASSWORD } = process.env;
const backend =
  STREAMATIC_API && STREAMATIC_COMPANY && STREAMATIC_EMAIL && STREAMATIC_PASSWORD
    ? new BackendClient({ baseUrl: STREAMATIC_API, companyId: STREAMATIC_COMPANY, email: STREAMATIC_EMAIL, password: STREAMATIC_PASSWORD })
    : null;
const download = async (url: string) => {
  const reply = await fetch(url);
  return reply.ok ? new Uint8Array(await reply.arrayBuffer()) : null;
};
const unconnected = () => {
  throw new Error('This app is not connected to Streamatic.');
};
const trials = new Trials(backend ?? { startQuestion: unconnected, replay: unconnected }, download);

const { DEMO_TELEGRAM_TOKEN, DEMO_PAGE_URL, TELEGRAM_CHAT_ID, TELEGRAM_ALERT_LANGUAGE } = process.env;
const telegramApi = DEMO_TELEGRAM_TOKEN ? new TelegramApi({ token: DEMO_TELEGRAM_TOKEN }) : null;

const playing = new Map<string, EpisodeLoop>();
for (const camera of await cameras.list()) {
  if (!camera.episode) continue;
  const loop = new EpisodeLoop({ frames: await readEpisode(camera.episode) });
  playing.set(camera.id, loop);
  console.log(`${camera.name}: playing its recording on a loop`);
  setInterval(() => void loop.next(), 1_000);
}

if (backend && !isPublic) {
  const alertPicture = new SparkAlertPicture(spark);
  const writeCaption = new SparkAlertCaption(spark).write;
  const alertLanguage = TELEGRAM_ALERT_LANGUAGE && TELEGRAM_ALERT_LANGUAGE in CAPTION_LANGUAGES ? (TELEGRAM_ALERT_LANGUAGE as CaptionLanguage) : null;
  const inLanguage = async (rule: string) => {
    if (!alertLanguage) return rule;
    const kept = events.caption(rule, alertLanguage);
    if (kept) return kept;
    const written = await writeCaption(rule, alertLanguage).catch(() => null);
    if (written) events.saveCaption(rule, alertLanguage, written);
    return written ?? rule;
  };
  const copier = new AlertCopier({
    backend,
    rules,
    cameras,
    copy: {
      store: events,
      mediaDir,
      pictureUrls: (keys) => backend.pictureUrls(keys),
      download,
      pickPicture: (event, pictures) => alertPicture.pick(event, pictures),
      outlineAll: (picture, words) => sam.outlineAll(picture, words),
    },
    ...(telegramApi && TELEGRAM_CHAT_ID
      ? {
          notify: async (id: number) => {
            const event = events.get(id);
            if (event) await sendEventAlert({ chat: telegramApi, to: Number(TELEGRAM_CHAT_ID), mediaDir, event, words: await inLanguage(event.rule) });
          },
        }
      : {}),
  });
  const copyAlerts = () =>
    copier.pass().catch((error: unknown) => console.error(`Copying alerts: ${error instanceof Error ? error.message : String(error)}`));
  void copyAlerts();
  setInterval(() => void copyAlerts(), COPY_ALERTS_MS);
}

const limits = new DemoLimits({ file: join(folder, 'limits.json'), ceilingMicroUsd: Number(process.env.DEMO_CEILING_USD ?? 10) * 1_000_000 });
const demoStore = isPublic ? new DemoStore(join(folder, 'demo.db')) : null;
const app = appHandler({
  events,
  rules,
  cameras,
  setUp: (camera, pictures) =>
    setUpCamera({ pictures, baseWords: camera.baseWords, sam, spark: new SparkSetupPlanner(spark, camera.site) }),
  mediaDir,
  webDir: fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
  planner: new SparkQuestionPlanner(spark),
  guidePlanner,
  voiceNotes,
  writeCaption: new SparkAlertCaption(spark).write,
  backend,
  trials,
  pictureSize: async (camera) => {
    const { width = 0, height = 0 } = await sharp(await readFile(join(folder, 'cameras', camera.id, Object.values(camera.pictures)[0]!))).metadata();
    return { width, height };
  },
  following: {
    clips,
    things: new ClipThings(folder),
    follows: new Follows(folder, clips, sam, isPublic ? TRACK_SECONDS * TRACK_FPS : null),
    listThings: (picture) => followPlanner.listThings(picture),
    nameThing: async (picture, box) => followPlanner.nameThing(await cropAround(picture, box)),
    outlineAll: (picture, words) => sam.outlineAll(picture, words),
    outlineIn: (picture, size, box, name) => sam.outlineIn(picture, size, box, name),
    ...(demoStore
      ? {
          tracksOf: {
            add: (request: IncomingMessage, response: ServerResponse, clip: string, ids: string[]) => ids.forEach((id) => demoStore.addTrack(visitorOf(request, response), clip, id)),
            list: (request: IncomingMessage, response: ServerResponse, clip: string) => demoStore.tracks(visitorOf(request, response), clip),
          },
        }
      : {}),
  },
  timeZone,
  playing: (id) => {
    const now = playing.get(id)?.playing;
    return playing.has(id) ? { at: now?.at ?? null, picture: now?.picture.bytes ?? null } : null;
  },
  ...(isPublic
    ? {
        spend: async (request: IncomingMessage, response: ServerResponse, kind: 'look' | 'track') =>
          hasModels ? limits.charge(visitorOf(request, response), kind, COST_MICRO_USD[kind]) : NEEDS_KEYS,
      }
    : {}),
});

async function publicHandler() {
  const store = demoStore!;
  // Without a login nothing asks the engine for the backend: the route refuses first, and the copy already holds its clips.
  const engine = new DemoEngine({
    store,
    backend: backend ?? { demoScenario: unconnected, demoSchedule: unconnected, typeDemoRule: unconnected, demoRule: unconnected },
    folder: folder!,
    writeCaption: hasModels ? new SparkAlertCaption(spark).write : null,
  });
  const abilities = { models: hasModels, rules: backend !== null };
  let telegram = null;
  if (telegramApi) {
    const links = new TelegramLinks(join(folder!, 'telegram.db'));
    // A bot that cannot start leaves the page as a copy without one; the clips do not depend on it.
    const username = await telegramApi.me().then((me) => me.username, (error: unknown) => {
      console.error(`Telegram: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (username) {
    telegram = { links, botName: username, chat: telegramApi };
    const bot = new DemoBot({
      chat: telegramApi,
      links,
      store,
      engine,
      limits,
      cameras,
      clips,
      planner: guidePlanner,
      voiceNotes,
      alertsOf: (rule) => store.alerts(rule, 0),
      folder: folder!,
      page: DEMO_PAGE_URL ?? null,
      abilities,
    });
    void pollUpdates(telegramApi, (update) => void bot.handle(update));
    console.log(`Telegram: @${username}`);
    }
  }
  const footage = JSON.parse(await readFile(join(folder!, 'footage.json'), 'utf8').catch(() => '{}')) as { credit?: 'meva' };
  const detection =
    process.env.DETECT_URL && process.env.DETECT_SECRET
      ? new ClipDetection({ client: detectionClient({ url: process.env.DETECT_URL, secret: process.env.DETECT_SECRET }), videoOf: (clip) => join(folder!, 'clips', clip, 'clip.mp4') })
      : null;
  // Every clip is detected as the server starts, so a visitor's question is answered in seconds.
  if (detection) for (const clip of store.clips()) detection.ensure(clip.id);
  const demo = demoHandler({
    credit: footage.credit ?? null,
    engine,
    store,
    limits,
    clips,
    cameras,
    guidePlanner,
    asker: spark,
    voiceNotes,
    setUp: (bytes) =>
      setUpCamera({
        pictures: [{ label: 'picture', picture: { bytes, mimeType: 'image/jpeg' } }],
        baseWords: [],
        sam,
        spark: new SparkSetupPlanner(spark, 'a place someone wants to keep an eye on'),
      }),
    setUpNow: (camera, pictures) => setUpCamera({ pictures, baseWords: camera.baseWords, sam, spark: new SparkSetupPlanner(spark, camera.site) }),
    detection,
    folder: folder!,
    trackSeconds: TRACK_SECONDS,
    abilities,
    telegram,
  });
  return publicOnly({ app, demo });
}

const handler = isPublic ? await publicHandler() : app;
createServer((request, response) => void handler(request, response)).listen(Number(port), '127.0.0.1', () =>
  console.log(`${isPublic ? 'Public page' : 'App'}: http://127.0.0.1:${port}`),
);
