import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { CameraFolder } from '../src/cameras/camera-folder.js';
import { DemoEngine, showing, type DemoEngineBackend } from '../src/demo/engine.js';
import { DemoLimits } from '../src/demo/limits.js';
import { demoHandler, publicOnly } from '../src/demo/routes.js';
import { DemoStore } from '../src/demo/store.js';
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
      progress: { done: 2, total: 4 },
      rule: { name: 'Door', readsAs: 'Tell me if a door opens.' },
      refusal: draftStatus === 'refused' ? { rewrites: ['Tell me when someone opens a door.'], reason: 'Two things in order.' } : null,
    }),
  };
  return { backend, typed, asked, setDraft: (status: string) => (draftStatus = status) };
}

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

const planner = (over: Partial<GuidePlan> = {}): GuidePlanner => ({
  draft: async ({ sentence }) => ({ sentence, about: 'door', zones: ['door'], box: null, hours: null, ...over }),
});

async function start({ ceilingMicroUsd = 5_000_000, setUp = async () => SETUP, guide = planner(), setup = SETUP, abilities }: { ceilingMicroUsd?: number; setUp?: (bytes: Uint8Array) => Promise<unknown>; guide?: GuidePlanner; setup?: unknown; abilities?: { models: boolean; rules: boolean } } = {}) {
  const fake = fakeBackend();
  const root = await mkdtemp(join(tmpdir(), 'demo-'));
  await mkdir(join(root, 'cameras', CLIP), { recursive: true });
  await writeFile(join(root, 'cameras', CLIP, 'camera.json'), JSON.stringify({ name: 'Building entrance', site: 'a building', baseWords: [], pictures: { clip: 'still.jpg' } }));
  await writeFile(join(root, 'cameras', CLIP, 'setup.json'), JSON.stringify(setup));
  const store = new DemoStore(join(root, 'demo.db'));
  const engine = new DemoEngine({
    store,
    backend: fake.backend,
    folder: root,
    fetch: (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 })) as unknown as typeof fetch,
  });
  await engine.copyClip({ id: CLIP, scenario: SCENARIO });
  const clip = { id: CLIP, name: 'Building entrance', width: 1280, height: 720, fps: 10, frames: 600, video: join(root, 'clip.mp4') };
  const handle = demoHandler({
    engine,
    store,
    limits: new DemoLimits({ file: join(root, 'limits.json'), ceilingMicroUsd, now: () => Date.UTC(2026, 10, 3, 12) }),
    clips: { get: async (id) => (id === CLIP ? clip : null) },
    cameras: new CameraFolder(root),
    guidePlanner: guide,
    setUp,
    folder: root,
    trackSeconds: 30,
    ...(abilities ? { abilities } : {}),
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
  return { base, visitor, engine, root, ...fake };
}

describe('the demo engine', () => {
  it('copies each rule’s alert points once, and playing a clip asks the backend nothing', async () => {
    const { visitor, asked, engine } = await start();
    const copied = asked.length;
    expect(copied).toBe(4); // One rule over the four 15-second pieces of a 60-second clip.
    await engine.copyClip({ id: CLIP, scenario: SCENARIO });
    expect(asked.length).toBe(copied);
    const { body } = await visitor('v1')(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs: 0 }] });
    expect(body.alerts).toMatchObject([{ key: 'key-1', rule: 'rule-1', atMs: 42_000, shownMs: 60_000, delayMs: 18_000, message: 'A door opened.' }]);
    expect(asked.length).toBe(copied);
  });

  it('answers a tick from the piece of the clip it falls in, as a rule saved at that moment would run', async () => {
    const { visitor } = await start();
    const ask = visitor('v1');
    const at = async (armedMs: number) => (await ask(`/api/demo/clips/${CLIP}/alerts`, { ticks: [{ rule: 'rule-1', armedMs }] })).body.alerts;
    expect(await at(16_000)).toHaveLength(1);
    expect(await at(46_000)).toEqual([]);
  });

  it('never shows an alert before its rule was ticked', () => {
    const alert = { key: 'k', rule: 'r', atMs: 42_000, shownMs: 60_000, delayMs: 18_000, message: 'm', severity: 'medium', picture: null, caption: null };
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

describe('a copy of the page with no keys and no login', () => {
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
