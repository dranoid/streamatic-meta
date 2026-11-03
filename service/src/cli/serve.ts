// Serves the app over one folder, on this computer only: events.db (events and rules), media/ (event pictures and clips)
// and cameras/ (one folder per camera). Setup and questions call SAM 3.1 and Muse Spark Open, so both keys must be in ../.env.
// A camera with a recording in cameras/<id>/episode/ plays it on a loop as its pictures. Rules live in Streamatic's backend,
// reached with STREAMATIC_API, STREAMATIC_COMPANY, STREAMATIC_EMAIL and STREAMATIC_PASSWORD; its alerts are copied here as events.
// With --public it serves the public page instead: only the demo, the clips and the About page, with spending limited per visitor.
// npm run serve -- <app folder> [port] [--public]

import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CameraFolder, type Camera } from '../cameras/camera-folder.js';
import { AlertCopier } from '../backend/alert-copier.js';
import { BackendClient } from '../backend/client.js';
import { Trials } from '../backend/trials.js';
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
import { appHandler } from '../web/server.js';

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
  });
  const copyAlerts = () =>
    copier.pass().catch((error: unknown) => console.error(`Copying alerts: ${error instanceof Error ? error.message : String(error)}`));
  void copyAlerts();
  setInterval(() => void copyAlerts(), COPY_ALERTS_MS);
}

const limits = new DemoLimits({ file: join(folder, 'limits.json'), ceilingMicroUsd: Number(process.env.DEMO_CEILING_USD ?? 10) * 1_000_000 });
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
    outlineAt: (picture, size, point, name) => sam.outlineAt(picture, size, point, name),
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

function publicHandler() {
  const store = new DemoStore(join(folder!, 'demo.db'));
  const demo = demoHandler({
    // Without a login nothing asks the engine for the backend: the route refuses first, and the copy already holds its clips.
    engine: new DemoEngine({ store, backend: backend ?? { demoScenario: unconnected, demoSchedule: unconnected, typeDemoRule: unconnected, demoRule: unconnected }, folder: folder! }),
    store,
    limits,
    clips,
    cameras,
    guidePlanner,
    setUp: (bytes) =>
      setUpCamera({
        pictures: [{ label: 'picture', picture: { bytes, mimeType: 'image/jpeg' } }],
        baseWords: [],
        sam,
        spark: new SparkSetupPlanner(spark, 'a place someone wants to keep an eye on'),
      }),
    folder: folder!,
    trackSeconds: TRACK_SECONDS,
    abilities: { models: hasModels, rules: backend !== null },
  });
  return publicOnly({ app, demo });
}

const handler = isPublic ? publicHandler() : app;
createServer((request, response) => void handler(request, response)).listen(Number(port), '127.0.0.1', () =>
  console.log(`${isPublic ? 'Public page' : 'App'}: http://127.0.0.1:${port}`),
);
