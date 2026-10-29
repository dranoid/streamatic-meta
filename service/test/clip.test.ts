import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { makeClip } from '../src/alerts/clip.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('makeClip', () => {
  it('turns the pictures into an MP4 video', async () => {
    const pictures = await Promise.all(
      [0, 80, 160].map(async (shade) =>
        new Uint8Array(await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: shade, g: shade, b: shade } } }).jpeg().toBuffer()),
      ),
    );

    const mp4 = await makeClip(pictures, 2);

    expect(new TextDecoder().decode(mp4.slice(4, 8))).toBe('ftyp');
    expect(mp4.length).toBeGreaterThan(500);
  });
});
