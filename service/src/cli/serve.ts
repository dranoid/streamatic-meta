// Serves the app over one folder, on this computer only: events.db (events and rules), media/ (event pictures and clips)
// and cameras/ (one folder per camera). Setup and questions call SAM 3.1 and Muse Spark Open, so both keys must be in ../.env.
// npm run serve -- <app folder> [port]

import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CameraFolder } from '../cameras/camera-folder.js';
import { EventStore } from '../events/store.js';
import { RuleStore } from '../rules/rule-store.js';
import { SamClient } from '../sam/client.js';
import { setUpCamera } from '../setup/camera-setup.js';
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
const sam = new SamClient({ apiKey: metaKey });
const spark = new SparkClient({ apiKey: basetenKey });
const database = join(folder, 'events.db');
const handler = appHandler({
  events: new EventStore(database, timeZone),
  rules: new RuleStore(database),
  cameras: new CameraFolder(folder),
  setUp: (camera, pictures) =>
    setUpCamera({ pictures, baseWords: camera.baseWords, sam, spark: new SparkSetupPlanner(spark, camera.site) }),
  mediaDir: join(folder, 'media'),
  webDir: fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
  planner: new SparkQuestionPlanner(spark),
  timeZone,
});
createServer(handler).listen(Number(port), '127.0.0.1', () => console.log(`App: http://127.0.0.1:${port}`));
