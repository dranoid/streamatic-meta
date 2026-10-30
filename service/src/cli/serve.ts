// Serves the app over one folder, on this computer only: events.db (events and rules), media/ (event pictures and clips)
// and cameras/ (one folder per camera). Setup and questions call SAM 3.1 and Muse Spark Open, so both keys must be in ../.env.
// A camera with a recording in cameras/<id>/episode/ plays it on a loop as its pictures, and its saved rules run on it.
// npm run serve -- <app folder> [port]

import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CameraFolder, type Camera } from '../cameras/camera-folder.js';
import { keepAlert } from '../events/keep-alert.js';
import { EventStore } from '../events/store.js';
import { keepAnswers } from '../live/answers-kept.js';
import { EpisodeLoop, readEpisode } from '../live/episode.js';
import { LiveCamera } from '../live/live-camera.js';
import { cropPicture } from '../rules/frame.js';
import { RULE_TIMING, RuleStore } from '../rules/rule-store.js';
import { zoneOutline } from '../rules/zone-rule.js';
import { SamClient } from '../sam/client.js';
import { setUpCamera } from '../setup/camera-setup.js';
import { SparkBoxJudge } from '../spark/box-judge.js';
import { SparkClient } from '../spark/client.js';
import { SparkQuestionPlanner } from '../spark/question-planner.js';
import { SparkSetupPlanner } from '../spark/setup-planner.js';
import { appHandler } from '../web/server.js';

const [folder, port = '8787'] = process.argv.slice(2);
const { META_MODEL_API_KEY: metaKey, BASETEN_API_KEY: basetenKey } = process.env;
if (!folder || !metaKey || !basetenKey) {
  console.error('Usage: npm run serve -- <app folder> [port]   (META_MODEL_API_KEY and BASETEN_API_KEY in ../.env)');
  process.exit(1);
}

const timeZone = 'Africa/Lagos';
// How often the loop hands its next pictures to the rules.
const POLL_MS = 2_000;
// The clip player shows this much either side of the pictures a check judged.
const AROUND_MS = 10_000;
const sam = new SamClient({ apiKey: metaKey });
const spark = new SparkClient({ apiKey: basetenKey });
const database = join(folder, 'events.db');
const events = new EventStore(database, timeZone);
const rules = new RuleStore(database);
const cameras = new CameraFolder(folder);
const mediaDir = join(folder, 'media');
await mkdir(mediaDir, { recursive: true });

const playing = new Map<string, EpisodeLoop>();
for (const camera of await cameras.list()) {
  if (!camera.episode) continue;
  const loop = new EpisodeLoop({ frames: await readEpisode(camera.episode) });
  const models = keepAnswers({ sam, judge: new SparkBoxJudge(spark, RULE_TIMING.sampleGapMs / 1000), crop: cropPicture });
  const live = new LiveCamera({
    source: loop,
    rules: () => rules.list(camera.id),
    ...models,
    timeZone,
    timing: RULE_TIMING,
    aroundMs: AROUND_MS,
  });
  playing.set(camera.id, loop);
  void play(camera, live);
}

async function play(camera: Camera, live: LiveCamera): Promise<never> {
  console.log(`${camera.name}: playing its recording on a loop`);
  for (;;) {
    try {
      const { settled } = await live.step();
      for (const { alert, rule, around } of settled) {
        const at = new Date(alert.at).toLocaleTimeString('en-GB', { timeZone });
        // Each pass of the loop raises the same alerts at the same recorded times; an event is kept once.
        const kept = events.list({ camera: camera.name, from: alert.at, to: alert.at }).find((e) => e.rule === alert.rule);
        if (kept) {
          console.log(`${camera.name}: rule ${rule.id} alerted at ${at}, already event ${kept.id}`);
          continue;
        }
        const id = await keepAlert({ alert, around, camera: camera.name, reference: rule.zones.map(zoneOutline).join(' '), store: events, mediaDir });
        console.log(`${camera.name}: rule ${rule.id} alerted at ${at}, kept as event ${id}`);
      }
    } catch (error) {
      // A failed model call is tried again on the next pass rather than stopping the camera.
      console.error(`${camera.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

const handler = appHandler({
  events,
  rules,
  cameras,
  setUp: (camera, pictures) =>
    setUpCamera({ pictures, baseWords: camera.baseWords, sam, spark: new SparkSetupPlanner(spark, camera.site) }),
  mediaDir,
  webDir: fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
  planner: new SparkQuestionPlanner(spark),
  timeZone,
  playing: (id) => {
    const now = playing.get(id)?.playing;
    return playing.has(id) ? { at: now?.at ?? null, picture: now?.picture.bytes ?? null } : null;
  },
});
createServer(handler).listen(Number(port), '127.0.0.1', () => console.log(`App: http://127.0.0.1:${port}`));
