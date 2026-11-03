import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TOOLS = ['ffmpeg', 'ffprobe'];

export const MEDIA_TOOLS_NOTE =
  'Streamatic reads its clips with ffmpeg and ffprobe, and could not run: %TOOLS%. Please install ffmpeg (brew install ffmpeg on a Mac, sudo apt install ffmpeg on Ubuntu, or https://ffmpeg.org/download.html) and run this again.';

export async function missingMediaTools(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const found = await Promise.all(TOOLS.map((tool) => run(tool, ['-version'], { env }).then(() => true, () => false)));
  return TOOLS.filter((_, i) => !found[i]);
}

// Without them every clip fails with a page that cannot say why, so the server stops here and says.
export async function requireMediaTools(): Promise<void> {
  const missing = await missingMediaTools();
  if (missing.length === 0) return;
  console.error(MEDIA_TOOLS_NOTE.replace('%TOOLS%', missing.join(' and ')));
  process.exit(1);
}
