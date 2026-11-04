// Prepares the public page's folder from <folder>/demo.json, a list of {id, scenario, site, words, stillSeconds}, where scenario
// is a clip baked into Streamatic. For each clip it copies the video at the page's size, runs setup on one frame (about 3 Spark
// calls and 1 SAM call per word) and copies each rule's alert points. A step already done is not done or paid for again.
// Reads STREAMATIC_API, STREAMATIC_COMPANY, STREAMATIC_EMAIL and STREAMATIC_PASSWORD, and both keys from ../.env.
// npm run demo-prepare -- <folder>

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BackendClient } from '../backend/client.js';
import { CameraFolder } from '../cameras/camera-folder.js';
import { DemoEngine } from '../demo/engine.js';
import { DemoStore } from '../demo/store.js';
import { ClipFolder } from '../follow/clips.js';
import { SamClient } from '../sam/client.js';
import { setUpCamera } from '../setup/camera-setup.js';
import { SparkClient } from '../spark/client.js';
import { SparkSetupPlanner } from '../spark/setup-planner.js';
import { SparkAlertCaption } from '../spark/alert-caption.js';
import { requireMediaTools } from '../cameras/media-tools.js';

const run = promisify(execFile);
const PAGE_WIDTH = 1280;
const PAGE_FPS = 10;
const LABEL = 'clip';

const [folder] = process.argv.slice(2);
const { META_MODEL_API_KEY: metaKey, BASETEN_API_KEY: basetenKey, STREAMATIC_API, STREAMATIC_COMPANY, STREAMATIC_EMAIL, STREAMATIC_PASSWORD } = process.env;
if (!folder || !metaKey || !basetenKey || !STREAMATIC_API || !STREAMATIC_COMPANY || !STREAMATIC_EMAIL || !STREAMATIC_PASSWORD) {
  console.error('Usage: npm run demo-prepare -- <folder>   (both keys in ../.env, STREAMATIC_* in the environment)');
  process.exit(1);
}

await requireMediaTools();

const list = z
  .array(z.object({ id: z.string().regex(/^[\w-]+$/), scenario: z.string(), site: z.string(), words: z.array(z.string()), stillSeconds: z.number().min(0) }))
  .parse(JSON.parse(await readFile(join(folder, 'demo.json'), 'utf8')));

const backend = new BackendClient({ baseUrl: STREAMATIC_API, companyId: STREAMATIC_COMPANY, email: STREAMATIC_EMAIL, password: STREAMATIC_PASSWORD });
const clips = new ClipFolder(folder);
const cameras = new CameraFolder(folder);
const sam = new SamClient({ apiKey: metaKey });
const spark = new SparkClient({ apiKey: basetenKey });
const engine = new DemoEngine({ store: new DemoStore(join(folder, 'demo.db')), backend, folder, writeCaption: new SparkAlertCaption(spark).write });
const exists = async (path: string) => (await stat(path).catch(() => null)) !== null;

for (const { id, scenario, site, words, stillSeconds } of list) {
  const found = await backend.demoScenario(scenario);
  const clipDir = join(folder, 'clips', id);
  await mkdir(clipDir, { recursive: true });
  if (!(await exists(join(clipDir, 'clip.mp4')))) {
    if (!found.playback.url) throw new Error(`${id}: the backend has no video for this clip.`);
    const reply = await fetch(found.playback.url);
    if (!reply.ok) throw new Error(`${id}: the video could not be fetched (${reply.status}).`);
    const scratch = await mkdtemp(join(tmpdir(), 'demo-prepare-'));
    try {
      await writeFile(join(scratch, 'baked.mp4'), new Uint8Array(await reply.arrayBuffer()));
      await run('ffmpeg', ['-v', 'error', '-y', '-i', join(scratch, 'baked.mp4'), '-vf', `fps=${PAGE_FPS},scale=${PAGE_WIDTH}:-2`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(clipDir, 'clip.mp4')]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    console.log(`${id}: video copied`);
  }
  await writeFile(join(clipDir, 'clip.json'), JSON.stringify({ name: found.name, video: 'clip.mp4' }));

  const cameraDir = join(folder, 'cameras', id);
  await mkdir(cameraDir, { recursive: true });
  // A camera already described keeps its own pictures and group.
  if (!(await exists(join(cameraDir, 'camera.json')))) await writeFile(join(cameraDir, 'camera.json'), JSON.stringify({ name: found.name, site, baseWords: words, pictures: { [LABEL]: 'still.jpg' } }));
  if (!(await exists(join(cameraDir, 'setup.json')))) {
    const still = await clips.picture(id, Math.round(stillSeconds * PAGE_FPS));
    if (!still) throw new Error(`${id}: there is no frame at ${stillSeconds} s.`);
    await writeFile(join(cameraDir, 'still.jpg'), still);
    const setup = await setUpCamera({
      pictures: [{ label: LABEL, picture: { bytes: still, mimeType: 'image/jpeg' } }],
      baseWords: words,
      sam,
      spark: new SparkSetupPlanner(spark, site),
    });
    await cameras.saveSetup(id, setup);
    console.log(`${id}: setup found ${setup.zones.map((z) => z.name).join(', ')}`);
  }

  await engine.copyClip({ id, scenario });
  console.log(`${id}: alert points copied`);
}
