import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { BackendError } from '../backend/client.js';
import type { CameraFolder } from '../cameras/camera-folder.js';
import type { Clip, ClipFolder } from '../follow/clips.js';
import { planRule, type GuidePlanner } from '../guide/plan.js';
import type { BotChat } from '../telegram/api.js';
import { sendDemoAlert } from '../telegram/demo-alert.js';
import type { TelegramLinks } from '../telegram/links.js';
import { voiceKeywords, type VoiceNotes } from '../voice/voice-note.js';
import type { DemoEngine } from './engine.js';
import type { DemoLimits, Spending } from './limits.js';
import { placedBox, ruleFromPlan, zonePaths } from './rule-plan.js';
import type { DemoRule, DemoStore } from './store.js';

export const NEEDS_KEYS = 'Provide your keys for the full experience. The README says which to add. The clips and their alerts work without them.';
export const NEEDS_BACKEND = 'Reading a new rule needs Streamatic’s backend, which this copy is not connected to. It works on the hosted page, whose address is in the README.';

// What each kind of request is counted as against the day's ceiling, a little above what was measured, so the ceiling errs early.
export const COST_MICRO_USD: Record<Spending, number> = { rule: 100_000, plan: 20_000, look: 20_000, track: 150_000, upload: 80_000, send: 0 };
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
const telegramAlert = z.object({ rule: z.string().max(64), key: z.string().max(200) });
const telegramChoice = z.object({ clip: z.string().max(200), language: z.enum(['english', 'pidgin', 'yoruba']) });

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
  voiceNotes,
  folder,
  trackSeconds,
  abilities = { models: true, rules: true },
  telegram = null,
}: {
  engine: DemoEngine;
  store: DemoStore;
  limits: DemoLimits;
  clips: Pick<ClipFolder, 'get'>;
  cameras: Pick<CameraFolder, 'get'>;
  guidePlanner: GuidePlanner;
  setUp: (bytes: Uint8Array) => Promise<unknown>;
  voiceNotes: Pick<VoiceNotes, 'read'>;
  folder: string;
  trackSeconds: number;
  // What this copy can spend on; a judge's own copy may have neither, and the recorded clips need neither.
  abilities?: { models: boolean; rules: boolean };
  // Present when this copy has a bot of its own to send alerts with.
  telegram?: { links: TelegramLinks; botName: string; chat: Pick<BotChat, 'sendText' | 'sendPicture'> } | null;
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

  const planned = async (clip: string, plan: Parameters<typeof ruleFromPlan>[0]) => {
    const camera = await cameras.get(clip);
    const size = await clips.get(clip);
    if (!camera || !size) throw new Refusal(404, 'No such clip.');
    const made = ruleFromPlan(plan, camera.zones, size);
    if (!made) throw new Refusal(400, 'That plan does not fit this clip. Please plan the rule again.');
    return made;
  };
  const needsBot = () => {
    if (!telegram) throw new Refusal(409, NEEDS_KEYS);
    return telegram;
  };

  async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = request.method;
    let match: RegExpExecArray | null;

    if (method === 'GET' && path === '/api/app') {
      send(response, 200, { public: true, trackSeconds, ...abilities, telegram: telegram !== null });
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
    if (method === 'GET' && (match = /^\/api\/demo\/clips\/([^/]+)\/setup$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      clipRow(id);
      const setup = (await cameras.get(id))?.setup;
      if (!setup) throw new Refusal(404, 'This clip has not been set up.');
      send(response, 200, {
        picture: `/demo-still/${encodeURIComponent(id)}`,
        zones: setup.zones.map((z) => ({ name: z.name, item: z.item, paths: zonePaths(z) })),
        rules: setup.rules.map((r) => r.sentence),
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
      if (!parsed.success) throw new Refusal(400, 'Please describe the rule in a sentence.');
      if (!abilities.models) throw new Refusal(409, NEEDS_KEYS);
      const camera = await cameras.get(id);
      if (!camera) throw new Refusal(404, 'No such clip.');
      await charge(visitorOf(request, response), 'plan');
      const result = await planRule({ sentence: parsed.data.sentence, site: camera.site, zones: camera.zones, planner: guidePlanner });
      send(response, 200, result.status === 'ready' ? { ...result, plan: placedBox(result.plan, camera.zones) } : result);
      return true;
    }
    if (method === 'POST' && (match = /^\/api\/demo\/clips\/([^/]+)\/voice-notes$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      clipRow(id);
      if (!abilities.models) throw new Refusal(409, NEEDS_KEYS);
      const camera = await cameras.get(id);
      const visitor = visitorOf(request, response);
      const { status, body } = await voiceNotes.read(request, voiceKeywords(camera?.zones ?? []), () => charge(visitor, 'plan'));
      send(response, status, body);
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
    if (method === 'DELETE' && (match = /^\/api\/demo\/clips\/([^/]+)\/rules\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      clipRow(id);
      const rule = store.rule(decodeURIComponent(match[2]!));
      if (!rule || rule.clip !== id || rule.kind !== 'typed' || rule.visitor !== visitorOf(request, response)) throw new Refusal(404, 'No such rule.');
      store.removeRule(rule.id);
      send(response, 200, { removed: true });
      return true;
    }
    if (method === 'GET' && (match = /^\/api\/demo\/clips\/([^/]+)\/rules\/([^/]+)$/.exec(path))) {
      const row = clipRow(decodeURIComponent(match[1]!));
      const rule = await engine.typed(row, visitorOf(request, response), decodeURIComponent(match[2]!));
      if (!rule) throw new Refusal(404, 'No such rule.');
      send(response, 200, viewOf(rule));
      return true;
    }
    if (path === '/api/demo/telegram') {
      const { links, botName } = needsBot();
      const visitor = visitorOf(request, response);
      if (method === 'GET') {
        const clip = url.searchParams.get('clip') ?? '';
        clipRow(clip);
        const linked = links.ofVisitor(visitor) !== null;
        send(response, 200, { linked, link: linked ? null : `https://t.me/${botName}?start=${links.token(visitor, clip)}` });
        return true;
      }
      if (method === 'PUT') {
        const parsed = telegramChoice.safeParse(await readJson(request));
        if (!parsed.success) throw new Refusal(400, 'The request is not valid.');
        clipRow(parsed.data.clip);
        links.choose(visitor, parsed.data.clip, parsed.data.language);
        send(response, 200, { linked: links.ofVisitor(visitor) !== null });
        return true;
      }
      if (method === 'DELETE') {
        links.unlink(visitor);
        send(response, 200, { linked: false });
        return true;
      }
    }
    if (method === 'POST' && (match = /^\/api\/demo\/clips\/([^/]+)\/telegram-alerts$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      clipRow(id);
      const { links, chat } = needsBot();
      const parsed = telegramAlert.safeParse(await readJson(request));
      if (!parsed.success) throw new Refusal(400, 'The request is not valid.');
      const visitor = visitorOf(request, response);
      const link = links.ofVisitor(visitor);
      if (!link) throw new Refusal(409, 'This page is not linked to Telegram.');
      const rule = store.rules(id, visitor).find((r) => r.id === parsed.data.rule);
      const alert = rule ? store.alert(rule.id, parsed.data.key) : null;
      const clip = await clips.get(id);
      if (!rule || !alert || !clip) throw new Refusal(404, 'No such alert.');
      await charge(visitor, 'send');
      await sendDemoAlert({ chat, to: link.person, folder, clip, rule, alert, language: link.language });
      send(response, 200, { sent: true });
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
    if (method === 'GET' && (match = /^\/demo-still\/([^/]+)$/.exec(path))) {
      const clip = decodeURIComponent(match[1]!);
      const bytes = basename(clip) === clip ? await readFile(join(folder, 'cameras', clip, 'still.jpg')).catch(() => null) : null;
      if (!bytes) throw new Refusal(404, 'Not found.');
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(bytes);
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
