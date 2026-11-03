import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { BackendError } from '../backend/client.js';
import { sentenceWithPlaces } from '../backend/place.js';
import type { CameraFolder } from '../cameras/camera-folder.js';
import type { CameraZone } from '../cameras/camera-zones.js';
import type { Clip, ClipFolder } from '../follow/clips.js';
import { checkPlan, planRule, type GuidePlan, type GuidePlanner } from '../guide/plan.js';
import type { Box } from '../sam/outlines.js';
import type { DemoEngine } from './engine.js';
import type { DemoLimits, Spending } from './limits.js';
import type { DemoRule, DemoStore, RuleZone } from './store.js';

export const NEEDS_KEYS = 'This copy of the page has no model keys, so this is not available here. The clips and their alerts still work. The README says which keys to add.';
const NEEDS_BACKEND = 'Reading a new rule needs Streamatic’s backend, which this copy is not connected to. It works on the hosted page, whose address is in the README.';

// What each kind of request is counted as against the day's ceiling, a little above what was measured, so the ceiling errs early.
export const COST_MICRO_USD: Record<Spending, number> = { rule: 100_000, plan: 20_000, look: 20_000, track: 150_000, upload: 80_000 };
const MAX_UPLOAD_BYTES = 8_000_000;
const MAX_JSON_BYTES = 4_000;
const VISITOR_COOKIE = 'streamatic_demo';
const PICTURE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// The size setup's pictures are sent at; the browser is sent the same picture, so the outlines fit it.
const UPLOAD_WIDTH = 1280;

const sentence = z.string().trim().min(3).max(300);
const hour = z.number().int().min(0).max(23);
const planShape = z.object({
  sentence,
  about: z.string().max(300),
  zones: z.array(z.string().max(60)).max(4),
  box: z.object({ name: z.string().max(60), question: z.string().max(300), over: z.string().max(60).nullable() }).nullable(),
  hours: z.object({ from: hour, to: hour }).nullable(),
});
const newRule = z.union([z.object({ text: sentence }), z.object({ plan: planShape })]);
const ticked = z.object({ ticks: z.array(z.object({ rule: z.string().max(64), armedMs: z.number().min(0) })).max(10) });
const planAsked = z.object({ sentence });

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

export function visitorOf(request: IncomingMessage, response: ServerResponse): string {
  const given = new RegExp(`(?:^|; )${VISITOR_COOKIE}=([^;]+)`).exec(request.headers.cookie ?? '')?.[1];
  if (given && /^[\w-]{1,64}$/.test(given)) return given;
  const id = randomUUID();
  response.setHeader('Set-Cookie', `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return id;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Refusal(413, 'That file is too large. Please choose one under 8 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString('utf8') || '{}');
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(400, 'The request is not valid.');
  }
}

const boxPath = ({ left, top, right, bottom }: Box) => `M${left} ${top}H${right}V${bottom}H${left}Z`;
const zonePaths = (zone: CameraZone) => Object.values(zone.outlines).flat().map((o) => o.path);
const zoneBoxOf = (zone: CameraZone): Box => Object.values(zone.outlines).flat()[0]!.box;

// On a clip nobody can draw, so a box the plan left unplaced goes over the one zone its sentence names, if it names one.
function placedBox(plan: GuidePlan, zones: CameraZone[]): GuidePlan {
  if (!plan.box || plan.box.over !== null) return plan;
  const said = new Set(plan.sentence.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const named = zones.filter((z) => z.word.toLowerCase().split(/\s+/).every((w) => said.has(w)));
  // Two zones under one word could be either, and a wrong place in the sentence is worse than none.
  return named.length === 1 ? { ...plan, box: { ...plan.box, over: named[0]!.name } } : plan;
}

const viewOf = ({ id, kind, text, name, readsAs, status, progress, rewrites, reason, canAnswer, zones }: DemoRule) => ({ id, kind, text, name, readsAs, status, progress, rewrites, reason, canAnswer, zones });

// The public page's routes over the demo engine. Spending is limited here, the login stays on this server, and no signed
// address reaches a browser: videos, frames and evidence are all files of this server's.
export function demoHandler({
  engine,
  store,
  limits,
  clips,
  cameras,
  guidePlanner,
  setUp,
  folder,
  trackSeconds,
  abilities = { models: true, rules: true },
}: {
  engine: DemoEngine;
  store: DemoStore;
  limits: DemoLimits;
  clips: Pick<ClipFolder, 'get'>;
  cameras: Pick<CameraFolder, 'get'>;
  guidePlanner: GuidePlanner;
  setUp: (bytes: Uint8Array) => Promise<unknown>;
  folder: string;
  trackSeconds: number;
  // What this copy can spend on; a judge's own copy may have neither, and the recorded clips need neither.
  abilities?: { models: boolean; rules: boolean };
}): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  const charge = async (visitor: string, kind: Spending) => {
    const reached = await limits.charge(visitor, kind, COST_MICRO_USD[kind]);
    if (reached) throw new Refusal(429, reached);
  };
  const clipRow = (id: string) => {
    const row = store.clip(id);
    if (!row) throw new Refusal(404, 'No such clip.');
    return row;
  };
  const withVideo = async (id: string): Promise<Omit<Clip, 'video'>> => {
    const clip = await clips.get(id);
    if (!clip) throw new Refusal(404, 'No such clip.');
    const { video: _file, ...shown } = clip;
    return shown;
  };

  // What a planned rule sends: each zone's place is written into the sentence, and its outlines go to the player.
  const planned = async (clip: string, plan: GuidePlan) => {
    const camera = await cameras.get(clip);
    const size = await clips.get(clip);
    if (!camera || !size) throw new Refusal(404, 'No such clip.');
    const { passed } = checkPlan(plan, camera.zones, plan.about);
    if (!passed) throw new Refusal(400, 'That plan does not fit this clip. Please plan the rule again.');
    const named = (name: string) => camera.zones.find((z) => z.name.toLowerCase() === name.trim().toLowerCase())!;
    const zones = plan.zones.map(named);
    const over = plan.box?.over ? named(plan.box.over) : null;
    const places = [...zones, ...(over && !zones.includes(over) ? [over] : [])].map((z) => ({ name: z.name, box: zoneBoxOf(z) }));
    const shown: RuleZone[] = [
      ...zones.map((z) => ({ name: z.name, paths: zonePaths(z) })),
      ...(plan.box && over ? [{ name: plan.box.name, paths: [boxPath(zoneBoxOf(over))] }] : []),
    ];
    const asked = [plan.sentence, ...(plan.box ? [plan.box.question] : [])].join(' ');
    return { sent: sentenceWithPlaces(asked, places, { width: size.width, height: size.height }), zones: shown };
  };

  async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = request.method;
    let match: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/app') {
      send(response, 200, { public: true, trackSeconds, ...abilities });
      return true;
    }
    if (method === 'GET' && path === '/api/demo/clips') {
      const shown = await Promise.all(
        store.clips().map(async (row) => ({ ...(await withVideo(row.id)), description: row.description, rules: store.rules(row.id, '').length, alerts: store.alertCount(row.id) })),
      );
      send(response, 200, shown);
      return true;
    }
    if (method === 'GET' && (match = /^\/api\/demo\/clips\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      const row = clipRow(id);
      const camera = await cameras.get(id);
      send(response, 200, {
        id,
        description: row.description,
        startsAt: row.startsAt,
        lengthMs: row.lengthMs,
        zones: (camera?.zones ?? []).map((z) => ({ name: z.name, paths: zonePaths(z) })),
        suggestions: (camera?.setup?.rules ?? []).map((r) => r.sentence),
        rules: store.rules(id, visitorOf(request, response)).map(viewOf),
      });
      return true;
    }
    if (method === 'POST' && (match = /^\/api\/demo\/clips\/([^/]+)\/alerts$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      clipRow(id);
      const parsed = ticked.safeParse(await readJson(request));
      if (!parsed.success) throw new Refusal(400, 'The request is not valid.');
      const alerts = engine.alerts(id, visitorOf(request, response), parsed.data.ticks);
      send(response, 200, { alerts: alerts.map(({ picture, ...a }) => ({ ...a, picture: picture ? `/demo-evidence/${encodeURIComponent(id)}/${encodeURIComponent(picture)}` : null })) });
      return true;
    }
    if (method === 'POST' && (match = /^\/api\/demo\/clips\/([^/]+)\/plans$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      clipRow(id);
      const parsed = planAsked.safeParse(await readJson(request));
      if (!parsed.success) throw new Refusal(400, 'Write what to watch in a sentence.');
      if (!abilities.models) throw new Refusal(409, NEEDS_KEYS);
      const camera = await cameras.get(id);
      if (!camera) throw new Refusal(404, 'No such clip.');
      await charge(visitorOf(request, response), 'plan');
      const result = await planRule({ sentence: parsed.data.sentence, site: camera.site, zones: camera.zones, planner: guidePlanner });
      send(response, 200, result.status === 'ready' ? { ...result, plan: placedBox(result.plan, camera.zones) } : result);
      return true;
    }
    if (method === 'POST' && (match = /^\/api\/demo\/clips\/([^/]+)\/rules$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      const row = clipRow(id);
      const parsed = newRule.safeParse(await readJson(request));
      if (!parsed.success) throw new Refusal(400, 'Write the rule in a sentence.');
      if (!abilities.rules) throw new Refusal(409, NEEDS_BACKEND);
      const { text, sent, zones } = 'text' in parsed.data
        ? { text: parsed.data.text, sent: parsed.data.text, zones: [] }
        : { text: parsed.data.plan.sentence, ...(await planned(id, parsed.data.plan)) };
      const visitor = visitorOf(request, response);
      await charge(visitor, 'rule');
      send(response, 202, { id: await engine.type(row, visitor, text, sent, zones) });
      return true;
    }
    if (method === 'GET' && (match = /^\/api\/demo\/clips\/([^/]+)\/rules\/([^/]+)$/.exec(path))) {
      const row = clipRow(decodeURIComponent(match[1]!));
      const rule = await engine.typed(row, visitorOf(request, response), decodeURIComponent(match[2]!));
      if (!rule) throw new Refusal(404, 'No such rule.');
      send(response, 200, viewOf(rule));
      return true;
    }
    if (method === 'POST' && path === '/api/demo/uploads') {
      const type = String(request.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!PICTURE_TYPES.has(type)) throw new Refusal(400, 'Please choose a JPEG, PNG or WebP picture.');
      if (!abilities.models) throw new Refusal(409, NEEDS_KEYS);
      const given = await readBody(request, MAX_UPLOAD_BYTES);
      const { data, info } = await sharp(given)
        .rotate()
        .resize({ width: UPLOAD_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer({ resolveWithObject: true })
        .catch(() => {
          throw new Refusal(400, 'That file could not be read as a picture. Please choose a JPEG, PNG or WebP picture.');
        });
      await charge(visitorOf(request, response), 'upload');
      const setup = await setUp(new Uint8Array(data));
      send(response, 200, { picture: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height, setup });
      return true;
    }
    if (method === 'GET' && (match = /^\/demo-evidence\/([^/]+)\/([^/]+)$/.exec(path))) {
      const clip = decodeURIComponent(match[1]!);
      const file = decodeURIComponent(match[2]!);
      const bytes = basename(clip) === clip && basename(file) === file ? await readFile(join(folder, 'clips', clip, 'evidence', file)).catch(() => null) : null;
      if (!bytes) throw new Refusal(404, 'Not found.');
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(bytes);
      return true;
    }
    return false;
  }

  return async (request, response, url) => {
    try {
      return await route(request, response, url);
    } catch (error) {
      if (error instanceof Refusal) send(response, error.status, { error: error.message });
      else if (error instanceof BackendError && error.status < 500) send(response, error.status, { error: error.message });
      else {
        console.error(error);
        send(response, 502, { error: 'The request could not be completed. Please try again.' });
      }
      return true;
    }
  };
}

// In the public mode a visitor reaches the demo, the clips and the pages, and none of the app's cameras, events or rules.
const OPEN_TO_ALL = /^\/(assets\/|api\/clips(\/|$)|clip-videos\/|clip-pictures\/)/;
const CLOSED_TO_ALL = /^\/(api|media|camera-pictures)(\/|$)/;

export function publicOnly({
  app,
  demo,
}: {
  app: (request: IncomingMessage, response: ServerResponse) => void;
  demo: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (await demo(request, response, url)) return;
    if (OPEN_TO_ALL.test(url.pathname) || (request.method === 'GET' && !CLOSED_TO_ALL.test(url.pathname))) return app(request, response);
    send(response, 404, { error: 'Not found.' });
  };
}
