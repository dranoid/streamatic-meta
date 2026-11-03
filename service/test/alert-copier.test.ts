import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlertCopier } from '../src/backend/alert-copier.js';
import type { BackendAlert } from '../src/backend/client.js';
import { CameraFolder } from '../src/cameras/camera-folder.js';
import { EventStore } from '../src/events/store.js';
import { RuleStore } from '../src/rules/rule-store.js';

const alertAt = (id: string, iso: string): BackendAlert => ({ id, cameraRuleId: 'backend-1', message: 'answered true', triggeredAt: iso, evidence: { question: 'q', sampledFrames: [] } });

async function setup(backend: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'copier-'));
  await mkdir(join(root, 'cameras', 'parlour'), { recursive: true });
  await writeFile(join(root, 'cameras', 'parlour', 'camera.json'), JSON.stringify({ name: 'Table parlour', site: 's', baseWords: [], pictures: {}, backend }));
  const store = new EventStore(':memory:', 'Africa/Lagos');
  const rules = new RuleStore(':memory:');
  rules.add({
    camera: 'parlour',
    sentence: 'Tell me when the door opens.',
    zones: [{ name: 'door', kind: 'box', box: { left: 0, top: 0, right: 1, bottom: 1 }, question: 'q' }],
    activeHours: null,
    backendRuleId: 'backend-1',
    readsAs: 'r',
    severalPictures: false,
    guidePlan: null,
  });
  const alerts = [alertAt('inside', '2026-11-02T21:00:00.000Z'), alertAt('outside', '2026-11-03T09:00:00.000Z')];
  const copier = new AlertCopier({
    backend: { alerts: async () => alerts },
    rules,
    cameras: new CameraFolder(root),
    copy: { store, mediaDir: root, pictureUrls: async () => ({}), download: async () => null, pickPicture: async () => 0, outlineAll: async () => ({}) },
  });
  return { copier, store };
}

describe('AlertCopier', () => {
  it('copies only the alerts inside a camera’s stored hours, because the app never sees its other hours', async () => {
    const { copier, store } = await setup({ deviceId: 'd', recorded: { from: '2026-11-02T20:00:00.000Z', to: '2026-11-02T22:00:00.000Z' } });

    expect(await copier.pass()).toBe(1);

    expect(store.list({}).map((e) => e.backendId)).toEqual(['inside']);
  });

  it('copies every alert from a camera with no stored hours, once', async () => {
    const { copier, store } = await setup({ deviceId: 'd', recorded: null });

    expect(await copier.pass()).toBe(2);
    expect(await copier.pass()).toBe(0);

    expect(store.list({})).toHaveLength(2);
  });
});
