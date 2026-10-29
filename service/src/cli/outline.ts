// Outlines one picture under each word and prints how many things SAM 3.1 found.
// npm run outline -- <picture.jpg> <out.json> gate wall keke

import { readFile, writeFile } from 'node:fs/promises';
import { SamClient } from '../sam/client.js';

const [picturePath, outPath, ...words] = process.argv.slice(2);
const apiKey = process.env.META_MODEL_API_KEY;
if (!picturePath || !outPath || words.length === 0 || !apiKey) {
  console.error('Usage: npm run outline -- <picture.jpg> <out.json> <word>... (META_MODEL_API_KEY in ../.env)');
  process.exit(1);
}

const mimeType = picturePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const found = await new SamClient({ apiKey }).outlineAll({ bytes: await readFile(picturePath), mimeType }, words);
await writeFile(outPath, JSON.stringify(found, null, 1));
for (const [word, outlines] of Object.entries(found)) {
  console.log(`${word.padEnd(16)} ${outlines.length}`);
}
