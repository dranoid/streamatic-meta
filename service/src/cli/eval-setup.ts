// Writes what setup measured on a group of cameras from their setup results, as eval/setup-coverage.json. It calls no model
// and copies no picture, and names neither the cameras nor their place.
// npm run eval-setup -- <app folder> <group> <out.json>

import { writeFile } from 'node:fs/promises';
import { CameraFolder } from '../cameras/camera-folder.js';
import { setupMeasure } from '../cameras/camera-zones.js';

const [folder, group, out] = process.argv.slice(2);
if (!folder || !group || !out) {
  console.error('Usage: npm run eval-setup -- <app folder> <group> <out.json>');
  process.exit(1);
}

const cameras = (await new CameraFolder(folder).list()).filter((c) => c.group === group);
const runs = cameras.flatMap((c) => (c.setup ? [{ pictures: Object.keys(c.pictures), setup: c.setup }] : []));
const measured = setupMeasure(runs);
await writeFile(out, `${JSON.stringify(measured, null, 2)}\n`);
console.log(measured.total);
