import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClipFolder } from '../src/follow/clips.js';
import { Follows, spansOf } from '../src/follow/follows.js';
import { ClipThings } from '../src/follow/things.js';
import { SamClient } from '../src/sam/client.js';
import { framesFromText } from '../src/sam/outlines.js';

const reply = readFileSync(new URL('./fixtures/g424-follow.txt', import.meta.url), 'utf8');
const size = { width: 1280, height: 720 };
const box = { left: 411, top: 413, right: 643, bottom: 516 };

async function makeClip(): Promise<{ root: string; clips: ClipFolder }> {
  const root = await mkdtemp(join(tmpdir(), 'streamatic-follow-'));
  const dir = join(root, 'clips', 'yard');
  await mkdir(dir, { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=2', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  await writeFile(join(dir, 'clip.json'), JSON.stringify({ name: 'Yard', video: 'clip.mp4' }));
  return { root, clips: new ClipFolder(root) };
}

function streamed(text: string, cut = 200): Response {
  const events = [];
  for (let i = 0; i < text.length; i += cut) events.push({ type: 'response.output_text.delta', delta: text.slice(i, i + cut) });
  events.push({ type: 'response.completed' });
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
}

describe('framesFromText', () => {
  it('reads each frame of a reply, in frame order, whatever order the reply came in', async () => {
    const frames = await framesFromText(reply);
    expect(frames.map((f) => f.frame)).toEqual([28, 29, 30, 31, 32]);
    expect(frames[2]!.box.left).toBeGreaterThan(300);
    expect(frames[2]!.path).toMatch(/^M\d/);
  });
});

describe('spansOf', () => {
  it('joins frames a short gap apart and splits at a long one', () => {
    const frames = [0, 1, 2, 5, 6, 40, 41].map((frame) => ({ frame }));
    expect(spansOf(frames, 10)).toEqual([{ from: 0, to: 6 }, { from: 40, to: 41 }]);
  });
  it('is empty when the thing was never seen', () => expect(spansOf([], 10)).toEqual([]));
});

describe('SamClient.track', () => {
  it('prompts with the box on its frame, reports frames as they arrive and returns them', async () => {
    let sent: any;
    const client = new SamClient({
      apiKey: 'test',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return streamed(reply);
      },
    });
    const seen: number[] = [];
    const frames = await client.track('file-1', size, 30, { box }, (n) => seen.push(n));

    expect(sent.model).toBe('sam-3.1');
    expect(sent.stream).toBe(true);
    expect(sent.input[0].content).toEqual([
      { type: 'input_text', text: '<30f>1<|box;x1=411;y1=413;x2=642;y2=515;w=1280;h=720|>' },
      { type: 'input_video', file_id: 'file-1' },
    ]);
    expect(frames).toHaveLength(5);
    expect(seen[seen.length - 1]).toBe(5);
  });

  it('prompts with a click when given a point', async () => {
    let sent: any;
    const client = new SamClient({ apiKey: 'test', fetch: async (_u, init) => ((sent = JSON.parse(String(init?.body))), streamed(reply)) });
    await client.track('file-1', size, 7, { point: { x: 20, y: 30 } }, () => {});
    expect(sent.input[0].content[0].text).toBe('<7f>1<|point;x=20;y=30;w=1280;h=720|>');
  });

  it('keeps a box that reaches the picture edge inside the picture', async () => {
    let sent: any;
    const client = new SamClient({ apiKey: 'test', fetch: async (_u, init) => ((sent = JSON.parse(String(init?.body))), streamed(reply)) });
    await client.track('file-1', size, 0, { box: { left: 1000, top: 600, right: 1290, bottom: 725 } }, () => {});
    expect(sent.input[0].content[0].text).toBe('<0f>1<|box;x1=1000;y1=600;x2=1279;y2=719;w=1280;h=720|>');
  });

  it('fails plainly when the reply stream reports a failure', async () => {
    const body = `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'no' } } })}\n\n`;
    const client = new SamClient({ apiKey: 'test', fetch: async () => new Response(body, { status: 200 }) });
    await expect(client.track('file-1', size, 0, { box }, () => {})).rejects.toThrow();
  });
});

describe('ClipFolder', () => {
  it('reads the size, rate and length of a clip from the video', async () => {
    const { clips } = await makeClip();
    expect(await clips.get('yard')).toMatchObject({ id: 'yard', name: 'Yard', width: 64, height: 36, fps: 10, frames: 20 });
    expect((await clips.list()).map((c) => c.id)).toEqual(['yard']);
  });
  it('refuses an id that leaves the clips folder', async () => {
    const { clips } = await makeClip();
    expect(await clips.get('../yard')).toBeNull();
  });
  it('gives the picture of a frame, and none past the end', async () => {
    const { clips } = await makeClip();
    const picture = await clips.picture('yard', 3);
    expect(picture![0]).toBe(0xff);
    expect(await clips.picture('yard', 500)).toBeNull();
  });
});

describe('ClipThings', () => {
  const outline = (name: string, left: number) => ({ word: name, objectId: '0', box: { left, top: 0, right: left + 10, bottom: 10 }, path: `M${left} 0Z` });

  it('accumulates what several searches find on one frame', async () => {
    const { root } = await makeClip();
    const things = new ClipThings(root);
    await things.add('yard', 3, [outline('car', 0)]);
    const all = await things.add('yard', 3, [outline('person', 50)]);
    expect(all.map((t) => t.name)).toEqual(['car', 'person']);
    expect(new Set(all.map((t) => t.id)).size).toBe(2);
    expect(await new ClipThings(root).list('yard', 3)).toEqual(all);
    expect(await things.list('yard', 4)).toEqual([]);
  });

  it('keeps one thing when a second word outlines the same place', async () => {
    const { root } = await makeClip();
    const things = new ClipThings(root);
    await things.add('yard', 3, [outline('car', 0)]);
    const all = await things.add('yard', 3, [outline('vehicle', 0)]);
    expect(all.map((t) => t.name)).toEqual(['car']);
  });
});

describe('Follows', () => {
  const thing = { id: 't1', name: 'car', box, path: 'M0 0Z' };

  async function run(track: any) {
    const { root, clips } = await makeClip();
    const sam = { upload: vi.fn(async () => 'file-1'), track };
    return { root, clips, sam, follows: new Follows(root, clips, sam) };
  }
  const settled = async (follows: Follows, id: string) => {
    for (let i = 0; i < 100; i++) {
      const job = await follows.get('yard', id);
      if (job && job.state !== 'running') return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('never settled');
  };

  it('tracks the selected thing from its box and keeps when it was in view', async () => {
    const { follows, sam } = await run(vi.fn(async (_f: string, _s: unknown, _n: number, _t: unknown, on: (n: number) => void) => {
      on(2);
      return [{ frame: 3, box, path: 'M1 1Z' }, { frame: 4, box, path: 'M1 1Z' }];
    }));
    const id = await follows.start('yard', 3, thing);
    const job = await settled(follows, id);
    expect(job).toMatchObject({ state: 'done', framesSeen: 2, follow: { name: 'car', frame: 3, spans: [{ from: 3, to: 4 }] } });
    expect(sam.track.mock.calls[0]!.slice(0, 4)).toEqual(['file-1', { width: 64, height: 36 }, 3, { box }]);
  });

  it('tracks a long clip only around the selection, and reports frames by their number in the clip', async () => {
    const { root, clips } = await makeClip();
    const uploaded: number[] = [];
    const asked: number[] = [];
    const follows = new Follows(
      root,
      clips,
      {
        upload: async (video) => {
          const file = join(root, 'stretch.mp4');
          await writeFile(file, video);
          uploaded.push(Number(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]).toString().trim()));
          return 'file-1';
        },
        track: async (_file, _size, frame) => (asked.push(frame), [{ frame, box, path: 'M0 0Z' }]),
      },
      3,
    );
    const id = await follows.start('yard', 10, { name: 'car', box });
    await vi.waitFor(async () => expect((await follows.get('yard', id))?.state).toBe('done'));
    expect(uploaded).toEqual([7]);
    expect(asked).toEqual([3]);
    const job = await follows.get('yard', id);
    expect(job?.state === 'done' && job.follow.frames.map((f) => f.frame)).toEqual([10]);
    expect(job?.state === 'done' && job.follow.spans).toEqual([{ from: 10, to: 10 }]);
  });

  it('says whether a selection is kept, so asking again need not be charged', async () => {
    const { root, clips } = await makeClip();
    const follows = new Follows(root, clips, { upload: async () => 'file-1', track: async (_f, _s, frame) => [{ frame, box, path: 'M0 0Z' }] });
    expect(await follows.isKept('yard', 5, box)).toBe(false);
    const id = await follows.start('yard', 5, { name: 'car', box });
    await vi.waitFor(async () => expect((await follows.get('yard', id))?.state).toBe('done'));
    expect(await follows.isKept('yard', 5, box)).toBe(true);
  });

  it('does not pay twice for the same selection, and keeps the result across a restart', async () => {
    const { follows, sam, root, clips } = await run(vi.fn(async () => [{ frame: 3, box, path: 'M1 1Z' }]));
    const id = await follows.start('yard', 3, thing);
    await settled(follows, id);
    expect(await follows.start('yard', 3, thing)).toBe(id);
    const later = new Follows(root, clips, sam);
    expect(await later.start('yard', 3, thing)).toBe(id);
    expect(sam.track).toHaveBeenCalledTimes(1);
    expect((await later.list('yard')).map((f) => f.name)).toEqual(['car']);
  });

  it('reports a failed call and allows another try', async () => {
    const track = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue([{ frame: 3, box, path: 'M1 1Z' }]);
    const { follows } = await run(track);
    const id = await follows.start('yard', 3, thing);
    expect(await settled(follows, id)).toMatchObject({ state: 'failed' });
    await follows.start('yard', 3, thing);
    expect(await settled(follows, id)).toMatchObject({ state: 'done' });
  });

  it('says so when the selection was not found anywhere in the clip', async () => {
    const { follows } = await run(vi.fn(async () => []));
    const job = await settled(follows, await follows.start('yard', 3, thing));
    expect(job).toMatchObject({ state: 'done', follow: { spans: [] } });
  });
});
