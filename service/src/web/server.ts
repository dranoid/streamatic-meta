import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { BackendError, type RuleBackend, type RuleDraft, type StoredAsk } from '../backend/client.js';
import { sentenceWithPlaces } from '../backend/place.js';
import type { Camera, CameraFolder } from '../cameras/camera-folder.js';
import type { Trials } from '../backend/trials.js';
import { nightCoverage, zoneAt, type CameraZone } from '../cameras/camera-zones.js';
import { camerasThatOutlined } from '../guide/route.js';
import { captionLanguages, type CaptionLanguage, type WriteCaption } from '../spark/alert-caption.js';
import { voiceKeywords, type VoiceNotes } from '../voice/voice-note.js';
import { keepStretch } from '../events/copy-alert.js';
import type { EventStore } from '../events/store.js';
import type { ClipFolder } from '../follow/clips.js';
import type { Follows } from '../follow/follows.js';
import type { ClipThings } from '../follow/things.js';
import { planRule, type GuidePlanner } from '../guide/plan.js';
import { answerQuestion, type QuestionPlanner } from '../questions/answer.js';
import { zoneBox, type RuleStore, type SavedRule, type Zone } from '../rules/rule-store.js';
import type { MediaSize, Picture } from '../sam/client.js';
import { boxOverlap, type Box, type Outline } from '../sam/outlines.js';
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
const MAX_ZONES_PER_RULE = 4;
const CLICKED_NAME = 'selected item';

const hour = z.number().int().min(0).max(23);
const text = (max: number) => z.string().trim().min(1).max(max);
const box = z
  .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
  .refine((b) => b.right > b.left && b.bottom > b.top);
const ruleInput = z.object({
  camera: text(80),
  sentence: text(300),
  // An outline zone names one of setup's outlines; its name, box and path are read from the camera, never taken from the request.
  zones: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('outline'), word: text(60), label: text(30), objectId: text(10) }),
        z.object({ kind: z.literal('box'), name: text(60), box, question: text(300) }),
      ]),
    )
    .min(1)
    .max(MAX_ZONES_PER_RULE),
  activeHours: z.object({ from: hour, to: hour }).nullable(),
});
const savedDraftInput = z.object({ draft: text(40), guidePlan: z.unknown().optional() });
const trialInput = z.object({ draft: text(40), confirmedCostMicroUsd: z.number().int().min(0).nullable() });
const guideInput = z.object({ camera: text(80), sentence: text(300) });
const zoneNameInput = z.object({ word: text(60), label: text(30), objectId: text(10), name: text(60) });
const thingsInput = z.union([
  z.object({ word: text(60) }),
  z.object({ point: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }) }),
  z.object({}),
]);
const captionAsked = z.object({ language: z.enum(captionLanguages as [CaptionLanguage, ...CaptionLanguage[]]) });
const followInput = z.object({ frame: z.number().int().min(0), thing: text(10) });

// A draft waits here for the person's yes, so what is saved is exactly what they were shown.
interface HeldDraft {
  camera: Camera;
  sentence: string;
  request: string;
  zones: Zone[];
  activeHours: { from: number; to: number } | null;
  draft: RuleDraft;
  trial: string | null;
}

const KEPT_DRAFTS = 200;

function settledBy(draft: RuleDraft): StoredAsk['settledBy'] {
  const condition = draft.condition ?? {};
  if (condition.framesPerAnswer !== 'several') return 'one-picture';
  return condition.sampleGapSeconds === 3 ? 'brief-change' : 'change';
}

// The person's own hours replace any the parse read from the sentence.
function withHours(draft: RuleDraft, hours: { from: number; to: number } | null): RuleDraft {
  if (!hours) return draft;
  const clock = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return { ...draft, schedule: { type: 'time_windows', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startTime: clock(hours.from), endTime: clock(hours.to) }] } };
}

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
  guidePlanner,
  voiceNotes,
  writeCaption,
  backend,
  trials,
  pictureSize,
  following,
  timeZone,
  now = Date.now,
  playing = () => null,
  spend = async () => null,
}: {
  events: EventStore;
  rules: RuleStore;
  cameras: CameraFolder;
  setUp: (camera: Camera, pictures: LabelledPicture[]) => Promise<CameraSetup>;
  mediaDir: string;
  webDir: string;
  planner: QuestionPlanner;
  guidePlanner: GuidePlanner;
  voiceNotes: Pick<VoiceNotes, 'read'>;
  writeCaption: WriteCaption;
  // Rules live in the backend, which answers them; null when the app runs without one.
  backend: RuleBackend | null;
  trials: Trials;
  pictureSize: (camera: Camera) => Promise<MediaSize>;
  following: {
    clips: ClipFolder;
    things: ClipThings;
    follows: Follows;
    listThings: (picture: Picture) => Promise<string[]>;
    nameThing: (picture: Picture, box: Box) => Promise<string>;
    outlineAll: (picture: Picture, words: string[]) => Promise<Record<string, Outline[]>>;
    outlineAt: (picture: Picture, size: MediaSize, point: { x: number; y: number }, name: string) => Promise<Outline | null>;
  };
  timeZone: string;
  now?: () => number;
  // For a camera playing its recording on a loop, the picture playing and its recorded time (null before the first).
  playing?: (camera: string) => { at: number | null; picture: Uint8Array | null } | null;
  // Asked before a Track route spends anything new; a message means it may not, and the person is told so.
  spend?: (request: IncomingMessage, response: ServerResponse, kind: 'look' | 'track') => Promise<string | null>;
}): (request: IncomingMessage, response: ServerResponse) => void {
  const settingUp = new Set<string>();
  const drafts = new Map<string, HeldDraft>();
  // Naming a frame spends a list and an outline per word, so it is done once for each frame, even if asked twice at once.
  const naming = new Map<string, Promise<void>>();

  return (request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return;
      if (error instanceof RequestError) return send(response, error.status, { error: error.message });
      if (error instanceof BackendError && error.status < 500) return send(response, error.status, { error: error.message });
      console.error(error);
      send(response, 502, { error: 'The request could not be completed. Please try again.' });
    });
  };

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method;
    let match: RegExpExecArray | null;
    const charge = async (kind: 'look' | 'track') => {
      const reached = await spend(request, response, kind);
      if (reached) throw new RequestError(429, reached);
    };

    if (method === 'GET' && path === '/api/app') return send(response, 200, { public: false, trackSeconds: null });
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
    if (method === 'POST' && (match = /^\/api\/events\/(\d+)\/captions$/.exec(path))) {
      const parsed = captionAsked.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, 'Choose a language for the caption.');
      const event = events.get(Number(match[1]));
      if (!event) return send(response, 404, { error: 'No such event.' });
      const { language } = parsed.data;
      const kept = events.caption(event.rule, language);
      if (kept !== null) return send(response, 200, { language, text: kept });
      const text = await writeCaption(event.rule, language);
      events.saveCaption(event.rule, language, text);
      return send(response, 200, { language, text });
    }
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

    if (method === 'GET' && path === '/api/cameras') return send(response, 200, await Promise.all((await cameras.list()).map(withRules)));
    if (method === 'GET' && (match = /^\/camera-pictures\/([^/]+)\/([^/]+)$/.exec(path))) {
      const file = decodeURIComponent(match[2]!);
      return sendFile(response, file, await cameras.picture(decodeURIComponent(match[1]!), file));
    }
    if (method === 'GET' && (match = /^\/api\/cameras\/([^/]+)\/now$/.exec(path))) {
      const picture = playing(decodeURIComponent(match[1]!))?.picture;
      if (!picture) return send(response, 404, { error: 'This camera is not playing a recording.' });
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      response.end(picture);
      return;
    }
    if (method === 'POST' && (match = /^\/api\/cameras\/([^/]+)\/setup$/.exec(path))) {
      return send(response, 200, await runSetup(decodeURIComponent(match[1]!)));
    }
    if (method === 'PATCH' && (match = /^\/api\/cameras\/([^/]+)\/zones$/.exec(path))) {
      const parsed = zoneNameInput.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, 'Choose a zone and type its new name.');
      return send(response, 200, await renameZone(decodeURIComponent(match[1]!), parsed.data));
    }

    if (method === 'GET' && path === '/api/clips') {
      return send(response, 200, (await following.clips.list()).map(({ video: _file, ...clip }) => clip));
    }
    if (method === 'GET' && (match = /^\/clip-videos\/([^/]+)$/.exec(path))) {
      const clip = await following.clips.get(decodeURIComponent(match[1]!));
      if (!clip) return send(response, 404, { error: 'No such clip.' });
      return sendVideo(request, response, clip.video);
    }
    if (method === 'GET' && (match = /^\/clip-pictures\/([^/]+)\/(\d+)$/.exec(path))) {
      const picture = await following.clips.picture(decodeURIComponent(match[1]!), Number(match[2]));
      if (!picture) return send(response, 404, { error: 'No such frame.' });
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(picture);
      return;
    }
    if ((match = /^\/api\/clips\/([^/]+)\/frames\/(\d+)\/things$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      const frame = Number(match[2]);
      if (method === 'GET') return send(response, 200, { things: await following.things.list(id, frame) });
      if (method === 'POST') return send(response, 200, await outlineOnFrame(id, frame, await readJson(request), charge));
    }
    if ((match = /^\/api\/clips\/([^/]+)\/follows$/.exec(path))) {
      const id = decodeURIComponent(match[1]!);
      if (method === 'GET') return send(response, 200, await following.follows.list(id));
      if (method === 'POST') return send(response, 202, { id: await startFollow(id, await readJson(request), charge) });
    }
    if (method === 'GET' && (match = /^\/api\/clips\/([^/]+)\/follows\/([^/]+)$/.exec(path))) {
      const job = await following.follows.get(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
      return job ? send(response, 200, job) : send(response, 404, { error: 'Nothing is being tracked under that name.' });
    }

    if (method === 'GET' && path === '/api/rules') return send(response, 200, rules.list(url.searchParams.get('camera') ?? undefined));
    if (method === 'POST' && path === '/api/rule-drafts') {
      const parsed = ruleInput.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, `The rule needs a sentence and 1 to ${MAX_ZONES_PER_RULE} zones; a drawn box needs a name and a question.`);
      return send(response, 200, await draftRule(parsed.data));
    }
    if (method === 'POST' && path === '/api/rules') {
      const parsed = savedDraftInput.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, 'Read the rule before saving it.');
      return send(response, 201, await saveRule(parsed.data.draft, parsed.data.guidePlan ?? null));
    }
    if (method === 'POST' && path === '/api/guide/plans') {
      const parsed = guideInput.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, 'Tell the guide what to watch.');
      const camera = await cameras.get(parsed.data.camera);
      if (!camera) throw new RequestError(404, 'No such camera.');
      const planned = await planRule({ sentence: parsed.data.sentence, site: camera.site, zones: camera.zones, planner: guidePlanner });
      return send(response, 200, { ...planned, elsewhere: camerasThatOutlined(parsed.data.sentence, camera, await cameras.list()) });
    }
    if (method === 'POST' && (match = /^\/api\/cameras\/([^/]+)\/voice-notes$/.exec(path))) {
      const camera = await cameras.get(decodeURIComponent(match[1]!));
      if (!camera) throw new RequestError(404, 'No such camera.');
      const { status, body } = await voiceNotes.read(request, voiceKeywords(camera.zones));
      return send(response, status, body);
    }
    if (method === 'GET' && (match = /^\/api\/rule-drafts\/([^/]+)\/trial-estimate$/.exec(path))) {
      const { held, ask } = askFor(decodeURIComponent(match[1]!));
      return send(response, 200, { ...(await connected().estimateQuestion(ask)), from: ask.from.getTime(), to: ask.to.getTime(), rule: held.sentence });
    }
    if (method === 'POST' && path === '/api/trials') {
      const parsed = trialInput.safeParse(await readJson(request));
      if (!parsed.success) throw new RequestError(400, 'Confirm the cost before trying the rule.');
      const { held, ask } = askFor(parsed.data.draft);
      held.trial = await trials.start(ask, held.sentence, parsed.data.confirmedCostMicroUsd);
      return send(response, 202, { id: held.trial });
    }
    if (method === 'GET' && (match = /^\/api\/trials\/([^/]+)$/.exec(path))) {
      return send(response, 200, await trials.view(decodeURIComponent(match[1]!)));
    }
    if (method === 'GET' && (match = /^\/api\/trials\/([^/]+)\/pictures\/(\d+)$/.exec(path))) {
      const picture = trials.picture(decodeURIComponent(match[1]!), Number(match[2]));
      if (!picture) return send(response, 404, { error: 'No such picture.' });
      response.writeHead(200, { 'Content-Type': 'image/jpeg' });
      response.end(picture);
      return;
    }
    if (method === 'DELETE' && (match = /^\/api\/rules\/(\d+)$/.exec(path))) {
      const rule = rules.get(Number(match[1]));
      if (!rule) return send(response, 404, { error: 'No such rule.' });
      // A rule already gone from the backend still comes off the app's list.
      await connected()
        .deleteRule(rule.backendRuleId)
        .catch((error: unknown) => {
          if (!(error instanceof BackendError && error.status === 404)) throw error;
        });
      rules.remove(rule.id);
      return send(response, 200, { removed: true });
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

  // With nothing asked, lists what is on the frame; a word adds what it finds, and a click adds what was clicked.
  async function outlineOnFrame(id: string, frame: number, body: Record<string, unknown>, charge: (kind: 'look') => Promise<void>) {
    const parsed = thingsInput.safeParse(body);
    if (!parsed.success) throw new RequestError(400, 'Type what to look for, or select it on the picture.');
    const clip = await following.clips.get(id);
    const bytes = await following.clips.picture(id, frame);
    if (!clip || !bytes) throw new RequestError(404, 'No such frame.');
    const picture: Picture = { bytes, mimeType: 'image/jpeg' };

    if ('word' in parsed.data) {
      const { word } = parsed.data;
      await charge('look');
      const found = (await following.outlineAll(picture, [word]))[word] ?? [];
      return { things: await following.things.add(id, frame, found), found: found.length };
    }
    if ('point' in parsed.data) {
      const { point } = parsed.data;
      if (point.x >= clip.width || point.y >= clip.height) throw new RequestError(400, 'Select a place on the picture.');
      await charge('look');
      const outline = await following.outlineAt(picture, { width: clip.width, height: clip.height }, point, CLICKED_NAME);
      if (!outline) return { things: await following.things.list(id, frame), found: 0 };
      const things = await following.things.add(id, frame, [outline]);
      const selected = things.reduce((best, t) => (boxOverlap(t.box, outline.box) > boxOverlap(best.box, outline.box) ? t : best));
      if (selected.name !== CLICKED_NAME) return { things, found: 1, selected: selected.id };
      // The outline is already right if the name fails, so a failed name leaves it under the plain one.
      const name = await following.nameThing(picture, selected.box).catch(() => CLICKED_NAME);
      return { things: await following.things.rename(id, frame, selected.id, name), found: 1, selected: selected.id };
    }
    const key = `${id}/${frame}`;
    if (!naming.has(key)) {
      if ((await following.things.list(id, frame)).length === 0) await charge('look');
      naming.set(
        key,
        (async () => {
          if ((await following.things.list(id, frame)).length > 0) return;
          const words = await following.listThings(picture);
          const outlined = await following.outlineAll(picture, words);
          await following.things.add(id, frame, Object.values(outlined).flat());
        })().catch((error: unknown) => {
          naming.delete(key);
          throw error;
        }),
      );
    }
    await naming.get(key);
    return { things: await following.things.list(id, frame) };
  }

  // The box is read from what was outlined on the frame, never taken from the request.
  async function startFollow(id: string, body: Record<string, unknown>, charge: (kind: 'track') => Promise<void>): Promise<string> {
    const parsed = followInput.safeParse(body);
    if (!parsed.success) throw new RequestError(400, 'Select what to track.');
    if (!(await following.clips.get(id))) throw new RequestError(404, 'No such clip.');
    const thing = (await following.things.list(id, parsed.data.frame)).find((t) => t.id === parsed.data.thing);
    if (!thing) throw new RequestError(400, 'That outline is not on this frame. Select another.');
    if (!(await following.follows.isKept(id, parsed.data.frame, thing.box))) await charge('track');
    return following.follows.start(id, parsed.data.frame, thing);
  }

  // Each zone with the rules that watch it, found by place, so the camera page can tell active zones from the rest.
  async function withRules(full: Camera) {
    const { episode, backend: linked, group: _group, ...camera } = full;
    const onCamera = rules.list(camera.id);
    return {
      ...camera,
      playing: episode ? { at: playing(camera.id)?.at ?? null } : null,
      connected: backend !== null && linked !== null,
      stored: linked?.recorded ? { from: Date.parse(linked.recorded.from), to: Date.parse(linked.recorded.to) } : null,
      coverage: nightCoverage(camera.zones, Object.keys(camera.pictures)),
      zones: camera.zones.map((zone) => ({
        ...zone,
        rules: onCamera.filter((r) => r.zones.some((z) => z.kind === 'outline' && zoneAt(camera.zones, z.word, z.reference) === zone)).map((r) => r.id),
      })),
    };
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

  function connected(): RuleBackend {
    if (!backend) throw new RequestError(409, 'This app is not connected to Streamatic.');
    return backend;
  }

  function resolveZones(camera: Camera, input: z.infer<typeof ruleInput>): Zone[] {
    return input.zones.map((given): Zone => {
      if (given.kind === 'box') {
        const taken = sameName(camera.zones, given.name);
        if (taken) throw new RequestError(409, `A zone on this camera is already called “${taken.name}”. Give the box another name.`);
        return { name: given.name, kind: 'box', box: given.box, question: given.question };
      }
      const { word, label, objectId } = given;
      const zone = outlinedZone(camera, word, label, objectId);
      const outline = zone.outlines[label]!.find((o) => o.objectId === objectId)!;
      return { name: zone.name, kind: 'outline', word, reference: outline.box, path: outline.path };
    });
  }

  // The backend reads the sentence and checks the camera can answer it; nothing is saved until the person says yes.
  async function draftRule(input: z.infer<typeof ruleInput>) {
    const camera = await cameras.get(input.camera);
    if (!camera) throw new RequestError(400, 'No such camera.');
    const zones = resolveZones(camera, input);
    const client = connected();
    if (!camera.backend) throw new RequestError(409, 'This camera is not connected to Streamatic, so rules cannot be saved on it.');
    const size = await pictureSize(camera);
    const boxQuestions = zones.flatMap((z) => (z.kind === 'box' ? [z.question] : []));
    const request = sentenceWithPlaces(
      [input.sentence, ...boxQuestions].join(' '),
      zones.map((z) => ({ name: z.name, box: zoneBox(z) })),
      size,
    );
    const parsed = await client.parse(request);
    if (!parsed.supported || !parsed.condition) {
      return { id: null, supported: false, request, refusal: parsed.refusal ?? null, rewrites: parsed.rewrites ?? [] };
    }
    const draft = withHours(parsed, input.activeHours);
    const probe = await client.probe(camera.backend.deviceId, request, draft);
    const id = randomUUID();
    drafts.set(id, { camera, sentence: input.sentence, request, zones, activeHours: input.activeHours, draft, trial: null });
    for (const old of drafts.keys()) if (drafts.size > KEPT_DRAFTS) drafts.delete(old);
    return {
      id,
      supported: true,
      request,
      name: draft.name ?? input.sentence,
      readsAs: draft.readsAs ?? input.sentence,
      question: String(draft.condition?.question ?? ''),
      severalPictures: settledBy(draft) !== 'one-picture',
      canAnswer: !probe.warns,
    };
  }

  // The backend's rule comes first; the app's row only says which rule it is, so a refusal leaves nothing behind.
  async function saveRule(id: string, guidePlan: unknown) {
    const held = drafts.get(id);
    if (!held) throw new RequestError(409, 'That draft has lapsed. Read the rule again before saving it.');
    const backendRuleId = await connected().createRule(held.camera.backend!.deviceId, held.request, held.draft);
    drafts.delete(id);
    const ruleId = rules.add({
      camera: held.camera.id,
      sentence: held.sentence,
      zones: held.zones,
      activeHours: held.activeHours,
      backendRuleId,
      readsAs: held.draft.readsAs ?? held.sentence,
      severalPictures: settledBy(held.draft) !== 'one-picture',
      guidePlan,
    });
    const saved = rules.get(ruleId)!;
    // What the trial found stays with the rule, labelled as a recorded run. The rule is saved either way.
    if (held.trial) await keepRecordedRun(held.trial, saved, held.camera.name);
    return saved;
  }

  async function keepRecordedRun(trial: string, rule: SavedRule, camera: string): Promise<void> {
    for (const stretch of trials.stretches(trial)) {
      await keepStretch(stretch, rule, camera, { store: events, mediaDir, outlineAll: following.outlineAll }).catch((error: unknown) => console.error(error));
    }
  }

  function askFor(id: string): { held: HeldDraft; ask: StoredAsk } {
    const held = drafts.get(id);
    if (!held) throw new RequestError(409, 'That draft has lapsed. Read the rule again before trying it.');
    const recorded = held.camera.backend?.recorded;
    if (!recorded) throw new RequestError(409, 'This camera has no stored pictures to try the rule on.');
    const ask: StoredAsk = {
      question: String(held.draft.condition?.question ?? ''),
      verdict: held.draft.condition?.verdict !== false,
      settledBy: settledBy(held.draft),
      deviceId: held.camera.backend!.deviceId,
      from: new Date(recorded.from),
      to: new Date(recorded.to),
    };
    return { held, ask };
  }

  // A rule keeps its zone's box, so it finds its zone again by place; the name travels to its rules and their events.
  async function renameZone(id: string, input: z.infer<typeof zoneNameInput>) {
    const camera = await cameras.get(id);
    if (!camera) throw new RequestError(404, 'No such camera.');
    const zone = outlinedZone(camera, input.word, input.label, input.objectId);
    const onCamera = rules.list(camera.id);
    const taken =
      sameName(camera.zones.filter((z) => z !== zone), input.name) ??
      onCamera.flatMap((r) => r.zones).find((z) => z.kind === 'box' && z.name.toLowerCase() === input.name.toLowerCase());
    if (taken) throw new RequestError(409, `Another zone on this camera is already called “${taken.name}”.`);

    const isThisZone = (z: Zone) => z.kind === 'outline' && zoneAt(camera.zones, z.word, z.reference) === zone;
    const onZone = onCamera.filter((r) => r.zones.some(isThisZone));
    const names = (await cameras.zoneNames(camera.id)).filter((n) => n.word !== zone.word || zoneAt([zone], n.word, n.box) === null);
    await cameras.saveZoneNames(camera.id, [...names, { word: zone.word, box: Object.values(zone.outlines)[0]![0]!.box, name: input.name }]);
    const oldNames = new Set([zone.name]);
    for (const rule of onZone) {
      rule.zones.filter(isThisZone).forEach((z) => oldNames.add(z.name));
      rules.setZones(rule.id, rule.zones.map((z) => (isThisZone(z) ? { ...z, name: input.name } : z)));
    }
    let renamedEvents = 0;
    for (const old of oldNames) {
      if (old !== input.name) renamedEvents += events.renameZone(camera.name, old, input.name);
    }
    return { zones: (await withRules((await cameras.get(camera.id))!)).zones, rules: onZone.length, events: renamedEvents };
  }
}

function outlinedZone(camera: Camera, word: string, label: string, objectId: string): CameraZone {
  const zone = camera.zones.find((z) => z.word === word && z.outlines[label]?.some((o) => o.objectId === objectId));
  if (!zone) throw new RequestError(400, 'That outline is not in this camera’s setup. Run setup again and choose an outline.');
  return zone;
}

function sameName(zones: CameraZone[], name: string): CameraZone | undefined {
  return zones.find((z) => z.name.toLowerCase() === name.toLowerCase());
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

// The browser seeks by asking for byte ranges, so a clip can be scrubbed without fetching all of it.
async function sendVideo(request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
  const { size } = await stat(file);
  const asked = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (!asked || (!asked[1] && !asked[2])) {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(response);
    return;
  }
  const start = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]));
  const end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
  if (start > end) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
  createReadStream(file, { start, end }).pipe(response);
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
