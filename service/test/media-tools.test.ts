import { describe, expect, it } from 'vitest';
import { missingMediaTools, MEDIA_TOOLS_NOTE } from '../src/cameras/media-tools.js';

describe('missingMediaTools', () => {
  it('names nothing when ffmpeg and ffprobe can both be run', async () => {
    expect(await missingMediaTools()).toEqual([]);
  });

  it('names both when neither can be found', async () => {
    expect(await missingMediaTools({ PATH: '/nowhere' })).toEqual(['ffmpeg', 'ffprobe']);
  });

  it('tells the person what to install', () => {
    expect(MEDIA_TOOLS_NOTE).toMatch(/install ffmpeg/i);
  });
});
