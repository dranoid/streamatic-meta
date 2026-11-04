import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraFolder } from '../src/cameras/camera-folder.js';
import { ClipFolder } from '../src/follow/clips.js';
import { Follows } from '../src/follow/follows.js';
import { ClipThings } from '../src/follow/things.js';
import { EventStore } from '../src/events/store.js';
import type { Plan } from '../src/questions/answer.js';
import { Trials } from '../src/backend/trials.js';
import type { GuidePlan } from '../src/guide/plan.js';
import { BackendError, type RuleBackend } from '../src/backend/client.js';
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
        day: [{ word: 'door', objectId: '0', box: { left: 1, top: 1, right: 6, bottom: 6 }, path: 'M1 1Z' }],
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

const voiceKeywordsAsked: string[][] = [];
let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function start({
  plan,
  setUp,
  playing,
  stored,
  clip,
  backendFails,
  connected = true,
  spend,
  planned,
}: {
  // What the guide's planner drafts, in place of its plain plan on the door.
  planned?: Partial<GuidePlan>;
  plan?: Plan;
  setUp?: () => Promise<CameraSetup>;
  playing?: { at: number | null; picture: Uint8Array | null };
  stored?: boolean;
  clip?: boolean;
  spend?: (request: IncomingMessage, response: ServerResponse, kind: 'look' | 'track') => Promise<string | null>;
  backendFails?: BackendError;
  connected?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'app-'));
  const web = join(root, 'web');
  const media = join(root, 'media');
  const camera = join(root, 'cameras', 'table-parlour');
  await Promise.all([mkdir(web), mkdir(media), mkdir(camera, { recursive: true })]);
  if (playing) await mkdir(join(camera, 'episode'));
  if (clip) {
    await mkdir(join(root, 'clips', 'yard'), { recursive: true });
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=2', '-pix_fmt', 'yuv420p', join(root, 'clips', 'yard', 'clip.mp4')]);
    await writeFile(join(root, 'clips', 'yard', 'clip.json'), JSON.stringify({ name: 'Yard', video: 'clip.mp4' }));
  }
  await Promise.all([
    writeFile(join(web, 'index.html'), '<title>Streamatic</title>'),
    mkdir(join(web, 'assets')).then(() => writeFile(join(web, 'assets', 'app.js'), 'console.log(1)')),
    writeFile(join(media, 'door.jpg'), 'jpeg bytes'),
    writeFile(join(camera, 'day.jpg'), 'day bytes'),
    writeFile(join(camera, 'night.jpg'), 'night bytes'),
    writeFile(
      join(camera, 'camera.json'),
      JSON.stringify({
        name: 'Table parlour',
        site: 'a family home',
        baseWords: ['door'],
        pictures: { day: 'day.jpg', night: 'night.jpg' },
        ...(connected
          ? { backend: { deviceId: 'device-1', recorded: stored ? { from: new Date(AT - 2000).toISOString(), to: new Date(AT).toISOString() } : null } }
          : {}),
      }),
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
    backendId: null,
    recorded: false,
  });
  events.addFrames(eventId, [
    { at: AT - 1000, file: 'before.jpg', outline: null },
    { at: AT, file: 'door.jpg', outline: 'M1 1Z' },
  ]);
  const questions: string[] = [];
  const setUpCalls: string[][] = [];
  const backendCalls: Array<{ call: string; args: unknown[] }> = [];
  let nextRule = 1;
  const backend: RuleBackend = {
    parse: async (request) => {
      backendCalls.push({ call: 'parse', args: [request] });
      if (request.includes('forbidden')) return { supported: false, refusal: 'That cannot be seen from a camera.', rewrites: ['Tell me if a door opens.'] };
      return { supported: true, name: 'Door', readsAs: 'Tell me if the door opens.', subject: 'a door', severity: 'medium', schedule: null, condition: { question: 'Is the door opening?', verdict: true, framesPerAnswer: 'several', sampleGapSeconds: 3 } };
    },
    probe: async (deviceId, request) => {
      backendCalls.push({ call: 'probe', args: [deviceId, request] });
      return { answerableCount: 1, warns: false, cameras: [] };
    },
    createRule: async (deviceId, request, draft) => {
      backendCalls.push({ call: 'createRule', args: [deviceId, request, draft] });
      if (backendFails) throw backendFails;
      return `backend-${nextRule++}`;
    },
    deleteRule: async (id) => void backendCalls.push({ call: 'deleteRule', args: [id] }),
    alerts: async () => [],
    pictureUrls: async () => ({}),
    estimateQuestion: async (ask) => (backendCalls.push({ call: 'estimateQuestion', args: [ask] }), { costMicroUsd: 42, reason: null }),
    startQuestion: async (ask, asked, cost) => (backendCalls.push({ call: 'startQuestion', args: [ask, asked, cost] }), 'replay-1'),
    replay: async () => ({ id: 'replay-1', status: 'completed', counted: { coverage: { framesRead: 3, framesRecorded: 3 } }, stretches: [{ startIso: new Date(AT).toISOString(), endIso: new Date(AT + 5000).toISOString(), frameUrl: 'https://pictures.test/1' }] }),
  };
  const written: unknown[] = [];
  const followCalls = { lists: 0, tracks: [] as Array<{ frame: number; targets: unknown }> };
  const carBox = { left: 5, top: 5, right: 20, bottom: 20 };
  const clips = new ClipFolder(root);
  server = createServer(
    appHandler({
      events,
      rules: new RuleStore(':memory:'),
      cameras: new CameraFolder(root),
      mediaDir: media,
      webDir: web,
      planner: { plan: async (q) => (questions.push(q), plan ?? { tool: 'count', camera: null, zone: 'front door', period: 'all', hours: null }) },
      guidePlanner: {
        draft: async ({ sentence, zones }) => ({ sentence, about: 'front door', zones: zones.length ? [zones[zones.length - 1]!.name] : ['door'], box: null, hours: { from: 21, to: 6 }, ...planned }),
      },
      writeCaption: async (rule, language) => (written.push({ rule, language }), `${language}: ${rule}`),
      voiceNotes: { read: async (_request, keywords) => (voiceKeywordsAsked.push(keywords), { status: 200, body: { text: 'Tell me when the front door opens.' } }) },
      backend: connected ? backend : null,
      trials: new Trials(backend, async () => new Uint8Array([1, 2, 3])),
      pictureSize: async () => ({ width: 1200, height: 700 }),
      setUp: async (_camera, pictures) => {
        setUpCalls.push(pictures.map((p) => `${p.label}:${new TextDecoder().decode(p.picture.bytes)}`));
        return setUp ? setUp() : setupResult;
      },
      following: {
        clips,
        things: new ClipThings(root),
        follows: new Follows(root, clips, {
          upload: async () => 'file-1',
          track: async (_file, _size, frame, targets) => {
            followCalls.tracks.push({ frame, targets });
            return targets.map(() => [{ frame, box: carBox, path: 'M5 5Z' }]);
          },
        }),
        listThings: async () => (followCalls.lists++, ['car']),
        nameThing: async () => 'bag',
        outlineAll: async (_picture, words) => Object.fromEntries(words.map((w) => [w, w === 'nothing' ? [] : [{ word: w, objectId: '0', box: w === 'car' ? carBox : { left: 40, top: 5, right: 60, bottom: 30 }, path: 'M1 1Z' }]])),
        outlineIn: async (_picture, _size, box, name) => (box.left === 2 ? null : { word: name, objectId: '1', box, path: 'M2 2Z' }),
      },
      timeZone: 'Africa/Lagos',
      now: () => AT + 60_000,
      playing: (id) => (playing && id === 'table-parlour' ? playing : null),
      ...(spend ? { spend } : {}),
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
  const patch = (path: string, body: unknown) =>
    json(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // A rule is read by the backend, and saved only when the person says yes to the draft.
  const saveRule = async (rule: unknown) => {
    const draft = await post('/api/rule-drafts', rule);
    return draft.status === 200 ? post('/api/rules', { draft: draft.body.id }) : draft;
  };
  return { base, root, eventId, questions, setUpCalls, backendCalls, followCalls, written, json, post, patch, saveRule };
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
      { connected: true, id: 'table-parlour', name: 'Table parlour', site: 'a family home', baseWords: ['door'], pictures: { day: 'day.jpg', night: 'night.jpg' }, setup: null, zones: [], coverage: [], playing: null, stored: null },
    ]);
    expect(await (await fetch(`${base}/camera-pictures/table-parlour/day.jpg`)).text()).toBe('day bytes');
    expect((await fetch(`${base}/camera-pictures/table-parlour/..%2Fcamera.json`)).status).toBe(404);
  });

  it('reports which pictures found each zone once setup has run', async () => {
    const { json, post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const coverage = (await json('/api/cameras')).body[0].coverage;
    expect(coverage.length).toBeGreaterThan(0);
    for (const zone of coverage) {
      expect([...zone.foundOn, ...zone.missedOn].sort()).toEqual(['day', 'night']);
      expect(zone.uncertainAtNight).toBe(!zone.foundOn.includes('night'));
    }
  });

  it('says when a camera is playing its recording on a loop, with the time and picture playing', async () => {
    const { json, base } = await start({ playing: { at: AT, picture: new TextEncoder().encode('now bytes') } });
    expect((await json('/api/cameras')).body[0].playing).toEqual({ at: AT });
    const now = await fetch(`${base}/api/cameras/table-parlour/now`);
    expect(now.headers.get('content-type')).toBe('image/jpeg');
    expect(await now.text()).toBe('now bytes');
    expect((await fetch(`${base}/api/cameras/amosu/now`)).status).toBe(404);
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

const outlineRule = {
  camera: 'table-parlour',
  sentence: 'Alert me if the front door opens after 9 pm.',
  zones: [{ kind: 'outline', word: 'door', label: 'night', objectId: '1' }],
  activeHours: { from: 21, to: 6 },
};

describe('rules', () => {
  it("saves an outline zone under its zone's name, with the box and outline SAM drew at setup, then lists and removes it", async () => {
    const { json, post, saveRule, backendCalls } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const saved = await saveRule(outlineRule);
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      camera: 'table-parlour',
      zones: [{ name: 'door 2', kind: 'outline', word: 'door', reference: doorBox, path: 'M869 317Z' }],
      activeHours: { from: 21, to: 6 },
      backendRuleId: 'backend-1',
    });
    expect((await json('/api/rules?camera=table-parlour')).body.map((r: any) => r.id)).toEqual([saved.body.id]);
    expect((await json('/api/cameras')).body[0].zones.map((z: any) => [z.name, z.rules])).toEqual([['door 1', []], ['door 2', [saved.body.id]]]);
    expect((await json(`/api/rules/${saved.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(backendCalls.at(-1)).toEqual({ call: 'deleteRule', args: ['backend-1'] });
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('sends the backend the sentence with each zone’s place, read from SAM’s box', async () => {
    const { post, backendCalls } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    await post('/api/rule-drafts', outlineRule);
    expect(backendCalls.find((c) => c.call === 'parse')!.args).toEqual(['Alert me if the front door opens after 9 pm. The door 2 is on the right side of the picture.']);
  });

  it('shows the draft and saves nothing until the person says yes', async () => {
    const { json, post, backendCalls } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const draft = await post('/api/rule-drafts', outlineRule);
    expect(draft.body).toMatchObject({ supported: true, readsAs: 'Tell me if the door opens.', severalPictures: true, canAnswer: true });
    expect(backendCalls.map((c) => c.call)).toEqual(['parse', 'probe']);
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('carries the person’s hours into the rule the backend saves', async () => {
    const { post, saveRule, backendCalls } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    await saveRule(outlineRule);
    const [, , sent] = backendCalls.find((c) => c.call === 'createRule')!.args as [string, string, { schedule: unknown }];
    expect(sent.schedule).toEqual({ type: 'time_windows', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startTime: '21:00', endTime: '06:00' }] });
  });

  it('keeps nothing in the app when the backend refuses the rule, and shows the backend’s words', async () => {
    const { json, post, saveRule } = await start({ backendFails: new BackendError(400, 'That camera is not in this company') });
    await post('/api/cameras/table-parlour/setup', {});
    const refused = await saveRule(outlineRule);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('That camera is not in this company');
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('shows the parse’s refusal and rewrites, and offers nothing to save', async () => {
    const { post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const refused = await post('/api/rule-drafts', { ...outlineRule, sentence: 'Something forbidden' });
    expect(refused.body).toMatchObject({ id: null, supported: false, refusal: 'That cannot be seen from a camera.', rewrites: ['Tell me if a door opens.'] });
  });

  it('refuses a draft that has lapsed', async () => {
    const { post } = await start();
    const refused = await post('/api/rules', { draft: 'no-such-draft' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/lapsed/);
  });

  it('refuses a rule on a camera that is not connected to Streamatic', async () => {
    const { post } = await start({ connected: false });
    await post('/api/cameras/table-parlour/setup', {});
    const refused = await post('/api/rule-drafts', outlineRule);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/not connected/);
  });

  it('refuses an outline that setup did not produce, and saves nothing', async () => {
    const { json, post, saveRule } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const refused = await saveRule({ ...outlineRule, zones: [{ ...outlineRule.zones[0], objectId: '7' }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/outline/i);
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('saves a drawn box with its question, and refuses one without a question', async () => {
    const { post, saveRule } = await start();
    const box = { kind: 'box', name: 'doorway', box: { left: 10, top: 20, right: 30, bottom: 40 } };
    expect((await post('/api/rule-drafts', { ...outlineRule, zones: [box] })).status).toBe(400);
    const saved = await saveRule({ ...outlineRule, zones: [{ ...box, question: 'Is the door open?' }] });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ zones: [{ kind: 'box', name: 'doorway', box: box.box, question: 'Is the door open?' }] });
  });
});

describe('an event’s caption in another language', () => {
  it('writes it once for the rule, and keeps it', async () => {
    const { post, json, eventId, written } = await start();
    const rule = (await json(`/api/events/${eventId}`)).body.rule as string;
    const first = await post(`/api/events/${eventId}/captions`, { language: 'yoruba' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ language: 'yoruba', text: `yoruba: ${rule}` });
    expect((await post(`/api/events/${eventId}/captions`, { language: 'yoruba' })).body).toEqual(first.body);
    expect(written).toHaveLength(1);
  });

  it('refuses a language it does not write, and an event that does not exist', async () => {
    const { post, eventId, written } = await start();
    expect((await post(`/api/events/${eventId}/captions`, { language: 'french' })).status).toBe(400);
    expect((await post('/api/events/999/captions', { language: 'pidgin' })).status).toBe(404);
    expect(written).toEqual([]);
  });
});

describe('a voice note on a camera', () => {
  it('answers with what was said, listening for the zones setup outlined there', async () => {
    const { base, post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    voiceKeywordsAsked.length = 0;
    const res = await fetch(`${base}/api/cameras/table-parlour/voice-notes`, { method: 'POST', body: new Uint8Array([1]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Tell me when the front door opens.' });
    expect(voiceKeywordsAsked[0]).toContain('door');
  });

  it('is refused on a camera that does not exist', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/cameras/nowhere/voice-notes`, { method: 'POST', body: new Uint8Array([1]) })).status).toBe(404);
  });
});

describe('the guide on a camera that did not outline the thing', () => {
  const group = async (root: string, id: string, group: string, word: string) => {
    await mkdir(join(root, 'cameras', id), { recursive: true });
    await writeFile(join(root, 'cameras', id, 'camera.json'), JSON.stringify({ name: `${id} road`, site: 's', baseWords: [], pictures: { day: 'day.jpg' }, group }));
    await writeFile(join(root, 'cameras', id, 'setup.json'), JSON.stringify({ zones: [{ name: word, item: word, seenAt: ['day'], outlines: { day: [{ word, objectId: '0', box: { left: 1, top: 1, right: 9, bottom: 9 }, path: 'M1 1Z' }] } }], notOutlined: [], rules: [] }));
  };

  it('offers the camera in its group whose setup outlined it, from the person’s own words', async () => {
    const { post, root } = await start({ planned: { about: 'shop', zones: [], box: { name: 'shop', question: 'Is someone at the shop?', over: null } } });
    await post('/api/cameras/table-parlour/setup', {});
    const config = join(root, 'cameras', 'table-parlour', 'camera.json');
    await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), group: 'estate' }));
    await group(root, 'foursquare', 'estate', 'shop');
    await group(root, 'elsewhere', 'another', 'shop');
    const planned = await post('/api/guide/plans', { camera: 'table-parlour', sentence: 'Tell me when someone is at the shop.' });
    expect(planned.status).toBe(200);
    expect(planned.body.elsewhere).toEqual([{ camera: 'foursquare', name: 'foursquare road', zones: ['shop'], matched: 1 }]);
  });

  it('offers nothing when this camera outlined it', async () => {
    const { post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const planned = await post('/api/guide/plans', { camera: 'table-parlour', sentence: 'Tell me if the front door opens at night.' });
    expect(planned.body.elsewhere).toEqual([]);
  });
});

describe('the guide', () => {
  it("plans a rule on the camera's zones and returns the plan with its checked attempts", async () => {
    const { post } = await start();
    await post('/api/cameras/table-parlour/setup', {});

    const planned = await post('/api/guide/plans', { camera: 'table-parlour', sentence: 'Tell me if the front door opens at night.' });

    expect(planned.status).toBe(200);
    expect(planned.body).toEqual({
      status: 'ready',
      plan: { sentence: 'Tell me if the front door opens at night.', about: 'front door', zones: ['door 2'], box: null, hours: { from: 21, to: 6 } },
      attempts: [expect.objectContaining({ problems: [] })],
      elsewhere: [],
    });
  });

  it('asks a person when no plan passes, saying what was wrong', async () => {
    const { post } = await start();

    const planned = await post('/api/guide/plans', { camera: 'table-parlour', sentence: 'Tell me if the front door opens at night.' });

    expect(planned.body.status).toBe('needs-person');
    expect(planned.body.attempts).toHaveLength(3);
    expect(planned.body.problems[0]).toMatch(/"door" is not a zone on this camera/);
  });

  it('refuses an empty request and a camera that does not exist', async () => {
    const { post } = await start();
    expect((await post('/api/guide/plans', { camera: 'table-parlour', sentence: ' ' })).status).toBe(400);
    expect((await post('/api/guide/plans', { camera: 'nowhere', sentence: 'Tell me if the door opens.' })).status).toBe(404);
  });
});

describe('trying a rule on stored pictures', () => {
  it('asks the backend the draft’s question at the confirmed price, shows each stretch with its picture, and saves nothing', async () => {
    const { base, json, post, backendCalls } = await start({ stored: true });
    await post('/api/cameras/table-parlour/setup', {});
    const draft = await post('/api/rule-drafts', outlineRule);

    const estimate = await json(`/api/rule-drafts/${draft.body.id}/trial-estimate`);
    expect(estimate.body).toMatchObject({ costMicroUsd: 42, reason: null, from: AT - 2000, to: AT });

    const started = await post('/api/trials', { draft: draft.body.id, confirmedCostMicroUsd: 42 });
    expect(started.status).toBe(202);
    const [ask, asked, cost] = backendCalls.find((c) => c.call === 'startQuestion')!.args;
    expect(ask).toMatchObject({ question: 'Is the door opening?', verdict: true, settledBy: 'brief-change', deviceId: 'device-1' });
    expect([asked, cost]).toEqual(['Alert me if the front door opens after 9 pm.', 42]);

    const view = await json(`/api/trials/${started.body.id}`);
    expect(view.body).toEqual({ state: 'done', read: 3, total: 3, stretches: [{ from: AT, to: AT + 5000, picture: 0 }] });
    expect(JSON.stringify(view.body)).not.toContain('pictures.test');
    const picture = await fetch(`${base}/api/trials/${started.body.id}/pictures/0`);
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await json('/api/rules')).body).toEqual([]);
  });

  it('keeps what a finished trial found as the saved rule’s events, labelled as a recorded run', async () => {
    const { json, post } = await start({ stored: true });
    await post('/api/cameras/table-parlour/setup', {});
    const draft = await post('/api/rule-drafts', outlineRule);
    const started = await post('/api/trials', { draft: draft.body.id, confirmedCostMicroUsd: 42 });
    await json(`/api/trials/${started.body.id}`);

    await post('/api/rules', { draft: draft.body.id });

    const kept = (await json('/api/events')).body.filter((e: any) => e.recorded);
    expect(kept).toEqual([expect.objectContaining({ camera: 'Table parlour', zone: 'door 2', at: AT, rule: outlineRule.sentence, picture: `replay-1-${AT}.jpg` })]);
  });

  it('refuses a camera with no stored pictures, and asks nothing', async () => {
    const { json, post, backendCalls } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const draft = await post('/api/rule-drafts', outlineRule);

    const refused = await json(`/api/rule-drafts/${draft.body.id}/trial-estimate`);

    expect(refused.status).toBe(409);
    expect(backendCalls.map((c) => c.call)).toEqual(['parse', 'probe']);
  });

  it('saves a rule on two zones of the same picture, each under its own name', async () => {
    const { post, saveRule } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const both = [outlineRule.zones[0], { kind: 'outline', word: 'door', label: 'night', objectId: '0' }];
    const saved = await saveRule({ ...outlineRule, sentence: 'Alert me if both doors are open.', zones: both });
    expect(saved.status).toBe(201);
    expect(saved.body.zones.map((z: any) => z.name)).toEqual(['door 2', 'door 1']);
  });

  it('refuses a drawn box named like an outlined zone on the same camera', async () => {
    const { post } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const box = { kind: 'box', name: 'Door 1', box: { left: 10, top: 20, right: 30, bottom: 40 }, question: 'Is the door open?' };
    const refused = await post('/api/rule-drafts', { ...outlineRule, zones: [box] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('door 1');
  });
});

describe('zone names', () => {
  const frontDoor = { word: 'door', label: 'night', objectId: '1' };

  it('renames a zone, and the rules and events on it take the new name while the other door keeps its own', async () => {
    const { json, post, patch, eventId, saveRule } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const onFront = (await saveRule(outlineRule)).body.id;
    const onOther = (await saveRule({ ...outlineRule, zones: [{ kind: 'outline', word: 'door', label: 'day', objectId: '0' }] })).body.id;

    expect((await patch('/api/cameras/table-parlour/zones', { ...frontDoor, name: 'front door' })).body).toMatchObject({ rules: 1, events: 0 });
    const renamed = await patch('/api/cameras/table-parlour/zones', { ...frontDoor, name: 'Shop door' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ rules: 1, events: 1 });

    expect((await json('/api/cameras')).body[0].zones.map((z: any) => z.name)).toEqual(['door 1', 'Shop door']);
    const names = Object.fromEntries((await json('/api/rules')).body.map((r: any) => [r.id, r.zones[0].name]));
    expect(names).toEqual({ [onFront]: 'Shop door', [onOther]: 'door 1' });
    expect((await json(`/api/events/${eventId}`)).body.zone).toBe('Shop door');
  });

  it('keeps the names when setup runs again', async () => {
    const { json, post, patch } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    await patch('/api/cameras/table-parlour/zones', { ...frontDoor, name: 'front door' });
    await post('/api/cameras/table-parlour/setup', {});
    expect((await json('/api/cameras')).body[0].zones.map((z: any) => z.name)).toEqual(['door 1', 'front door']);
  });

  it('refuses a name another zone on the camera already has, and an outline setup did not produce', async () => {
    const { json, post, patch } = await start();
    await post('/api/cameras/table-parlour/setup', {});
    const taken = await patch('/api/cameras/table-parlour/zones', { ...frontDoor, name: 'Door 1' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain('door 1');
    expect((await patch('/api/cameras/table-parlour/zones', { ...frontDoor, objectId: '7', name: 'front door' })).status).toBe(400);
    expect((await json('/api/cameras')).body[0].zones.map((z: any) => z.name)).toEqual(['door 1', 'door 2']);
  });
});

describe('following a thing in a clip', () => {
  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });

  it('lists the clip without its place on disk, and serves frames and byte ranges of the video', async () => {
    const { base } = await start({ clip: true });
    const clips = (await (await fetch(`${base}/api/clips`)).json()) as Array<Record<string, unknown>>;
    expect(clips[0]).toMatchObject({ id: 'yard', name: 'Yard', frames: 20, fps: 10 });
    expect(clips[0]).not.toHaveProperty('video');
    expect((await fetch(`${base}/clip-pictures/yard/3`)).headers.get('content-type')).toBe('image/jpeg');
    expect((await fetch(`${base}/clip-pictures/yard/500`)).status).toBe(404);
    const part = await fetch(`${base}/clip-videos/yard`, { headers: { range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
  });

  it('names a frame once, and adds each search and drawn box to what is on it', async () => {
    const { base, followCalls } = await start({ clip: true });
    const named = (await (await post(base, '/api/clips/yard/frames/3/things', {})).json()) as { things: Array<{ name: string }> };
    expect(named.things.map((t) => t.name)).toEqual(['car']);
    await post(base, '/api/clips/yard/frames/3/things', {});
    expect(followCalls.lists).toBe(1);

    const searched = (await (await post(base, '/api/clips/yard/frames/3/things', { word: 'bag' })).json()) as { things: unknown[]; found: number };
    expect(searched).toMatchObject({ found: 1 });
    expect(searched.things).toHaveLength(2);
    const none = (await (await post(base, '/api/clips/yard/frames/3/things', { word: 'nothing' })).json()) as { found: number };
    expect(none.found).toBe(0);

    const drawn = (await (await post(base, '/api/clips/yard/frames/3/things', { box: { left: 22, top: 22, right: 38, bottom: 34 } })).json()) as { things: Array<{ id: string; name: string; box: unknown }>; selected: string; found: number };
    expect(drawn.found).toBe(1);
    expect(drawn.things.find((t) => t.id === drawn.selected)).toMatchObject({ name: 'bag', box: { left: 22, top: 22, right: 38, bottom: 34 } });

    const empty = (await (await post(base, '/api/clips/yard/frames/3/things', { box: { left: 2, top: 22, right: 14, bottom: 34 } })).json()) as { found: number; selected?: string };
    expect(empty.found).toBe(0);
    expect(empty.selected).toBeUndefined();
  });

  it('keeps the outline found by the name of what a box holds, when it is the same thing, since a box alone can take in the ground around it', async () => {
    const { base } = await start({ clip: true });
    const drawn = (await (await post(base, '/api/clips/yard/frames/3/things', { box: { left: 36, top: 2, right: 64, bottom: 34 } })).json()) as { things: Array<{ id: string; name: string; box: unknown; path: string }>; selected: string };
    expect(drawn.things.find((t) => t.id === drawn.selected)).toEqual({ id: drawn.selected, name: 'bag', box: { left: 40, top: 5, right: 60, bottom: 30 }, path: 'M1 1Z' });
  });

  it('refuses a drawn box that is outside the frame, inside out, or too small to name anything', async () => {
    const { base } = await start({ clip: true });
    const frame = await (await post(base, '/api/clips/yard/frames/3/things', {})).json();
    expect(frame).toBeTruthy();
    const refused = [
      { left: 10, top: 10, right: 5000, bottom: 40 },
      { left: 40, top: 10, right: 10, bottom: 40 },
      { left: 10, top: 10, right: 12, bottom: 12 },
    ];
    for (const box of refused) expect((await post(base, '/api/clips/yard/frames/3/things', { box })).status).toBe(400);
  });

  it('charges only for what is new on a clip, and stops when the limit is reached', async () => {
    const charged: string[] = [];
    let reached: string | null = null;
    const { base } = await start({ clip: true, spend: async (_req, _res, kind) => (reached ?? (charged.push(kind), null)) });
    const { things } = (await (await post(base, '/api/clips/yard/frames/3/things', {})).json()) as { things: Array<{ id: string }> };
    await post(base, '/api/clips/yard/frames/3/things', {});
    expect(charged).toEqual(['look']);
    await post(base, '/api/clips/yard/frames/3/things', { word: 'bag' });
    expect(charged).toEqual(['look', 'look']);
    const started = (await (await post(base, '/api/clips/yard/follows', { frame: 3, things: [things[0]!.id] })).json()) as { id: string };
    expect(charged).toEqual(['look', 'look', 'track']);
    await vi.waitFor(async () => expect(((await (await fetch(`${base}/api/clips/yard/follows/${encodeURIComponent(started.id)}`)).json()) as { state: string }).state).toBe('done'));
    await post(base, '/api/clips/yard/follows', { frame: 3, things: [things[0]!.id] });
    expect(charged).toEqual(['look', 'look', 'track']);

    reached = 'You have reached today’s limit.';
    const refused = await post(base, '/api/clips/yard/frames/4/things', {});
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe(reached);
    expect((await post(base, '/api/clips/yard/frames/3/things', {})).status).toBe(200);
  });

  it('follows from the box outlined on the frame, and refuses an outline that is not there', async () => {
    const { base, followCalls } = await start({ clip: true });
    const { things } = (await (await post(base, '/api/clips/yard/frames/3/things', {})).json()) as { things: Array<{ id: string }> };
    expect((await post(base, '/api/clips/yard/follows', { frame: 4, things: [things[0]!.id] })).status).toBe(400);

    const started = await post(base, '/api/clips/yard/follows', { frame: 3, things: [things[0]!.id] });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    let job: any;
    for (let i = 0; i < 50 && job?.state !== 'done'; i++) {
      job = await (await fetch(`${base}/api/clips/yard/follows/${encodeURIComponent(id)}`)).json();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job).toMatchObject({ state: 'done', framesTotal: 20, follows: [{ name: 'car', spans: [{ from: 3, to: 3 }] }] });
    expect(followCalls.tracks).toEqual([{ frame: 3, targets: [{ box: { left: 5, top: 5, right: 20, bottom: 20 } }] }]);
    expect(((await (await fetch(`${base}/api/clips/yard/follows`)).json()) as unknown[]).length).toBe(1);
  });

  it('follows the things selected, not another on the same frame, and charges one track for the request', async () => {
    const charged: string[] = [];
    const { base, followCalls } = await start({ clip: true, spend: async (_req, _res, kind) => (charged.push(kind), null) });
    await post(base, '/api/clips/yard/frames/3/things', {});
    const { things } = (await (await post(base, '/api/clips/yard/frames/3/things', { word: 'bag' })).json()) as { things: Array<{ id: string; name: string }> };
    await post(base, '/api/clips/yard/frames/3/things', { box: { left: 22, top: 22, right: 38, bottom: 34 } });
    const bag = things.find((t) => t.name === 'bag')!;
    const car = things.find((t) => t.name === 'car')!;
    charged.length = 0;
    expect((await post(base, '/api/clips/yard/follows', { frame: 3, things: ['no-such'] })).status).toBe(400);
    expect((await post(base, '/api/clips/yard/follows', { frame: 3, things: [] })).status).toBe(400);
    expect((await post(base, '/api/clips/yard/follows', { frame: 3, things: [bag.id, car.id] })).status).toBe(202);
    expect(charged).toEqual(['track']);
    await new Promise((r) => setTimeout(r, 20));
    expect(followCalls.tracks).toEqual([{ frame: 3, targets: [{ box: { left: 40, top: 5, right: 60, bottom: 30 } }, { box: { left: 5, top: 5, right: 20, bottom: 20 } }] }]);
  });

  it('searches for an item by its names, charges each look, and reports which outlines are the item', async () => {
    const charged: string[] = [];
    const { base } = await start({ clip: true, spend: async (_req, _res, kind) => (charged.push(kind), null) });
    const found = (await (await post(base, '/api/clips/yard/frames/3/search', { item: 'bag', words: ['bag', 'backpack'] })).json()) as { frame: number; found: string[]; things: Array<{ id: string; name: string }> };
    expect(found.frame).toBe(3);
    expect(charged).toEqual(['look']);
    expect(found.things.filter((t) => found.found.includes(t.id)).map((t) => t.name)).toEqual(['bag']);
    expect((await post(base, '/api/clips/yard/frames/3/search', { item: '', words: [] })).status).toBe(400);
    expect((await post(base, '/api/clips/yard/frames/999/search', { item: 'bag', words: ['bag'] })).status).toBe(404);
  });

  it('says so when no look finds the item', async () => {
    const { base } = await start({ clip: true });
    const found = (await (await post(base, '/api/clips/yard/frames/3/search', { item: 'nothing', words: ['nothing'] })).json()) as { found: string[] };
    expect(found.found).toEqual([]);
  });

  it('refuses more items at once than one request can track', async () => {
    const { base } = await start({ clip: true });
    const { things } = (await (await post(base, '/api/clips/yard/frames/3/things', {})).json()) as { things: Array<{ id: string }> };
    const refused = await post(base, '/api/clips/yard/follows', { frame: 3, things: Array(5).fill(things[0]!.id) });
    expect(refused.status).toBe(400);
  });
});
