import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CameraFolder } from '../src/cameras/camera-folder.js';
import { EventStore } from '../src/events/store.js';
import type { Plan } from '../src/questions/answer.js';
import { RuleStore } from '../src/rules/rule-store.js';
import type { CameraSetup } from '../src/setup/camera-setup.js';
import { appHandler } from '../src/web/server.js';

const AT = Date.UTC(2026, 9, 28, 20, 24, 15);
const doorBox = { left: 869, top: 317, right: 1053, bottom: 592 };
const setupResult: CameraSetup = {
  zones: [
    {
      name: 'door',
      item: 'door',
      seenAt: ['day', 'night'],
      outlines: {
        day: [{ word: 'door', objectId: '0', box: { left: 1, top: 1, right: 5, bottom: 5 }, path: 'M1 1Z' }],
        night: [
          { word: 'door', objectId: '0', box: { left: 2, top: 2, right: 6, bottom: 6 }, path: 'M2 2Z' },
          { word: 'door', objectId: '1', box: doorBox, path: 'M869 317Z' },
        ],
      },
    },
  ],
  notOutlined: [],
  rules: [{ sentence: 'Alert me if the door opens.', zones: ['door'] }],
};

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function start({ plan, setUp }: { plan?: Plan; setUp?: () => Promise<CameraSetup> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'app-'));
  const web = join(root, 'web');
  const media = join(root, 'media');
  const camera = join(root, 'cameras', 'table-parlour');
  await Promise.all([mkdir(web), mkdir(media), mkdir(camera, { recursive: true })]);
  await Promise.all([
    writeFile(join(web, 'index.html'), '<title>Streamatic</title>'),
    mkdir(join(web, 'assets')).then(() => writeFile(join(web, 'assets', 'app.js'), 'console.log(1)')),
    writeFile(join(media, 'door.jpg'), 'jpeg bytes'),
    writeFile(join(camera, 'day.jpg'), 'day bytes'),
    writeFile(join(camera, 'night.jpg'), 'night bytes'),
    writeFile(
      join(camera, 'camera.json'),
      JSON.stringify({ name: 'Table parlour', site: 'a family home', baseWords: ['door'], pictures: { day: 'day.jpg', night: 'night.jpg' } }),
    ),
  ]);
  const events = new EventStore(':memory:', 'Africa/Lagos');
  const eventId = events.add({
    camera: 'Table parlour',
    zone: 'front door',
    rule: 'Alert me if the front door opens after 9 pm.',
    at: AT,
    picture: 'door.jpg',
    clip: null,
    outline: 'M1 1Z',
    reference: 'M2 2Z',
  });
  events.addFrames(eventId, [
    { at: AT - 1000, file: 'before.jpg', outline: null },
    { at: AT, file: 'door.jpg', outline: 'M1 1Z' },
  ]);
  const questions: string[] = [];
  const setUpCalls: string[][] = [];
  server = createServer(
    appHandler({
      events,
      rules: new RuleStore(':memory:'),
      cameras: new CameraFolder(root),
      mediaDir: media,
      webDir: web,
      planner: { plan: async (q) => (questions.push(q), plan ?? { tool: 'count', camera: null, zone: 'front door', period: 'all', hours: null }) },
      setUp: async (_camera, pictures) => {
        setUpCalls.push(pictures.map((p) => `${p.label}:${new TextDecoder().decode(p.picture.bytes)}`));
        return setUp ? setUp() : setupResult;
      },
      timeZone: 'Africa/Lagos',
      now: () => AT + 60_000,
    }),
  );
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: (await response.json()) as any };
  };
  const post = (path: string, body: unknown) =>
    json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { base, eventId, questions, setUpCalls, json, post };
}

describe('pages', () => {
  it("serves the app's page for every page path, and its scripts", async () => {
    const { base } = await start();
    for (const path of ['/', '/cameras', '/events/1']) {
      const page = await fetch(`${base}${path}`);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(await page.text()).toBe('<title>Streamatic</title>');
    }
    const script = await fetch(`${base}/assets/app.js`);
    expect(script.headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${base}/assets/..%2F..%2Fmedia%2Fdoor.jpg`)).status).toBe(404);
  });
});

describe('events', () => {
  it('lists the stored events and returns one by id', async () => {
    const { json, eventId } = await start();
    expect((await json('/api/events')).body.map((e: any) => e.id)).toEqual([eventId]);
    expect((await json(`/api/events/${eventId}`)).body).toMatchObject({ zone: 'front door', outline: 'M1 1Z' });
    expect((await json('/api/events/999')).status).toBe(404);
  });

  it("returns an event's frames in time order", async () => {
    const { json, eventId } = await start();
    expect((await json(`/api/events/${eventId}/frames`)).body).toEqual([
      { at: AT - 1000, file: 'before.jpg', outline: null },
      { at: AT, file: 'door.jpg', outline: 'M1 1Z' },
    ]);
  });

  it('serves an event picture from the media folder and nothing outside it', async () => {
    const { base } = await start();
    const picture = await fetch(`${base}/media/door.jpg`);
    expect(picture.headers.get('content-type')).toBe('image/jpeg');
    expect(await picture.text()).toBe('jpeg bytes');
    expect((await fetch(`${base}/media/..%2Fweb%2Findex.html`)).status).toBe(404);
  });

  it('answers a question with the count and the events behind it', async () => {
    const { post, eventId, questions } = await start();
    const { body } = await post('/api/questions', { question: 'How many times did the front door open?' });
    expect(questions).toEqual(['How many times did the front door open?']);
    expect(body).toMatchObject({ count: 1, eventIds: [eventId] });
    expect(body.text).toContain('1 time');
  });

  it('refuses an empty question', async () => {
    const { post, questions } = await start();
    expect((await post('/api/questions', { question: ' ' })).status).toBe(400);
    expect(questions).toEqual([]);
  });
});

describe('cameras', () => {
  it('lists each camera with its pictures, before setup has run', async () => {
    const { json, base } = await start();
    expect((await json('/api/cameras')).body).toEqual([
      { id: 'table-parlour', name: 'Table parlour', site: 'a family home', baseWords: ['door'], pictures: { day: 'day.jpg', night: 'night.jpg' }, setup: null },
    ]);
    expect(await (await fetch(`${base}/camera-pictures/table-parlour/day.jpg`)).text()).toBe('day bytes');
    expect((await fetch(`${base}/camera-pictures/table-parlour/..%2Fcamera.json`)).status).toBe(404);
  });

  it("runs setup on the camera's labelled pictures and keeps the result", async () => {
    const { json, post, setUpCalls } = await start();
    const { status, body } = await post('/api/cameras/table-parlour/setup', {});
    expect(status).toBe(200);
    expect(body.rules).toEqual(setupResult.rules);
    expect(setUpCalls).toEqual([['day:day bytes', 'night:night bytes']]);
    expect((await json('/api/cameras')).body[0].setup.zones[0].name).toBe('door');
  });

  it('refuses a second setup on a camera while one is running', async () => {
    let finish!: (s: CameraSetup) => void;
    const { post, setUpCalls } = await start({ setUp: () => new Promise((r) => (finish = r)) });
    const first = post('/api/cameras/table-parlour/setup', {});
    await new Promise((r) => setTimeout(r, 50));
    expect((await post('/api/cameras/table-parlour/setup', {})).status).toBe(409);
    finish(setupResult);
    expect((await first).status).toBe(200);
    expect(setUpCalls).toHaveLength(1);
  });

  it('answers 404 for a camera that does not exist', async () => {
    const { post } = await start();
    expect((await post('/api/cameras/nowhere/setup', {})).status).toBe(404);
  });
});

describe('rules', () => {
  const outlineRule = {
    camera: 'table-parlour',
    sentence: 'Alert me if the front door opens after 9 pm.',
    zone: { kind: 'outline', name: 'front door', word: 'door', label: 'night', objectId: '1' },
    activeHours: { from: 21, to: 6 },
  };

  it("saves an outline zone with the box and outline SAM drew at setup, then lists and removes it", async () => {
    const { json, post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const saved = await post('/api/rules', outlineRule);
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      camera: 'table-parlour',
      zone: { name: 'front door', kind: 'outline', word: 'door', reference: doorBox, path: 'M869 317Z' },
      question: null,
      activeHours: { from: 21, to: 6 },
    });
    expect((await json('/api/rules?camera=table-parlour')).body.map((r: any) => r.id)).toEqual([saved.body.id]);
    expect((await json(`/api/rules/${saved.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('refuses an outline that setup did not produce, and saves nothing', async () => {
    const { json, post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const refused = await post('/api/rules', { ...outlineRule, zone: { ...outlineRule.zone, objectId: '7' } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/outline/i);
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('saves a drawn box with its question, and refuses one without a question', async () => {
    const { post } = await start();
    const box = { kind: 'box', name: 'doorway', box: { left: 10, top: 20, right: 30, bottom: 40 } };
    expect((await post('/api/rules', { ...outlineRule, zone: box })).status).toBe(400);
    const saved = await post('/api/rules', { ...outlineRule, zone: { ...box, question: 'Is the door open?' } });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ zone: { kind: 'box', name: 'doorway', box: box.box }, question: 'Is the door open?' });
  });
});
