import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import type { Camera, CameraFolder } from '../cameras/camera-folder.js';
import type { EventStore } from '../events/store.js';
import { answerQuestion, type QuestionPlanner } from '../questions/answer.js';
import type { NewRule, RuleStore } from '../rules/rule-store.js';
import type { Zone } from '../rules/zone-rule.js';
import type { CameraSetup, LabelledPicture } from '../setup/camera-setup.js';

const MEDIA_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4' };
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const MAX_BODY_BYTES = 4_000;

const hour = z.number().int().min(0).max(23);
const text = (max: number) => z.string().trim().min(1).max(max);
const box = z
  .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
  .refine((b) => b.right > b.left && b.bottom > b.top);
const ruleInput = z.object({
  camera: text(80),
  sentence: text(300),
  // An outline zone names one of setup's outlines; its box and path are read from setup.json, never taken from the request.
  zone: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('outline'), name: text(60), word: text(60), label: text(30), objectId: text(10) }),
    z.object({ kind: z.literal('box'), name: text(60), box, question: text(300) }),
  ]),
  activeHours: z.object({ from: hour, to: hour }).nullable(),
});

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function appHandler({
  events,
  rules,
  cameras,
  setUp,
  mediaDir,
  webDir,
  planner,
  timeZone,
  now = Date.now,
}: {
  events: EventStore;
  rules: RuleStore;
  cameras: CameraFolder;
  setUp: (camera: Camera, pictures: LabelledPicture[]) => Promise<CameraSetup>;
  mediaDir: string;
  webDir: string;
  planner: QuestionPlanner;
  timeZone: string;
  now?: () => number;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const settingUp = new Set<string>();

  return (request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      if (error instanceof RequestError) return send(response, error.status, { error: error.message });
      console.error(error);
      send(response, 502, { error: 'The request could not be completed. Please try again.' });
    });
  };

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method;
    let match: RegExpExecArray | null;

    if (method === 'GET' && path.startsWith('/assets/')) {
      const name = decodeURIComponent(path.slice('/assets/'.length));
      const type = ASSET_TYPES[extname(name).toLowerCase()];
      const bytes = type && basename(name) === name ? await readFile(join(webDir, 'assets', name)).catch(() => null) : null;
      if (!type || !bytes) return send(response, 404, { error: 'Not found.' });
      response.writeHead(200, { 'Content-Type': type });
      response.end(bytes);
      return;
    }
    if (method === 'GET' && path === '/api/events') return send(response, 200, events.list({}));
    if (method === 'GET' && (match = /^\/api\/events\/(\d+)\/frames$/.exec(path))) {
      return send(response, 200, events.frames(Number(match[1])));
    }
    if (method === 'GET' && (match = /^\/api\/events\/(\d+)$/.exec(path))) {
      const event = events.get(Number(match[1]));
      return event ? send(response, 200, event) : send(response, 404, { error: 'No such event.' });
    }
    if (method === 'GET' && path.startsWith('/media/')) {
      const name = decodeURIComponent(path.slice('/media/'.length));
      const bytes = basename(name) === name ? await readFile(join(mediaDir, name)).catch(() => null) : null;
      return sendFile(response, name, bytes);
    }
    if (method === 'POST' && path === '/api/questions') {
      const question = String((await readJson(request)).question ?? '').trim();
      if (!question) return send(response, 400, { error: 'Type a question.' });
      const answer = await answerQuestion({ question, store: events, planner, now: now(), timeZone });
      return send(response, 200, { text: answer.text, count: answer.count, eventIds: answer.events.map((e) => e.id), plan: answer.plan });
    }

    if (method === 'GET' && path === '/api/cameras') return send(response, 200, await cameras.list());
    if (method === 'GET' && (match = /^\/camera-pictures\/([^/]+)\/([^/]+)$/.exec(path))) {
      const file = decodeURIComponent(match[2]!);
      return sendFile(response, file, await cameras.picture(decodeURIComponent(match[1]!), file));
    }
    if (method === 'POST' && (match = /^\/api\/cameras\/([^/]+)\/setup$/.exec(path))) {
      return send(response, 200, await runSetup(decodeURIComponent(match[1]!)));
    }

    if (method === 'GET' && path === '/api/rules') return send(response, 200, rules.list(url.searchParams.get('camera') ?? undefined));
    if (method === 'POST' && path === '/api/rules') {
      const parsed = ruleInput.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, 'The rule needs a sentence, a zone with a name and, for a drawn box, a question.');
      const rule = await resolveRule(parsed.data);
      return send(response, 201, rules.get(rules.add(rule)));
    }
    if (method === 'DELETE' && (match = /^\/api\/rules\/(\d+)$/.exec(path))) {
      return rules.remove(Number(match[1])) ? send(response, 200, { removed: true }) : send(response, 404, { error: 'No such rule.' });
    }
    if (method === 'GET' && !path.startsWith('/api/')) {
      // The app routes its own pages in the browser, so every page path gets the same document.
      const page = await readFile(join(webDir, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    send(response, 404, { error: 'Not found.' });
  }

  async function runSetup(id: string): Promise<CameraSetup> {
    const camera = await cameras.get(id);
    if (!camera) throw new RequestError(404, 'No such camera.');
    // Setup spends dozens of SAM calls, so a second press while one runs is refused rather than paid for twice.
    if (settingUp.has(id)) throw new RequestError(409, 'Setup is already running on this camera.');
    settingUp.add(id);
    try {
      const setup = await setUp(camera, await cameras.labelledPictures(camera));
      await cameras.saveSetup(id, setup);
      return setup;
    } finally {
      settingUp.delete(id);
    }
  }

  async function resolveRule(input: z.infer<typeof ruleInput>): Promise<NewRule> {
    const camera = await cameras.get(input.camera);
    if (!camera) throw new RequestError(400, 'No such camera.');
    const base = { camera: camera.id, sentence: input.sentence, activeHours: input.activeHours };
    if (input.zone.kind === 'box') {
      const zone: Zone = { name: input.zone.name, kind: 'box', box: input.zone.box };
      return { ...base, zone, question: input.zone.question };
    }
    const { name, word, label, objectId } = input.zone;
    const outline = camera.setup?.zones.find((z) => z.name === word)?.outlines[label]?.find((o) => o.objectId === objectId);
    if (!outline) throw new RequestError(400, 'That outline is not in this camera’s setup. Run setup again and choose an outline.');
    return { ...base, zone: { name, kind: 'outline', word, reference: outline.box, path: outline.path }, question: null };
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendFile(response: ServerResponse, name: string, bytes: Uint8Array | null): void {
  const type = MEDIA_TYPES[extname(name).toLowerCase()];
  if (!type || !bytes) return send(response, 404, { error: 'Not found.' });
  response.writeHead(200, { 'Content-Type': type });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new RequestError(413, 'The request is too large.');
  }
  try {
    const parsed: unknown = JSON.parse(body || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new RequestError(400, 'The request is not valid JSON.');
  }
}
