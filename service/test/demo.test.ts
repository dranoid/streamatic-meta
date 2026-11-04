import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { CameraFolder } from '../src/cameras/camera-folder.js';
import { alertShownMs, DemoEngine, showing, type DemoEngineBackend } from '../src/demo/engine.js';
import { DemoLimits } from '../src/demo/limits.js';
import type { ToolAsker } from '../src/demo/clip-questions.js';
import type { ClipDetection } from '../src/demo/clip-detection.js';
import type { ClipDetections } from '../src/demo/detections.js';
import { demoHandler, publicOnly, NEEDS_KEYS } from '../src/demo/routes.js';
import { DemoStore } from '../src/demo/store.js';
import { TelegramLinks } from '../src/telegram/links.js';
import type { GuidePlan, GuidePlanner } from '../src/guide/plan.js';

const CLIP = 'entrance';
const SCENARIO = 'scenario-1';
const FROM = Date.UTC(2026, 10, 2, 8, 0, 0);
const TO = FROM + 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SIGNED = 'https://bucket.test/frame.jpg?X-Amz-Signature=secret';
const SETUP = {
  zones: [{ name: 'door', item: 'door', seenAt: ['clip'], outlines: { clip: [{ word: 'door', objectId: '1', box: { left: 960, top: 100, right: 1280, bottom: 500 }, path: 'M960 100 Z' }] } }],
  notOutlined: [],
  rules: [{ sentence: 'Tell me when the door opens.', zones: ['door'] }],
};

function fakeBackend() {
  const typed: string[] = [];
  const asked: Array<{ scenario: string; rules: unknown[] }> = [];
  let draftStatus = 'asking';
  let readThrough = 2;
  const backend: DemoEngineBackend = {
    demoScenario: async (id) => ({
      id,
      name: 'Building entrance',
      description: 'People at a door',
      position: 0,
      setId: 'set-1',
      status: 'ready',
      fromAt: iso(FROM),
      toAt: iso(TO),
      rules: [{ id: 'rule-1', name: 'Door', severity: 'medium' }],
      alerts: [],
      playback: { kind: 'video', url: 'https://bucket.test/video.mp4?X-Amz-Signature=secret' },
    }),
    // One alert at 42 s for a rule armed before it, and none for a rule armed after: what the backend's clock would say.
    demoSchedule: async (scenario, rules) => {
      asked.push({ scenario, rules });
      return {
        alerts: rules.flatMap((rule) => {
          if ('ruleId' in rule && Date.parse(rule.armedAt) - FROM > 45_000) return [];
          return [
            ...('soFar' in rule
              ? [
                  {
                    key: 'key-so-far',
                    draftRuleId: rule.draftRuleId,
                    triggeredAt: iso(FROM + 10_000),
                    shownAt: iso(FROM + 10_000),
                    delayMs: 0,
                    message: 'Only while reading.',
                    severity: 'medium',
                    evidenceFrame: { url: SIGNED, caption: 'a door' },
                  },
                ]
              : []),
            {
              key: 'key-1',
              ...('ruleId' in rule ? { ruleId: rule.ruleId } : { draftRuleId: rule.draftRuleId }),
              triggeredAt: iso(FROM + 42_000),
              shownAt: iso(FROM + 60_000),
              delayMs: 18_000,
              message: 'A door opened.',
              severity: 'medium',
              evidenceFrame: { url: SIGNED, caption: 'a door' },
            },
          ];
        }),
      };
    },
    typeDemoRule: async (_id, text) => (typed.push(text), `draft-${typed.length}`),
    demoRule: async (_id, draft) => ({
      id: draft,
      text: 't',
      status: draftStatus,
      progress: { done: 2, total: 4, readThrough },
      rule: { name: 'Door', readsAs: 'Tell me if a door opens.' },
      refusal: draftStatus === 'refused' ? { rewrites: ['Tell me when someone opens a door.'], reason: 'Two things in order.' } : null,
    }),
  };
  return { backend, typed, asked, setDraft: (status: string) => (draftStatus = status), setReadThrough: (tars: number) => (readThrough = tars) };
}

const voiceKeywordsAsked: string[][] = [];
let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

const planner = (over: Partial<GuidePlan> = {}): GuidePlanner => ({
  draft: async ({ sentence }) => ({ sentence, about: 'door', zones: ['door'], box: null, hours: null, ...over }),
});

const FOUND_NOW = {
  zones: [{ name: 'gate', item: 'gate', seenAt: ['clip'], outlines: { clip: [{ word: 'gate', objectId: '1', box: { left: 10, top: 10, right: 200, bottom: 300 }, path: 'M10 10 Z' }] } }],
  notOutlined: [],
  rules: [{ sentence: 'Tell me when the gate is left open.', zones: ['gate'] }],
};

async function start({ asker, detection = null, telegram = false, ceilingMicroUsd = 5_000_000, setUp = async () => SETUP, setUpNow = async () => FOUND_NOW as never, guide = planner(), setup = SETUP, abilities, heard = 'Tell me when someone opens the door.', writesCaptions = true, captionsFail = false }: { asker?: ToolAsker; detection?: Pick<ClipDetection, 'state' | 'found' | 'ensure'> | null; telegram?: boolean; writesCaptions?: boolean; captionsFail?: boolean;  ceilingMicroUsd?: number; setUp?: (bytes: Uint8Array) => Promise<unknown>; setUpNow?: (camera: { id: string }, pictures: Array<{ label: string }>) => Promise<never>; guide?: GuidePlanner; setup?: unknown; abilities?: { models: boolean; rules: boolean }; heard?: string } = {}) {
  const fake = fakeBackend();
  const root = await mkdtemp(join(tmpdir(), 'demo-'));
  await mkdir(join(root, 'cameras', CLIP), { recursive: true });
  await writeFile(join(root, 'cameras', CLIP, 'still.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
  await writeFile(join(root, 'cameras', CLIP, 'camera.json'), JSON.stringify({ name: 'Building entrance', site: 'a building', baseWords: [], pictures: { clip: 'still.jpg' } }));
  await writeFile(join(root, 'cameras', CLIP, 'setup.json'), JSON.stringify(setup));
  const store = new DemoStore(join(root, 'demo.db'));
  const written: Array<{ rule: string; language: string }> = [];
  let failing = captionsFail;
  let picturesFetched = 0;
  const engine = new DemoEngine({
    store,
    backend: fake.backend,
    folder: root,
    ...(writesCaptions
      ? {
          writeCaption: async (rule: string, language: string) => {
            if (failing) throw new Error('The model is away');
            written.push({ rule, language });
            return `${language}: ${rule}`;
          },
        }
      : {}),
    fetch: (async () => ((picturesFetched += 1), new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 }))) as unknown as typeof fetch,
  });
  await engine.copyClip({ id: CLIP, scenario: SCENARIO });
  const links = new TelegramLinks(':memory:');
  const delivered: Array<{ to: number; text: string }> = [];
  let telegramReachable = true;
  const unlessTelegramIsUnreachable = () => {
    if (!telegramReachable) throw new TypeError('fetch failed');
  };
  const clip = { id: CLIP, name: 'Building entrance', width: 1280, height: 720, fps: 10, frames: 600, video: join(root, 'clip.mp4') };
  const handle = demoHandler({
    engine,
    store,
    limits: new DemoLimits({ file: join(root, 'limits.json'), ceilingMicroUsd, now: () => Date.UTC(2026, 10, 3, 12) }),
    clips: { get: async (id) => (id === CLIP ? clip : null) },
    cameras: new CameraFolder(root),
    guidePlanner: guide,
    asker: asker ?? { withTools: async (_instruction, _tools, run) => (await run('count_in_view', { kind: 'person' }), 'About 1 person.') },
    setUp,
    setUpNow,
    detection,
    voiceNotes: { read: async (request, keywords, beforeAsking) => { for await (const _ of request) void _; await beforeAsking?.(); voiceKeywordsAsked.push(keywords); return { status: 200, body: { text: heard } }; } },
    folder: root,
    trackSeconds: 30,
    ...(abilities ? { abilities } : {}),
    ...(telegram
      ? {
          telegram: {
            links,
            botName: 'streamatic_demo_bot',
            chat: {
              sendText: async (to: number, text: string) => {
                unlessTelegramIsUnreachable();
                delivered.push({ to, text });
              },
              sendPicture: async (to: number, _picture: Uint8Array, text: string) => {
                unlessTelegramIsUnreachable();
                delivered.push({ to, text });
              },
            },
          },
        }
      : {}),
  });
  server = createServer((req, res) => {
    void handle(req, res, new URL(req.url ?? '/', 'http://x')).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const visitor = (cookie: string) => async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `streamatic_demo=${cookie}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null };
  };
  return { base, visitor, engine, store, root, links, delivered, written, pictures: () => picturesFetched, failCaptions: (to: boolean) => (failing = to), cutOffTelegram: () => (telegramReachable = false), ...fake };
}

describe('the demo engine', () => {
  it('copies each rule’s alert points once, and playing a clip asks the backend nothing', async () => {
    const { visitor, asked, engine } = await start();
    const copied = asked.length;
    expect(copied).toBe(4); // One rule over the four 15-second pieces of a 60-second clip.
    await engine.copyClip({ id: CLIP, scenario: SCENARIO });
    expect(asked.length).toBe(copied);
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs: 0 }] });
    expect(body.alerts).toMatchObject([{ key: 'key-1', rule: 'rule-1', atMs: 42_000, shownMs: 45_000, delayMs: 3_000, message: 'A door opened.' }]);
    expect(asked.length).toBe(copied);
  });

  it('answers a tick from the piece of the clip it falls in, as a rule saved at that moment would run', async () => {
    const { visitor } = await start();
    const ask = visitor('v1');
    const at = async (armedMs: number) => (await ask(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs }] })).body.alerts;
    expect(await at(16_000)).toHaveLength(1);
    expect(await at(46_000)).toEqual([]);
  });

  it('shows an alert 3 seconds after its moment, and inside the clip when that would fall past its end', () => {
    expect(alertShownMs(42_000, 300_000)).toBe(45_000);
    expect(alertShownMs(298_000, 300_000)).toBe(299_000);
    expect(alertShownMs(299_500, 300_000)).toBe(299_500);
  });

  it('gives the setup page each zone, the rules suggested and the picture setup ran on', async () => {
    const { visitor, base, root } = await start({ setup: { ...SETUP, notOutlined: [{ item: 'handrail', triedWords: ['handrail', 'railing'] }] } });
    await writeFile(join(root, 'cameras', CLIP, 'still.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/setup`);
    expect(body).toEqual({
      hasClip: true,
      picture: `/demo-still/${CLIP}`,
      pictures: [{ label: 'clip', src: `/demo-still/${CLIP}/clip` }],
      zones: [{ name: 'door', item: 'door', seenAt: ['clip'], paths: ['M960 100 Z'], pathsBy: { clip: ['M960 100 Z'] } }],
      rules: ['Tell me when the door opens.'],
      edited: false,
      live: false,
    });
    const still = await fetch(`${base}/demo-still/${CLIP}`);
    expect(still.status).toBe(200);
    expect(still.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await still.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it('serves a clip’s setup picture and nothing else from the camera folder', async () => {
    const { base, root } = await start();
    await writeFile(join(root, 'cameras', CLIP, 'still.jpg'), new Uint8Array([0xff]));
    expect((await fetch(`${base}/demo-still/${encodeURIComponent('../../demo.db')}`)).status).toBe(404);
    expect((await fetch(`${base}/demo-still/no-such-clip`)).status).toBe(404);
  });

  it('never shows an alert before its rule was ticked', () => {
    const alert = { key: 'k', rule: 'r', atMs: 42_000, shownMs: 60_000, delayMs: 18_000, message: 'm', severity: 'medium', picture: null, caption: null, captions: {} };
    expect(showing([alert], 44_000)[0]!.shownMs).toBe(60_000);
    expect(showing([alert], 70_000)[0]!.shownMs).toBe(70_000);
  });

  it('never gives a browser a signed address, and serves the evidence from its own folder', async () => {
    const { visitor, base } = await start();
    const ask = visitor('v1');
    const opened = await ask(`/api/demo/clips/${CLIP}`);
    const alerts = await ask(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs: 0 }] });
    expect(opened.text + alerts.text).not.toContain('X-Amz');
    const picture = await fetch(`${base}${alerts.body.alerts[0].picture}`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/jpeg');
  });

  it('opens a clip with its zones and offered rules', async () => {
    const { visitor } = await start();
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}`);
    expect(body).toMatchObject({ id: CLIP, description: 'People at a door', zones: [{ name: 'door', paths: ['M960 100 Z'] }], rules: [{ id: 'rule-1', kind: 'offered', name: 'Door' }], suggestions: ['Tell me when the door opens.'] });
  });

  it('refuses a clip it does not hold', async () => {
    const { visitor } = await start();
    expect((await visitor('v1')('/api/demo/clips/other')).status).toBe(404);
  });
});

describe('routing a sentence to a camera', () => {
  const addCamera = async (root: string, id: string, group: string | null, word: string, extra: Record<string, string> = {}) => {
    await mkdir(join(root, 'cameras', id), { recursive: true });
    await writeFile(join(root, 'cameras', id, 'camera.json'), JSON.stringify({ name: `${id} camera`, site: 's', baseWords: [], pictures: { day: 'day.jpg', night: 'night.jpg', ...extra }, ...(group ? { group } : {}) }));
    await writeFile(join(root, 'cameras', id, 'setup.json'), JSON.stringify({ zones: [{ name: word, item: word, seenAt: ['day'], outlines: { day: [{ word, objectId: '1', box: { left: 1, top: 1, right: 9, bottom: 9 }, path: 'M1 1Z' }] } }], notOutlined: [], rules: [{ sentence: `Tell me about the ${word}.`, zones: [word] }] }));
  };

  it('names the cameras that outlined what was asked about, says which hold a clip, and spends nothing', async () => {
    const { visitor, root } = await start({ abilities: { models: false, rules: false } });
    await addCamera(root, 'road', null, 'shop');
    await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    await visitor('v1')('/api/demo/clips/road/setup', {});
    const { status, body } = await visitor('v1')('/api/demo/route', { sentence: 'Tell me when someone is at the shop.' });
    expect(status).toBe(200);
    expect(body.cameras).toEqual([{ camera: 'road', name: 'road camera', zones: ['shop'], matched: 1, hasClip: false, picture: '/demo-still/road', paths: ['M1 1Z'] }]);
    const door = await visitor('v1')('/api/demo/route', { sentence: 'Tell me when the door opens.' });
    expect(door.body.cameras).toMatchObject([{ camera: CLIP, hasClip: true, zones: ['door'] }]);
    expect((await visitor('v1')('/api/demo/route', { sentence: 'Tell me when it rains.' })).body.cameras).toEqual([]);
  });

  it('chooses only among the cameras this visitor has set up', async () => {
    const { visitor, root } = await start({ abilities: { models: false, rules: false } });
    await addCamera(root, 'road', null, 'shop');
    await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    expect((await visitor('v1')('/api/demo/route', { sentence: 'Tell me when someone is at the shop.' })).body.cameras).toEqual([]);
    expect((await visitor('v1')('/api/demo/route', { sentence: 'Tell me when the door opens.' })).body.cameras).toMatchObject([{ camera: CLIP }]);
    expect((await visitor('v2')('/api/demo/route', { sentence: 'Tell me when the door opens.' })).body.cameras).toEqual([]);
  });

  it('offers another camera at the same place from a clip, and only when it outlined more', async () => {
    const { visitor, root } = await start({ setup: SETUP, abilities: { models: false, rules: false } });
    await writeFile(join(root, 'cameras', CLIP, 'camera.json'), JSON.stringify({ name: 'Building entrance', site: 'a building', baseWords: [], pictures: { clip: 'still.jpg' }, group: 'site' }));
    await addCamera(root, 'road', 'site', 'shop');
    await addCamera(root, 'far', 'other', 'shop');
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/route`, { sentence: 'Someone is at the shop.' })).body.elsewhere).toEqual([]);
    await visitor('v1')('/api/demo/clips/road/setup', {});
    await visitor('v1')('/api/demo/clips/far/setup', {});
    const offered = await visitor('v1')(`/api/demo/clips/${CLIP}/route`, { sentence: 'Someone is at the shop.' });
    expect(offered.body.elsewhere).toMatchObject([{ camera: 'road', zones: ['shop'], hasClip: false, picture: '/demo-still/road' }]);
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/route`, { sentence: 'The door opens.' })).body.elsewhere).toEqual([]);
  });

  it('lists every camera for setup, whether or not it holds a clip, and sets one up from its own pictures', async () => {
    const { visitor, root, base } = await start();
    await addCamera(root, 'road', null, 'shop');
    await writeFile(join(root, 'cameras', 'road', 'night.jpg'), new Uint8Array([0xff, 0xd8, 0xfe]));
    const { body } = await visitor('v1')('/api/demo/cameras');
    expect(body).toEqual([
      { id: CLIP, name: 'Building entrance', hasClip: true, picture: `/demo-still/${CLIP}`, setUp: false },
      { id: 'road', name: 'road camera', hasClip: false, picture: '/demo-still/road', setUp: false },
    ]);
    const setup = (await visitor('v1')('/api/demo/clips/road/setup')).body;
    expect(setup).toMatchObject({
      hasClip: false,
      picture: '/demo-still/road',
      pictures: [{ label: 'day', src: '/demo-still/road/day' }, { label: 'night', src: '/demo-still/road/night' }],
      zones: [{ name: 'shop', seenAt: ['day'], pathsBy: { day: ['M1 1Z'] } }],
    });
    const night = await fetch(`${base}/demo-still/road/night`);
    expect(new Uint8Array(await night.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xfe]));
    expect((await fetch(`${base}/demo-still/road/camera`)).status).toBe(404);
  });

  it('reads a voice note from the page with no camera chosen, listening for every camera’s zones', async () => {
    const { base, root } = await start();
    await addCamera(root, 'road', null, 'shop');
    voiceKeywordsAsked.length = 0;
    const reply = await fetch(`${base}/api/demo/voice-notes`, { method: 'POST', headers: { cookie: 'streamatic_demo=v1' }, body: new Uint8Array([1]) });
    expect(((await reply.json()) as { text: string }).text).toBe('Tell me when someone opens the door.');
    expect(voiceKeywordsAsked[0]).toEqual(expect.arrayContaining(['door', 'shop']));
  });
});

describe('the events page', () => {
  it('lists nothing from a camera this visitor has not set up', async () => {
    const { visitor } = await start();
    await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    expect((await visitor('v1')('/api/demo/events')).body.events).toHaveLength(1);
    expect((await visitor('v2')('/api/demo/events')).body.events).toEqual([]);
  });

  it('lists every alert the clips’ rules raised from the start of each clip, with its clip, rule, moment and picture', async () => {
    const { visitor } = await start();
    await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    const { body } = await visitor('v1')('/api/demo/events');
    expect(body.events).toMatchObject([{ clip: CLIP, camera: 'Building entrance', rule: 'rule-1', yours: false, key: 'key-1', atMs: 42_000, picture: `/demo-evidence/${CLIP}/key-1.jpg` }]);
    expect(typeof body.events[0].ruleName).toBe('string');
  });

  it('adds a visitor’s own rule once it is ready, and never shows it to anyone else', async () => {
    const { visitor, setDraft } = await start();
    const mine = visitor('v1');
    await mine(`/api/demo/clips/${CLIP}/setup`, {});
    const { body: created } = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens.' });
    expect((await mine('/api/demo/events')).body.events.filter((e: any) => e.yours)).toEqual([]);
    setDraft('ready');
    await mine(`/api/demo/clips/${CLIP}/rules/${created.id}`);
    const own = (await mine('/api/demo/events')).body.events.filter((e: any) => e.yours);
    expect(own).toMatchObject([{ rule: created.id, ruleName: expect.any(String), atMs: 42_000 }]);
    expect((await visitor('v2')('/api/demo/events')).body.events.map((e: any) => e.rule)).not.toContain(created.id);
  });
});

describe('sentences offered to a visitor', () => {
  it('offers the camera’s tested sentences on the clip, in setup and on the home page, in place of setup’s own', async () => {
    const { visitor, root } = await start();
    const file = join(root, 'cameras', CLIP, 'camera.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), tested: ['Tell me when someone opens the door.'] }));
    const ask = visitor('v1');
    expect((await ask(`/api/demo/clips/${CLIP}`)).body.suggestions).toEqual(['Tell me when someone opens the door.']);
    expect((await ask(`/api/demo/clips/${CLIP}/setup`)).body.rules).toEqual(['Tell me when someone opens the door.']);
    expect((await ask('/api/demo/clips')).body[0].suggestions).toEqual(['Tell me when someone opens the door.']);
  });

  it('keeps setup’s own suggestions for a camera with no tested sentences', async () => {
    const { visitor } = await start();
    const ask = visitor('v1');
    expect((await ask(`/api/demo/clips/${CLIP}`)).body.suggestions).toEqual(['Tell me when the door opens.']);
    expect((await ask(`/api/demo/clips/${CLIP}/setup`)).body.rules).toEqual(['Tell me when the door opens.']);
    expect((await ask('/api/demo/clips')).body[0].suggestions).toEqual([]);
  });

  it('says whether this visitor has set up each clip', async () => {
    const { visitor } = await start();
    await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    expect((await visitor('v1')('/api/demo/clips')).body[0].setUp).toBe(true);
    expect((await visitor('v2')('/api/demo/clips')).body[0].setUp).toBe(false);
  });

  it('offers the camera’s tested questions only where a detector can answer them', async () => {
    const asked = { questions: ['How many people were in view at once?'] };
    const withDetector = await start({ detection: { state: () => 'running', found: () => null, ensure: () => undefined } });
    const file = join(withDetector.root, 'cameras', CLIP, 'camera.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...asked }));
    expect((await withDetector.visitor('v1')(`/api/demo/clips/${CLIP}`)).body.suggestedQuestions).toEqual(asked.questions);

    const without = await start();
    const itsFile = join(without.root, 'cameras', CLIP, 'camera.json');
    await writeFile(itsFile, JSON.stringify({ ...JSON.parse(await readFile(itsFile, 'utf8')), ...asked }));
    expect((await without.visitor('v1')(`/api/demo/clips/${CLIP}`)).body.suggestedQuestions).toEqual([]);
  });
});

describe('a typed rule', () => {
  it('reports the backend’s progress, then copies its alerts once and shows them only to its typist', async () => {
    const { visitor, typed, setDraft, asked } = await start();
    const mine = visitor('v1');
    const created = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens.' });
    expect(created.status).toBe(202);
    expect(typed).toEqual(['Tell me when a door opens.']);
    const rule = `/api/demo/clips/${CLIP}/rules/${created.body.id}`;
    expect((await mine(rule)).body).toMatchObject({ status: 'asking', progress: { done: 2, total: 4 } });

    setDraft('ready');
    const before = asked.length;
    expect((await mine(rule)).body).toMatchObject({ status: 'ready', readsAs: 'Tell me if a door opens.' });
    expect(asked.length).toBe(before + 1);
    await mine(rule);
    expect(asked.length).toBe(before + 1);

    const alerts = await mine(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: created.body.id, armedMs: 50_000 }] });
    expect(alerts.body.alerts).toMatchObject([{ rule: created.body.id, atMs: 42_000 }]);
    expect((await mine(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).toContain(created.body.id);

    const theirs = visitor('v2');
    expect((await theirs(rule)).status).toBe(404);
    expect((await theirs(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: created.body.id, armedMs: 0 }] })).body.alerts).toEqual([]);
    expect((await theirs(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).not.toContain(created.body.id);
  });

  it('shows its alerts as the clip is read, replaces them with the final ones, and fetches each picture once', async () => {
    const { visitor, setDraft, setReadThrough, asked, pictures } = await start();
    const mine = visitor('v1');
    setReadThrough(0);
    const created = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens.' });
    const rule = `/api/demo/clips/${CLIP}/rules/${created.body.id}`;
    const shown = async () => (await mine(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: created.body.id, armedMs: 0 }] })).body.alerts.map((a: any) => a.atMs);
    const asks = () => asked.flatMap((a) => a.rules).filter((r: any) => r.draftRuleId === created.body.id);

    expect((await mine(rule)).body).toMatchObject({ status: 'asking', progress: { done: 0, total: 4 } });
    expect(asks()).toEqual([]);
    expect(await shown()).toEqual([]);

    const fetchedBefore = pictures();
    setReadThrough(2);
    expect((await mine(rule)).body).toMatchObject({ status: 'asking', progress: { done: 2, total: 4 } });
    expect(asks()).toEqual([{ draftRuleId: created.body.id, soFar: true }]);
    expect(await shown()).toEqual([10_000, 42_000]);
    const fetched = pictures();
    expect(fetched).toBe(fetchedBefore + 2);

    // Nothing more has been read, so there is nothing to ask again.
    await mine(rule);
    expect(asks()).toHaveLength(1);

    setReadThrough(3);
    await mine(rule);
    expect(asks()).toHaveLength(2);
    expect(pictures()).toBe(fetched);

    setReadThrough(4);
    setDraft('ready');
    expect((await mine(rule)).body).toMatchObject({ status: 'ready', progress: { done: 4, total: 4 } });
    expect(asks().at(-1)).toEqual({ draftRuleId: created.body.id });
    expect(await shown()).toEqual([42_000]);
  });

  it('keeps reading when the alerts so far could not be fetched', async () => {
    const { visitor, setReadThrough, backend } = await start();
    const mine = visitor('v1');
    setReadThrough(0);
    const created = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens.' });
    const rule = `/api/demo/clips/${CLIP}/rules/${created.body.id}`;
    const schedule = backend.demoSchedule;
    backend.demoSchedule = async () => {
      throw new Error('The backend could not be reached');
    };
    setReadThrough(1);
    expect(await mine(rule)).toMatchObject({ status: 200, body: { status: 'asking', progress: { done: 1, total: 4 } } });
    backend.demoSchedule = schedule;
  });

  it('removes a rule for the visitor who added it, with its alerts, and for nobody else', async () => {
    const { base, visitor, setDraft } = await start();
    const mine = visitor('v1');
    const created = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens.' });
    const rule = `/api/demo/clips/${CLIP}/rules/${created.body.id}`;
    setDraft('ready');
    await mine(rule);
    const remove = (who: string, path: string) => fetch(`${base}${path}`, { method: 'DELETE', headers: { cookie: `streamatic_demo=${who}` } });

    expect((await remove('v2', rule)).status).toBe(404);
    expect((await mine(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).toContain(created.body.id);

    expect((await remove('v1', rule)).status).toBe(200);
    expect((await mine(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).not.toContain(created.body.id);
    expect((await mine(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: created.body.id, armedMs: 0 }] })).body.alerts).toEqual([]);
    expect((await remove('v1', rule)).status).toBe(404);
  });

  it('will not remove a rule every visitor is offered', async () => {
    const { base, visitor } = await start();
    const offered = (await visitor('v1')(`/api/demo/clips/${CLIP}`)).body.rules.find((r: any) => r.kind === 'offered');
    const removed = await fetch(`${base}/api/demo/clips/${CLIP}/rules/${offered.id}`, { method: 'DELETE', headers: { cookie: 'streamatic_demo=v1' } });
    expect(removed.status).toBe(404);
    expect((await visitor('v2')(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).toContain(offered.id);
  });

  it('passes on a refusal with its rewrites', async () => {
    const { visitor, setDraft } = await start();
    const mine = visitor('v1');
    const created = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'A door opens and then a car leaves.' });
    setDraft('refused');
    expect((await mine(`/api/demo/clips/${CLIP}/rules/${created.body.id}`)).body).toMatchObject({ status: 'refused', rewrites: ['Tell me when someone opens a door.'], reason: 'Two things in order.' });
  });

  it('stops a visitor at their daily number of typed rules, while others can still type', async () => {
    const { visitor, typed } = await start();
    const mine = visitor('v1');
    for (let i = 0; i < 10; i++) expect((await mine(`/api/demo/clips/${CLIP}/rules`, { text: `Rule ${i}` })).status).toBe(202);
    const refused = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Rule 11' });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatch(/limit/i);
    expect(typed).toHaveLength(10);
    expect((await visitor('v2')(`/api/demo/clips/${CLIP}/rules`, { text: 'Rule' })).status).toBe(202);
  });

  it('stops every visitor at the daily ceiling on spending, and the recorded clips still work', async () => {
    const { visitor, typed } = await start({ ceilingMicroUsd: 1 });
    const refused = await visitor('v1')(`/api/demo/clips/${CLIP}/rules`, { text: 'Rule' });
    expect(refused.status).toBe(429);
    expect(typed).toEqual([]);
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs: 0 }] })).body.alerts).toHaveLength(1);
  });
});

describe('the guide on a clip', () => {
  it('plans on the zones setup outlined on the clip', async () => {
    const { visitor } = await start();
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when the door opens.' });
    expect(body).toMatchObject({ status: 'ready', plan: { zones: ['door'] } });
  });

  it('places a box over the zone its sentence names, since nobody can draw on a clip', async () => {
    const box = { name: 'doorway', question: 'Is someone stopped at the door?', over: null };
    const { visitor } = await start({ guide: planner({ about: 'someone', zones: [], box }) });
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when someone stops at the door.' });
    expect(body.plan.box.over).toBe('door');
  });

  it('leaves a box unplaced when the sentence could mean more than one zone', async () => {
    const box = { name: 'doorway', question: 'Is someone stopped at the door?', over: null };
    const twoDoors = { ...SETUP, zones: [SETUP.zones[0]!, { ...SETUP.zones[0]!, outlines: { clip: [{ ...SETUP.zones[0]!.outlines.clip[0]!, objectId: '2', box: { left: 0, top: 100, right: 200, bottom: 500 }, path: 'M0 100 Z' }] } }] };
    const { visitor } = await start({ guide: planner({ about: 'someone', zones: [], box }), setup: twoDoors });
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when someone stops at the door.' });
    expect(body.plan.box.over).toBeNull();
  });

  it('leaves a box where it is when no zone is named', async () => {
    const box = { name: 'yard', question: 'Is someone in the yard?', over: null };
    const { visitor } = await start({ guide: planner({ about: 'someone', zones: [], box }) });
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when someone is in the yard.' });
    expect(body.plan.box.over).toBeNull();
  });

  it('hands back a plan that names a zone the clip does not have, until the tries run out', async () => {
    const { visitor } = await start({ guide: planner({ zones: ['gate'], about: 'gate' }) });
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when the gate opens.' });
    expect(body.status).toBe('needs-person');
    expect(body.attempts).toHaveLength(3);
  });

  it('adds a planned rule with each zone’s place in the sentence, and keeps its outlines for the player', async () => {
    const { visitor, typed } = await start();
    const mine = visitor('v1');
    const plan = { sentence: 'Tell me when the door opens.', about: 'door', zones: ['door'], box: null, hours: null };
    const created = await mine(`/api/demo/clips/${CLIP}/rules`, { plan });
    expect(created.status).toBe(202);
    expect(typed).toEqual(['Tell me when the door opens. The door is on the right side of the picture.']);
    const rule = (await mine(`/api/demo/clips/${CLIP}`)).body.rules.find((r: any) => r.id === created.body.id);
    expect(rule).toMatchObject({ text: 'Tell me when the door opens.', zones: [{ name: 'door', paths: ['M960 100 Z'] }] });
  });

  it('refuses a planned rule that does not pass the plan’s checks, whatever the browser sends', async () => {
    const { visitor, typed } = await start();
    const plan = { sentence: 'Tell me when the gate opens.', about: 'gate', zones: ['gate'], box: null, hours: null };
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/rules`, { plan })).status).toBe(400);
    expect(typed).toEqual([]);
  });
});

describe('alert captions in other languages', () => {
  const tick = { ticks: [{ rule: 'rule-1', armedMs: 0 }] };

  it('writes each rule once per language, however many alerts it raises, and keeps it', async () => {
    const { written, engine } = await start();
    expect(written.map((w) => w.language).sort()).toEqual(['pidgin', 'yoruba']);
    expect(written[0]!.rule).toBe('Door');
    await engine.copyClip({ id: CLIP, scenario: SCENARIO });
    expect(written).toHaveLength(2);
  });

  it('carries the kept captions with the alert, and playing asks the model nothing', async () => {
    const { visitor, written } = await start();
    const before = written.length;
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, tick);
    expect(body.alerts[0].captions).toEqual({ pidgin: 'pidgin: Door', yoruba: 'yoruba: Door' });
    expect(written.length).toBe(before);
  });

  it('writes a copy with no captions when there is no model to write them, and the alert still shows', async () => {
    const { visitor } = await start({ writesCaptions: false });
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, tick);
    expect(body.alerts[0].captions).toEqual({});
    expect(body.alerts[0].message).toBe('A door opened.');
  });

  it('keeps the alert when a caption cannot be written, and tries again on the next copy', async () => {
    const { visitor, engine, failCaptions, written } = await start({ captionsFail: true });
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, tick)).body.alerts).toHaveLength(1);
    failCaptions(false);
    await engine.copyClip({ id: CLIP, scenario: SCENARIO });
    expect(written).toHaveLength(2);
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, tick)).body.alerts[0].captions).toEqual({ pidgin: 'pidgin: Door', yoruba: 'yoruba: Door' });
  });

  it('writes a typed rule’s captions before it says it is ready', async () => {
    const { visitor, setDraft, written } = await start();
    const ask = visitor('v1');
    const before = written.length;
    const { body } = await ask(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens' });
    setDraft('ready');
    await ask(`/api/demo/clips/${CLIP}/rules/${body.id}`);
    expect(written.length).toBeGreaterThan(before);
    expect(written.at(-1)!.rule).toBe('Door');
  });
});

describe('a voice note on a clip', () => {
  const voice = (base: string, cookie = 'v1') => fetch(`${base}/api/demo/clips/${CLIP}/voice-notes`, { method: 'POST', headers: { 'content-type': 'audio/webm', cookie: `streamatic_demo=${cookie}` }, body: new Uint8Array([1, 2, 3]) });

  it('answers with what was said, listening for the zones setup outlined on the clip', async () => {
    const { base } = await start();
    voiceKeywordsAsked.length = 0;
    const res = await voice(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Tell me when someone opens the door.' });
    expect(voiceKeywordsAsked[0]).toContain('door');
  });

  it('counts as a plan against the visitor’s limit', async () => {
    const { base, visitor } = await start();
    const post = visitor('v1');
    for (let i = 0; i < 10; i++) expect((await voice(base)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when a door opens' })).status).toBe(200);
    const res = await voice(base);
    expect(res.status).toBe(429);
  });

  it('is refused on a clip that does not exist', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/demo/clips/nowhere/voice-notes`, { method: 'POST', body: new Uint8Array([1]) });
    expect(res.status).toBe(404);
  });
});

describe('starting again', () => {
  it('returns every camera to not set up and removes this visitor’s zone changes, rules and tracks, and nobody else’s', async () => {
    const { visitor, base, store } = await start();
    const mine = visitor('v1');
    for (const who of [mine, visitor('v2')]) await who(`/api/demo/clips/${CLIP}/setup`, {});
    await fetch(`${base}/api/demo/clips/${CLIP}/zones/gate`, { method: 'PUT', headers: { cookie: 'streamatic_demo=v1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'front gate' }) });
    const { body: created } = await mine(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door opens.' });
    const { body: theirs } = await visitor('v2')(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when a door shuts.' });
    store.addTrack('v1', CLIP, 'track-1');
    store.addTrack('v2', CLIP, 'track-2');

    expect((await mine('/api/demo/reset', {})).status).toBe(200);

    expect((await mine(`/api/demo/clips/${CLIP}`)).body).toMatchObject({ setUpLive: false });
    expect((await mine(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).not.toContain(created.id);
    expect((await mine(`/api/demo/clips/${CLIP}/setup`)).body.edited).toBe(false);
    expect(store.tracks('v1', CLIP)).toEqual([]);
    expect((await visitor('v2')(`/api/demo/clips/${CLIP}`)).body.setUpLive).toBe(true);
    expect((await visitor('v2')(`/api/demo/clips/${CLIP}`)).body.rules.map((r: any) => r.id)).toContain(theirs.id);
    expect(store.tracks('v2', CLIP)).toEqual(['track-2']);
  });
});

describe('a copy of the page with no keys and no login', () => {
  it('sets a camera up from the setup saved with this copy, spending nothing', async () => {
    let asked = 0;
    const { visitor } = await start({ abilities: { models: false, rules: false }, setUpNow: async () => ((asked += 1), FOUND_NOW as never) });
    const { status, body } = await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ live: true, zones: [{ name: 'door' }] });
    expect(asked).toBe(0);
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}`)).body.setUpLive).toBe(true);
  });

  it('refuses a voice note as it refuses a plan', async () => {
    const { base } = await start({ abilities: { models: false, rules: false } });
    const res = await fetch(`${base}/api/demo/clips/${CLIP}/voice-notes`, { method: 'POST', body: new Uint8Array([1]) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NEEDS_KEYS);
  });

  it('plays its clips and alerts, and says plainly what it cannot do, spending nothing', async () => {
    const { visitor, typed, base } = await start({ abilities: { models: false, rules: false } });
    const ask = visitor('v1');
    expect((await ask('/api/app')).body).toMatchObject({ public: true, models: false, rules: false });
    expect((await ask(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs: 0 }] })).body.alerts).toHaveLength(1);

    const plan = await ask(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when the door opens.' });
    expect(plan.status).toBe(409);
    expect(plan.body.error).toMatch(/README/);
    const upload = await fetch(`${base}/api/demo/uploads`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).jpeg().toBuffer()) });
    expect(upload.status).toBe(409);
    const rule = await ask(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when the door opens.' });
    expect(rule.status).toBe(409);
    expect(rule.body.error).toMatch(/hosted page/);
    expect(typed).toEqual([]);
  });

  it('plans with keys alone, and still cannot read a new rule without the backend', async () => {
    const { visitor } = await start({ abilities: { models: true, rules: false } });
    const ask = visitor('v1');
    expect((await ask(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when the door opens.' })).body.status).toBe('ready');
    expect((await ask(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when the door opens.' })).status).toBe(409);
  });
});

describe('setting up a camera live', () => {
  const zonesOf = (body: { zones: Array<{ name: string }> }) => body.zones.map((z) => z.name);
  const setUp = (ask: ReturnType<Awaited<ReturnType<typeof start>>['visitor']>) => ask(`/api/demo/clips/${CLIP}/setup`, {});

  it('runs on the camera’s own pictures when asked, and returns what it found just now', async () => {
    const seen: Array<{ id: string; labels: string[] }> = [];
    const { visitor } = await start({
      setUpNow: async (camera, pictures) => {
        seen.push({ id: camera.id, labels: pictures.map((p) => p.label) });
        return FOUND_NOW as never;
      },
    });
    const res = await setUp(visitor('v1'));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ id: CLIP, labels: ['clip'] }]);
    expect(zonesOf(res.body)).toEqual(['gate']);
    expect(res.body.live).toBe(true);
  });

  it('applies to the visitor who ran it, on the clip as on the setup page, and to nobody else', async () => {
    const { visitor } = await start();
    const ask = visitor('v1');
    expect((await ask(`/api/demo/clips/${CLIP}`)).body).toMatchObject({ setUpLive: false });
    await setUp(ask);
    const clip = (await ask(`/api/demo/clips/${CLIP}`)).body;
    expect(clip.setUpLive).toBe(true);
    expect(zonesOf(clip)).toEqual(['gate']);
    expect(zonesOf((await ask(`/api/demo/clips/${CLIP}/setup`)).body)).toEqual(['gate']);
    const other = (await visitor('v2')(`/api/demo/clips/${CLIP}`)).body;
    expect(other.setUpLive).toBe(false);
    expect(zonesOf(other)).toEqual(['door']);
  });

  it('checks a plan against the zones found just now', async () => {
    const { visitor } = await start({ guide: planner({ about: 'gate', zones: ['gate'] }) });
    const ask = visitor('v1');
    expect((await ask(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when the gate opens.' })).body.status).not.toBe('ready');
    await setUp(ask);
    expect((await ask(`/api/demo/clips/${CLIP}/plans`, { sentence: 'Tell me when the gate opens.' })).body.status).toBe('ready');
  });

  it('lets the visitor rename a zone found just now, and running it again starts from what is found then', async () => {
    const { visitor, base } = await start();
    const ask = visitor('v1');
    await setUp(ask);
    const renamed = await fetch(`${base}/api/demo/clips/${CLIP}/zones/gate`, { method: 'PUT', headers: { cookie: 'streamatic_demo=v1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'front gate' }) });
    expect(zonesOf((await renamed.json()) as { zones: Array<{ name: string }> })).toEqual(['front gate']);
    expect(zonesOf((await setUp(ask)).body)).toEqual(['gate']);
  });

  it('runs once when pressed twice at the same moment', async () => {
    let runs = 0;
    const { visitor } = await start({
      setUpNow: async () => {
        runs += 1;
        await new Promise((done) => setTimeout(done, 20));
        return FOUND_NOW as never;
      },
    });
    const ask = visitor('v1');
    await Promise.all([setUp(ask), setUp(ask)]);
    expect(runs).toBe(1);
  });

  it('offers what survived testing first, then what it suggested just now, each once', async () => {
    const { visitor, root } = await start();
    await writeFile(join(root, 'cameras', CLIP, 'camera.json'), JSON.stringify({ name: 'Building entrance', site: 'a building', baseWords: [], pictures: { clip: 'still.jpg' }, tested: ['Tell me when someone sits down.', 'Tell me when the gate is left open.'] }));
    const ask = visitor('v1');
    expect((await setUp(ask)).body.rules).toEqual(['Tell me when someone sits down.', 'Tell me when the gate is left open.']);
  });

  it('counts against the visitor’s daily limit', async () => {
    const { visitor } = await start();
    const ask = visitor('v1');
    for (let i = 0; i < 8; i++) expect((await setUp(ask)).status).toBe(200);
    expect((await setUp(ask)).status).toBe(429);
  });

  it('forgets what was found on Reset', async () => {
    const { visitor, base } = await start();
    const ask = visitor('v1');
    await setUp(ask);
    const reset = await fetch(`${base}/api/demo/clips/${CLIP}/zones`, { method: 'DELETE', headers: { cookie: 'streamatic_demo=v1' } });
    expect(zonesOf((await reset.json()) as { zones: Array<{ name: string }> })).toEqual(['door']);
    expect((await ask(`/api/demo/clips/${CLIP}`)).body.setUpLive).toBe(false);
  });
});

describe('alerts on Telegram', () => {
  const PERSON = 555;
  const alertOf = (ask: ReturnType<Awaited<ReturnType<typeof start>>['visitor']>) => ask(`/api/demo/clips/${CLIP}/telegram-alerts`, { rule: 'rule-1', key: 'key-1' });

  it('says a copy has no bot, and refuses to link', async () => {
    const { visitor } = await start();
    const ask = visitor('v1');
    expect((await ask('/api/app')).body.telegram).toBe(false);
    const res = await ask(`/api/demo/telegram?clip=${CLIP}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(NEEDS_KEYS);
  });

  it('gives the page a link that carries who is asking, and reports it once the person has pressed Start', async () => {
    const { visitor, links } = await start({ telegram: true });
    const ask = visitor('v1');
    expect((await ask('/api/app')).body.telegram).toBe(true);
    const before = (await ask(`/api/demo/telegram?clip=${CLIP}`)).body;
    expect(before.linked).toBe(false);
    expect(before.link).toMatch(/^https:\/\/t\.me\/streamatic_demo_bot\?start=[\w-]+$/);
    links.claim(new URL(before.link).searchParams.get('start')!, PERSON);
    expect((await ask(`/api/demo/telegram?clip=${CLIP}`)).body).toEqual({ linked: true, link: null });
    expect((await visitor('v2')(`/api/demo/telegram?clip=${CLIP}`)).body.linked).toBe(false);
  });

  it('sends a ticked rule’s alert to the visitor’s own chat, in the language they chose, naming only the camera', async () => {
    const { visitor, links, delivered, base } = await start({ telegram: true });
    const ask = visitor('v1');
    links.claim(links.token('v1', CLIP), PERSON);
    const chosen = await fetch(`${base}/api/demo/telegram`, { method: 'PUT', headers: { cookie: 'streamatic_demo=v1', 'content-type': 'application/json' }, body: JSON.stringify({ clip: CLIP, language: 'pidgin' }) });
    expect(chosen.status).toBe(200);
    const res = await alertOf(ask);
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to).toBe(PERSON);
    expect(delivered[0]!.text.split('\n')[0]).toBe('🚨 <b>ALERT: BUILDING ENTRANCE</b>');
    expect(delivered[0]!.text).toContain('pidgin: ');
  });

  it('tells the page plainly when an alert could not reach Telegram at all, and what to do', async () => {
    const { visitor, links, delivered, cutOffTelegram } = await start({ telegram: true });
    const ask = visitor('v1');
    links.claim(links.token('v1', CLIP), PERSON);
    cutOffTelegram();
    const res = await alertOf(ask);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('An alert could not be sent to Telegram. Play that moment of the clip again to send it.');
    expect(delivered).toEqual([]);
  });

  it('sends nothing for a visitor who has not linked', async () => {
    const { visitor, delivered } = await start({ telegram: true });
    const res = await alertOf(visitor('v1'));
    expect(res.status).toBe(409);
    expect(delivered).toEqual([]);
  });

  it('will not send an alert of another visitor’s typed rule, or one the rule does not have', async () => {
    const { visitor, links, delivered, setDraft } = await start({ telegram: true });
    const typist = visitor('v1');
    const { body } = await typist(`/api/demo/clips/${CLIP}/rules`, { text: 'Tell me when someone opens the door.' });
    setDraft('ready');
    expect((await typist(`/api/demo/clips/${CLIP}/rules/${body.id}`)).body.status).toBe('ready');
    const other = visitor('v2');
    links.claim(links.token('v2', CLIP), PERSON);
    expect((await other(`/api/demo/clips/${CLIP}/telegram-alerts`, { rule: body.id, key: 'key-1' })).status).toBe(404);
    expect((await other(`/api/demo/clips/${CLIP}/telegram-alerts`, { rule: 'rule-1', key: 'no-such-key' })).status).toBe(404);
    expect(delivered).toEqual([]);
  });

  it('stops at a day’s number of alerts for a visitor, so a page cannot be used to flood a chat', async () => {
    const { visitor, links, delivered } = await start({ telegram: true });
    const ask = visitor('v1');
    links.claim(links.token('v1', CLIP), PERSON);
    for (let i = 0; i < 40; i++) await alertOf(ask);
    expect(delivered).toHaveLength(30);
    expect((await alertOf(ask)).status).toBe(429);
  });

  it('keeps sending once the model ceiling is reached, since an alert already kept costs no model call', async () => {
    const { visitor, links, delivered } = await start({ telegram: true, ceilingMicroUsd: 0 });
    const ask = visitor('v1');
    links.claim(links.token('v1', CLIP), PERSON);
    expect((await alertOf(ask)).status).toBe(200);
    expect(delivered).toHaveLength(1);
  });

  it('unlinks when the visitor turns it off', async () => {
    const { links, base } = await start({ telegram: true });
    links.claim(links.token('v1', CLIP), PERSON);
    const res = await fetch(`${base}/api/demo/telegram`, { method: 'DELETE', headers: { cookie: 'streamatic_demo=v1' } });
    expect(res.status).toBe(200);
    expect(links.ofPerson(PERSON)).toBeNull();
  });
});

describe('a visitor’s own picture', () => {
  it('is set up on one picture and kept nowhere, and comes back as the picture the outlines fit', async () => {
    const seen: Uint8Array[] = [];
    const { base } = await start({ setUp: async (bytes) => (seen.push(bytes), SETUP) });
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#223344' } }).png().toBuffer();
    const res = await fetch(`${base}/api/demo/uploads`, { method: 'POST', headers: { 'content-type': 'image/png', cookie: 'streamatic_demo=v1' }, body: new Uint8Array(big) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ width: 1280, height: 640, setup: { zones: [{ name: 'door' }] } });
    expect(body.picture.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect((await sharp(seen[0]!).metadata()).format).toBe('jpeg');
  });

  it('refuses a file that is not a picture, whatever it says it is', async () => {
    const { base } = await start();
    const named = await fetch(`${base}/api/demo/uploads`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
    expect(named.status).toBe(400);
    const posing = await fetch(`${base}/api/demo/uploads`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: 'hello' });
    expect(posing.status).toBe(400);
  });
});

describe('the public mode', () => {
  it('opens only the demo, the clips and the pages', async () => {
    const reached: string[] = [];
    const handle = publicOnly({
      app: (req, res) => {
        reached.push(req.url ?? '');
        res.writeHead(200).end();
      },
      demo: async () => false,
    });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const status = async (path: string, method = 'GET') => (await fetch(`${base}${path}`, { method })).status;

    for (const path of ['/', '/clips', '/clips/entrance', '/about', '/try', '/assets/a.js', '/api/clips', '/api/clips/entrance/follows', '/clip-videos/entrance', '/clip-pictures/entrance/3']) expect(await status(path)).toBe(200);
    for (const path of ['/api/cameras', '/api/events', '/api/rules', '/api/trials/x', '/media/a.jpg', '/camera-pictures/a/b.jpg']) expect(await status(path)).toBe(404);
    expect(await status('/api/questions', 'POST')).toBe(404);
    expect(await status('/api/guide/plans', 'POST')).toBe(404);
    expect(await status('/api/cameras/a/setup', 'POST')).toBe(404);
  });
});

describe('DemoLimits', () => {
  it('starts each day afresh, and remembers the day across a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'limits-'));
    const file = join(root, 'limits.json');
    let now = Date.UTC(2026, 10, 3, 12);
    const open = () => new DemoLimits({ file, ceilingMicroUsd: 1_000, now: () => now });
    const limits = open();
    expect(await limits.charge('v', 'rule', 600)).toBeNull();
    const reopened = open();
    expect(await reopened.charge('v', 'rule', 600)).toMatch(/limit/i);
    now += 24 * 60 * 60 * 1000;
    expect(await reopened.charge('v', 'rule', 600)).toBeNull();
  });
});

describe('a visitor’s zones', () => {
  const door = SETUP.zones[0]!;
  const twoDoors = { ...SETUP, zones: [{ ...door, outlines: { clip: [door.outlines.clip[0]!, { ...door.outlines.clip[0]!, objectId: '2', box: { left: 0, top: 100, right: 200, bottom: 500 }, path: 'M0 100 Z' }] } }] };
  const call = (base: string, cookie: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/demo/clips/${CLIP}/zones${path}`, { method, headers: { cookie: `streamatic_demo=${cookie}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const namesOn = async (ask: (path: string) => Promise<{ body: any }>) => ({
    clip: (await ask(`/api/demo/clips/${CLIP}`)).body.zones.map((z: any) => z.name),
    setup: (await ask(`/api/demo/clips/${CLIP}/setup`)).body.zones.map((z: any) => z.name),
  });

  it('lists each outlined thing as its own zone in setup, under the name the player and the guide use', async () => {
    const { visitor } = await start({ setup: twoDoors });
    expect(await namesOn(visitor('v1'))).toEqual({ clip: ['door 1', 'door 2'], setup: ['door 1', 'door 2'] });
  });

  it('renames a zone for the visitor who renamed it and for nobody else', async () => {
    const { visitor, base } = await start();
    const renamed = await call(base, 'v1', 'PUT', '/door', { name: 'Front door' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as any).zones.map((z: any) => z.name)).toEqual(['Front door']);
    expect(await namesOn(visitor('v1'))).toEqual({ clip: ['Front door'], setup: ['Front door'] });
    expect(await namesOn(visitor('v2'))).toEqual({ clip: ['door'], setup: ['door'] });
  });

  it('deletes a zone for the visitor who deleted it and for nobody else', async () => {
    const { visitor, base } = await start({ setup: twoDoors });
    expect((await call(base, 'v1', 'DELETE', '/door%201')).status).toBe(200);
    expect(await namesOn(visitor('v1'))).toEqual({ clip: ['door 2'], setup: ['door 2'] });
    expect((await namesOn(visitor('v2'))).setup).toEqual(['door 1', 'door 2']);
  });

  it('plans and routes on the visitor’s own zones', async () => {
    const { visitor, base } = await start({ guide: planner({ about: 'entrance', zones: ['entrance'] }), setUpNow: async (camera) => (camera as unknown as { setup: never }).setup });
    const sentence = 'Tell me when the entrance opens.';
    const plan = (who: string) => visitor(who)(`/api/demo/clips/${CLIP}/plans`, { sentence });
    for (const who of ['v1', 'v2']) await visitor(who)(`/api/demo/clips/${CLIP}/setup`, {});
    expect((await plan('v1')).body.status).toBe('needs-person');
    await call(base, 'v1', 'PUT', '/door', { name: 'entrance' });
    expect((await plan('v1')).body).toMatchObject({ status: 'ready', plan: { zones: ['entrance'] } });
    expect((await plan('v2')).body.status).toBe('needs-person');
    expect((await visitor('v1')('/api/demo/route', { sentence })).body.cameras.map((c: any) => c.zones)).toEqual([['entrance']]);
    expect((await visitor('v2')('/api/demo/route', { sentence })).body.cameras).toEqual([]);
  });

  it('no longer plans or routes on a zone the visitor deleted', async () => {
    const { visitor, base } = await start({ setUpNow: async (camera) => (camera as unknown as { setup: never }).setup });
    await visitor('v1')(`/api/demo/clips/${CLIP}/setup`, {});
    await call(base, 'v1', 'DELETE', '/door');
    const sentence = 'Tell me when the door opens.';
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence })).body.status).toBe('needs-person');
    expect((await visitor('v1')('/api/demo/route', { sentence })).body.cameras).toEqual([]);
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/rules`, { plan: { sentence, about: 'door', zones: ['door'], box: null, hours: null } })).status).toBe(400);
  });

  it('carries a rename to the visitor’s rules, and leaves a rule on a deleted zone as it is, since its sentence holds the place', async () => {
    const { visitor, base } = await start();
    const mine = visitor('v1');
    const plan = { sentence: 'Tell me when the door opens.', about: 'door', zones: ['door'], box: null, hours: null };
    const { id } = (await mine(`/api/demo/clips/${CLIP}/rules`, { plan })).body;
    const ruleZones = async () => (await mine(`/api/demo/clips/${CLIP}`)).body.rules.find((r: any) => r.id === id).zones.map((z: any) => z.name);
    await call(base, 'v1', 'PUT', '/door', { name: 'Front door' });
    expect(await ruleZones()).toEqual(['Front door']);
    await call(base, 'v1', 'DELETE', '/Front%20door');
    expect(await ruleZones()).toEqual(['Front door']);
  });

  it('refuses a name another zone holds, a blank name and a zone that is not there', async () => {
    const { base } = await start({ setup: twoDoors });
    const taken = await call(base, 'v1', 'PUT', '/door%201', { name: 'DOOR 2' });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as any).error).toBe('Another zone on this camera is already called “door 2”.');
    expect((await call(base, 'v1', 'PUT', '/door%201', { name: '  ' })).status).toBe(400);
    expect((await call(base, 'v1', 'PUT', '/gate', { name: 'Gate' })).status).toBe(404);
    expect((await call(base, 'v1', 'DELETE', '/gate')).status).toBe(404);
  });

  it('lets a zone be renamed twice and keeps its own name allowed in another case', async () => {
    const { visitor, base } = await start();
    await call(base, 'v1', 'PUT', '/door', { name: 'Front door' });
    expect((await call(base, 'v1', 'PUT', '/Front%20door', { name: 'front door' })).status).toBe(200);
    expect((await call(base, 'v1', 'PUT', '/front%20door', { name: 'Main door' })).status).toBe(200);
    expect((await namesOn(visitor('v1'))).setup).toEqual(['Main door']);
  });

  it('returns the zones and the rules’ names on reset, and says whether anything was changed', async () => {
    const { visitor, base } = await start({ setup: twoDoors });
    const mine = visitor('v1');
    expect((await mine(`/api/demo/clips/${CLIP}/setup`)).body.edited).toBe(false);
    const plan = { sentence: 'Tell me when door 1 opens.', about: 'door 1', zones: ['door 1'], box: null, hours: null };
    const { id } = (await mine(`/api/demo/clips/${CLIP}/rules`, { plan })).body;
    await call(base, 'v1', 'PUT', '/door%201', { name: 'Front door' });
    await call(base, 'v1', 'DELETE', '/door%202');
    expect((await mine(`/api/demo/clips/${CLIP}/setup`)).body.edited).toBe(true);
    const reset = await call(base, 'v1', 'DELETE', '');
    expect(reset.status).toBe(200);
    expect((await mine(`/api/demo/clips/${CLIP}/setup`)).body).toMatchObject({ edited: false, zones: [{ name: 'door 1' }, { name: 'door 2' }] });
    expect((await mine(`/api/demo/clips/${CLIP}`)).body.rules.find((r: any) => r.id === id).zones.map((z: any) => z.name)).toEqual(['door 1']);
  });
});

describe('a question about a clip', () => {
  const detections = {
    fps: 2,
    width: 1280,
    height: 720,
    tracks: [{ id: 1, kind: 'person', points: [[0, 500, 400, 520, 450], [500, 500, 400, 520, 450], [1000, 1000, 200, 1040, 300], [1500, 1000, 200, 1040, 300]] }],
  };
  const detected = { state: () => 'ready' as const, found: () => detections as ClipDetections, ensure: () => undefined };
  const zoneOf = async (ask: (path: string, body?: unknown) => Promise<{ status: number; body: any }>) => ask(`/api/demo/clips/${CLIP}/questions`, { sentence: 'How many people went through the door?' });

  it('answers from what was detected, with the moments found, under the visitor’s own name for the zone', async () => {
    const seen: unknown[] = [];
    const asker: ToolAsker = {
      withTools: async (_instruction, tools, run) => {
        seen.push((tools[1]!.parameters as any).properties.zone.enum);
        await run('zone_crossings', { kind: 'person', zone: 'Front door' });
        return 'About 1 person moved onto it at 0:01.';
      },
    };
    const { visitor, base } = await start({ asker, detection: detected });
    await fetch(`${base}/api/demo/clips/${CLIP}/zones/door`, { method: 'PUT', headers: { cookie: 'streamatic_demo=v1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Front door' }) });
    const { status, body } = await zoneOf(visitor('v1'));
    expect(status).toBe(200);
    expect(body).toEqual({ answer: 'About 1 person moved onto it at 0:01.', moments: [{ atMs: 1000, label: 'Moved onto' }] });
    expect(seen).toEqual([['Front door']]);
  });

  it('says on the clip whether it can be asked about', async () => {
    const without = await start();
    expect((await without.visitor('v1')(`/api/demo/clips/${CLIP}`)).body).toMatchObject({ canCount: false, detection: null });
    const withDetector = await start({ detection: detected });
    expect((await withDetector.visitor('v1')(`/api/demo/clips/${CLIP}`)).body).toMatchObject({ canCount: true, detection: 'ready' });
  });

  it('asks for keys on a copy with no detector, whatever files its folder holds', async () => {
    const { visitor, root } = await start();
    await mkdir(join(root, 'clips', CLIP), { recursive: true });
    await writeFile(join(root, 'clips', CLIP, 'detections.json'), JSON.stringify(detections));
    const { status, body } = await zoneOf(visitor('v1'));
    expect(status).toBe(409);
    expect(body.error).toBe(NEEDS_KEYS);
  });

  it('starts detection for a question on a clip not yet detected, tells the page to wait, and spends nothing', async () => {
    const asked: string[] = [];
    const { visitor } = await start({
      ceilingMicroUsd: 1,
      detection: { state: () => 'running', found: () => null, ensure: (clip: string) => void asked.push(clip) },
    });
    const { status, body } = await zoneOf(visitor('v1'));
    expect(status).toBe(202);
    expect(body).toEqual({ status: 'detecting' });
    expect(asked).toEqual([CLIP]);
  });

  it('asks for keys on a copy without them, and spends nothing', async () => {
    const { visitor } = await start({ abilities: { models: false, rules: false }, detection: detected });
    const { status, body } = await zoneOf(visitor('v1'));
    expect(status).toBe(409);
    expect(body.error).toBe(NEEDS_KEYS);
  });

  it('counts a question against the visitor’s plans', async () => {
    const { visitor } = await start({ ceilingMicroUsd: 1, detection: detected });
    expect((await zoneOf(visitor('v1'))).status).toBe(429);
  });

  it('tells the page a sentence is a question, for the page to ask', async () => {
    const { visitor } = await start({ guide: { draft: async () => ({ question: true }) } });
    expect((await visitor('v1')(`/api/demo/clips/${CLIP}/plans`, { sentence: 'How many people came in?' })).body).toMatchObject({ status: 'question' });
  });
});
