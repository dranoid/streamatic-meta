import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClipDetection, detectionClient, type DetectionClient } from '../src/demo/clip-detection.js';

const FOUND = { fps: 5, width: 1280, height: 720, tracks: [] };
const settled = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((done) => setTimeout(done, 5));
};

async function detectionWith(client: DetectionClient) {
  const root = await mkdtemp(join(tmpdir(), 'detect-'));
  await writeFile(join(root, 'clip-1.mp4'), new Uint8Array([1, 2, 3]));
  return new ClipDetection({ client, videoOf: (clip) => join(root, `${clip}.mp4`), pollMs: 1 });
}

describe('detecting a clip', () => {
  it('sends the clip once, however often it is asked for, and holds what it found', async () => {
    const sent: number[][] = [];
    let polls = 0;
    const detection = await detectionWith({
      start: async (video) => (sent.push([...video]), 'call-1'),
      result: async () => (++polls < 3 ? null : FOUND),
    });
    expect(detection.state('clip-1')).toBe('none');
    detection.ensure('clip-1');
    detection.ensure('clip-1');
    expect(detection.state('clip-1')).toBe('running');
    expect(detection.found('clip-1')).toBeNull();
    await settled(() => detection.state('clip-1') === 'ready');
    detection.ensure('clip-1');
    expect(sent).toEqual([[1, 2, 3]]);
    expect(detection.found('clip-1')).toEqual(FOUND);
  });

  it('runs a failed clip again when asked, and stops after three runs', async () => {
    let starts = 0;
    const detection = await detectionWith({
      start: async () => {
        starts += 1;
        throw new Error('The detector could not be reached');
      },
      result: async () => null,
    });
    for (let run = 1; run <= 5; run++) {
      detection.ensure('clip-1');
      await settled(() => detection.state('clip-1') === 'failed');
    }
    expect(starts).toBe(3);
    expect(detection.state('clip-1')).toBe('failed');
  });

  it('marks a clip whose video cannot be read as failed', async () => {
    const detection = await detectionWith({ start: async () => 'call', result: async () => FOUND });
    detection.ensure('no-such-clip');
    await settled(() => detection.state('no-such-clip') === 'failed');
    expect(detection.state('no-such-clip')).toBe('failed');
  });
});

describe('the detector client', () => {
  const replying = (replies: Response[], seen: Array<[string, RequestInit | undefined]> = []) =>
    (async (url: string, init?: RequestInit) => (seen.push([url, init]), replies.shift()!)) as unknown as typeof fetch;

  it('sends the secret with the clip and reads the call back', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const client = detectionClient({ url: 'https://d.test', secret: 's3', fetch: replying([Response.json({ call: 'fc-1' })], seen) });
    expect(await client.start(new Uint8Array([9]))).toBe('fc-1');
    expect(seen[0]![0]).toBe('https://d.test/start');
    expect(seen[0]![1]).toMatchObject({ method: 'POST', headers: { 'x-detect-secret': 's3' } });
  });

  it('reads a run still going as null, a finished one as its tracks, and anything else as a failure', async () => {
    const client = detectionClient({
      url: 'https://d.test',
      secret: 's3',
      fetch: replying([new Response('{}', { status: 202 }), Response.json({ ...FOUND, tracks: [{ id: 1, kind: 'person', points: [[0, 1, 2, 3, 4]] }] }), new Response('', { status: 500 }), new Response('', { status: 401 })]),
    });
    expect(await client.result('fc-1')).toBeNull();
    expect((await client.result('fc-1'))?.tracks).toHaveLength(1);
    await expect(client.result('fc-1')).rejects.toThrow('status 500');
    await expect(client.result('fc-1')).rejects.toThrow('status 401');
  });
});
