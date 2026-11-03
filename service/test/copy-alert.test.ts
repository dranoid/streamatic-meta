import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackendAlert } from '../src/backend/client.js';
import { copyAlert, picturesAround, type CopyDeps } from '../src/events/copy-alert.js';
import { EventStore } from '../src/events/store.js';
import type { SavedRule } from '../src/rules/rule-store.js';

const TAR = 'c/d/batches/2026-11-02/20/100_115_ab.tar';
const frame = (member: number, seconds: number) => ({ objectKey: `${TAR}#${String(member).padStart(3, '0')}.jpg`, capturedAt: seconds * 1000, storageProvider: 's3' });
const alert: BackendAlert = {
  id: 'alert-1',
  cameraRuleId: 'rule-1',
  message: 'answered true',
  triggeredAt: '2026-11-02T20:00:00.000Z',
  evidence: { question: 'Is the door opening?', sampledFrames: [frame(5, 104), frame(8, 107)] },
};
const rule: SavedRule = {
  id: 1,
  camera: 'parlour',
  sentence: 'Tell me when the front door opens.',
  zones: [{ name: 'front door', kind: 'outline', word: 'door', reference: { left: 800, top: 300, right: 1000, bottom: 600 }, path: 'M800 300Z' }],
  activeHours: null,
  backendRuleId: 'rule-1',
  readsAs: 'Tell me if the door opens.',
  severalPictures: true,
  guidePlan: null,
};

async function setup(overrides: Partial<CopyDeps> = {}) {
  const mediaDir = await mkdtemp(join(tmpdir(), 'copy-alert-'));
  const store = new EventStore(':memory:', 'Africa/Lagos');
  const asked: string[] = [];
  const deps: CopyDeps = {
    store,
    mediaDir,
    pictureUrls: async (keys) => Object.fromEntries(keys.map((k) => [k, `https://pictures.test/${encodeURIComponent(k)}`])),
    download: async (url) => {
      const member = /%23(\d+)\.jpg$/.exec(url)![1]!;
      return Number(member) <= 12 ? new Uint8Array([Number(member)]) : null;
    },
    pickPicture: async (event) => {
      asked.push(event);
      return 1;
    },
    outlineAll: async () => ({
      door: [
        { word: 'door', objectId: '1', box: { left: 10, top: 10, right: 60, bottom: 60 }, path: 'M1 1Z' },
        { word: 'door', objectId: '2', box: { left: 810, top: 310, right: 990, bottom: 590 }, path: 'M9 9Z' },
      ],
    }),
    ...overrides,
  };
  return { deps, store, mediaDir, asked };
}

describe('copyAlert', () => {
  it('keeps the alert as an event on the picture Spark Open chose, with SAM’s outline of the zone', async () => {
    const { deps, store, asked } = await setup();

    const id = await copyAlert(alert, rule, 'Table parlour', deps);

    expect(store.get(id!)).toMatchObject({
      camera: 'Table parlour',
      zone: 'front door',
      rule: 'Tell me when the front door opens.',
      at: 107_000,
      picture: 'alert-1_107000.jpg',
      outline: 'M9 9Z',
      backendId: 'alert-1',
      recorded: false,
    });
    expect(asked).toEqual(['Is the door opening?']);
  });

  it('keeps one alert once, without asking the models again', async () => {
    let asks = 0;
    const { deps, store } = await setup({ pickPicture: async () => (asks++, 0) });

    await copyAlert(alert, rule, 'Table parlour', deps);
    const again = await copyAlert(alert, rule, 'Table parlour', deps);

    expect(again).toBeNull();
    expect(asks).toBe(1);
    expect(store.list({})).toHaveLength(1);
  });

  it('keeps the pictures around the alert for the player, skipping any no longer stored, with outlines only on what the rule looked at', async () => {
    const { deps, store, mediaDir } = await setup();

    const id = await copyAlert(alert, rule, 'Table parlour', deps);

    const frames = store.frames(id!);
    expect(frames.map((f) => f.at / 1000)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    expect(frames.filter((f) => f.outline !== null).map((f) => f.at / 1000)).toEqual([104, 107]);
    expect(await readdir(mediaDir)).toHaveLength(12);
  });

  it('does not store the event when a model call fails, so the next pass tries again', async () => {
    const { deps, store } = await setup({ outlineAll: async () => { throw new Error('busy'); } });

    await expect(copyAlert(alert, rule, 'Table parlour', deps)).rejects.toThrow('busy');

    expect(store.list({})).toEqual([]);
  });
});

describe('picturesAround', () => {
  it('works out a picture’s neighbours in its batch from its name and time', () => {
    const near = picturesAround([frame(2, 101)]);
    expect(near.map((f) => [f.objectKey.split('#')[1], f.capturedAt])).toEqual([
      ...Array.from({ length: 12 }, (_, i) => [`${String(i + 1).padStart(3, '0')}.jpg`, (100 + i) * 1000]),
    ]);
  });
});
