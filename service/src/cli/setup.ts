// Sets up one camera from its pictures: Spark lists what it sees, SAM 3.1 outlines it, Spark suggests rules.
// Spends about 3 Spark calls and 3 SAM calls per word per picture.
// npm run setup -- <out.json> "<site>" "<base words, comma-separated>" day=<a.jpg> dusk=<b.jpg> night=<c.jpg>

import { readFile, writeFile } from 'node:fs/promises';
import { SamClient } from '../sam/client.js';
import { setUpCamera } from '../setup/camera-setup.js';
import { SparkClient } from '../spark/client.js';
import { SparkSetupPlanner } from '../spark/setup-planner.js';

const [outPath, site, baseList, ...pictureArgs] = process.argv.slice(2);
const apiKey = process.env.META_MODEL_API_KEY;
if (!outPath || !site || baseList === undefined || pictureArgs.length === 0 || !apiKey) {
  console.error('Usage: npm run setup -- <out.json> "<site>" "<base words>" <label>=<picture>... (META_MODEL_API_KEY in ../.env)');
  process.exit(1);
}

const pictures = await Promise.all(
  pictureArgs.map(async (arg) => {
    const [label, path] = arg.split('=', 2) as [string, string];
    const mimeType = path.toLowerCase().endsWith('.png') ? ('image/png' as const) : ('image/jpeg' as const);
    return { label, picture: { bytes: await readFile(path), mimeType } };
  }),
);

const setup = await setUpCamera({
  pictures,
  baseWords: baseList.split(',').map((w) => w.trim()),
  sam: new SamClient({ apiKey }),
  spark: new SparkSetupPlanner(new SparkClient({ apiKey }), site),
});
await writeFile(outPath, JSON.stringify(setup, null, 1));

for (const zone of setup.zones) {
  const counts = Object.entries(zone.outlines).map(([label, o]) => `${label} ${o.length}`).join(', ');
  console.log(`zone  ${zone.name.padEnd(18)} ${zone.item === zone.name ? '' : `(Spark: ${zone.item}) `}${counts}`);
}
for (const miss of setup.notOutlined) console.log(`miss  ${miss.item.padEnd(18)} tried ${miss.triedWords.join(', ')}`);
for (const rule of setup.rules) console.log(`rule  ${rule.sentence}`);
