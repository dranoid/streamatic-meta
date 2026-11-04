export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Outline {
  word: string;
  objectId: string;
  box: Box;
  path: string;
}

export interface SetupZone {
  name: string;
  item: string;
  seenAt: string[];
  outlines: Record<string, Outline[]>;
}

export interface CameraSetup {
  zones: SetupZone[];
  notOutlined: Array<{ item: string; triedWords: string[] }>;
  rules: Array<{ sentence: string; zones: string[] }>;
}

// One thing SAM outlined, matched across the pictures, under the name people use for it.
export interface CameraZone {
  word: string;
  name: string;
  // Per picture, in pieces where SAM cut the thing up.
  outlines: Record<string, Outline[]>;
  // The saved rules that watch this zone.
  rules: number[];
}

export interface Camera {
  id: string;
  name: string;
  site: string;
  baseWords: string[];
  pictures: Record<string, string>;
  setup: CameraSetup | null;
  zones: CameraZone[];
  // Set when the camera plays a recording on a loop as its pictures; at is the recorded time of the picture playing.
  playing: { at: number | null } | null;
  // Whether rules on this camera can be saved in Streamatic.
  connected: boolean;
  // The hours of stored pictures a rule can be tried on before it is saved.
  stored: { from: number; to: number } | null;
  // Which of the camera's pictures found each zone.
  coverage: ZoneCoverage[];
}

export interface ZoneCoverage {
  name: string;
  foundOn: string[];
  missedOn: string[];
  uncertainAtNight: boolean;
}

export type Zone =
  | { name: string; kind: 'outline'; word: string; reference: Box; path: string }
  | { name: string; kind: 'box'; box: Box; question: string };

export interface SavedRule {
  id: number;
  camera: string;
  sentence: string;
  zones: Zone[];
  activeHours: { from: number; to: number } | null;
  // How Streamatic read the sentence, and whether it compares pictures or decides on one.
  readsAs: string;
  severalPictures: boolean;
}

export type NewZone =
  | { kind: 'outline'; word: string; label: string; objectId: string }
  | { kind: 'box'; name: string; box: Box; question: string };

export interface NewRule {
  camera: string;
  sentence: string;
  zones: NewZone[];
  activeHours: { from: number; to: number } | null;
}

// What Streamatic made of a sentence. Nothing is saved until the person says yes to it.
export type RuleReading =
  | { id: string; supported: true; request: string; name: string; readsAs: string; question: string; severalPictures: boolean; canAnswer: boolean }
  | { id: null; supported: false; request: string; refusal: string | null; rewrites: string[] };

export interface TrialEstimate {
  costMicroUsd: number | null;
  reason: string | null;
  from: number;
  to: number;
}

export interface Trial {
  state: 'running' | 'done' | 'failed';
  read: number;
  total: number;
  stretches: Array<{ from: number; to: number; picture: number | null }>;
}

export interface GuidePlan {
  sentence: string;
  // What the alert is for, in the person's own words.
  about: string;
  zones: string[];
  // Placed over the named zone when over is set; otherwise the person draws it.
  box: { name: string; question: string; over: string | null } | null;
  hours: { from: number; to: number } | null;
}

export interface PlanAttempt {
  plan: GuidePlan;
  problems: string[];
}

export type PlanResult =
  | { status: 'ready'; plan: GuidePlan; attempts: PlanAttempt[] }
  | { status: 'needs-person'; problems: string[]; attempts: PlanAttempt[] };

// Another camera at the same place whose setup outlined what was asked about, when this one's did not.
export interface ElsewhereCamera {
  camera: string;
  name: string;
  zones: string[];
  matched: number;
}

// A camera on the public page a sentence could go to, with the thing outlined on its picture.
export interface CameraOffer extends ElsewhereCamera {
  hasClip: boolean;
  picture: string;
  paths: string[];
}

export interface DemoCamera {
  id: string;
  name: string;
  hasClip: boolean;
  picture: string;
}

export interface StoredEvent {
  id: number;
  // Found by running the rule over stored pictures rather than raised as they arrived.
  recorded: boolean;
  camera: string;
  zone: string;
  rule: string;
  at: number;
  picture: string | null;
  clip: string | null;
  outline: string | null;
  reference: string | null;
}

export interface EventFrame {
  at: number;
  file: string;
  outline: string | null;
}

export interface Answer {
  text: string;
  count: number | null;
  eventIds: number[];
}

export interface Clip {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

// Something outlined on a frame of a clip, which can be selected to follow.
export interface Thing {
  id: string;
  name: string;
  box: Box;
  path: string;
}

export interface Span {
  from: number;
  to: number;
}

export interface Follow {
  id: string;
  name: string;
  frame: number;
  box: Box;
  // The stretches of frames the thing was in view.
  spans: Span[];
  frames: Array<{ frame: number; box: Box; path: string }>;
}

export type FollowJob =
  | { state: 'running'; name: string; framesSeen: number }
  | { state: 'done'; name: string; framesSeen: number; follow: Follow }
  | { state: 'failed'; name: string; framesSeen: number };

export interface ThingsFound {
  things: Thing[];
  found?: number;
  selected?: string;
}

export interface AppInfo {
  // The public page: only clips, a visitor's own picture and the About page.
  public: boolean;
  // How far a track reaches either side of the selected frame; null when it covers the whole clip.
  trackSeconds: number | null;
  // What this copy of the public page can spend on; the recorded clips need neither.
  models?: boolean;
  rules?: boolean;
  telegram?: boolean;
  // Whose footage this folder shows, where its licence asks to be credited.
  credit?: 'meva' | null;
}

export interface DemoClipSummary extends Clip {
  description: string | null;
  rules: number;
  alerts: number;
}

export interface DemoZone {
  name: string;
  paths: string[];
}

export interface DemoRule {
  id: string;
  kind: 'offered' | 'typed';
  text: string;
  name: string;
  readsAs: string | null;
  status: string;
  progress: { done: number; total: number | null };
  rewrites: string[];
  reason: string | null;
  canAnswer: boolean;
  zones: DemoZone[];
}

export interface DemoClip {
  id: string;
  description: string | null;
  startsAt: number;
  lengthMs: number;
  zones: DemoZone[];
  suggestions: string[];
  rules: DemoRule[];
}

export interface DemoSetup {
  hasClip: boolean;
  picture: string;
  pictures: Array<{ label: string; src: string }>;
  zones: Array<DemoZone & { item: string; seenAt: string[]; pathsBy: Record<string, string[]> }>;
  rules: string[];
}

export interface DemoTick {
  rule: string;
  armedMs: number;
}

// When a rule alerts on the clip, counted from its start: atMs is the moment it is about, shownMs when the page shows it.
export interface DemoAlert {
  key: string;
  rule: string;
  atMs: number;
  shownMs: number;
  message: string;
  severity: string;
  picture: string | null;
  caption: string | null;
  // What the rule's alerts say in other languages, written once and kept.
  captions: Partial<Record<CaptionLanguage, string>>;
}

export type CaptionLanguage = 'pidgin' | 'yoruba';

export interface OwnPictureSetup {
  picture: string;
  width: number;
  height: number;
  setup: CameraSetup;
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  // The server writes its errors for the person, so they are shown as they are.
  if (!response.ok) throw new ApiError(body.error ?? 'The request could not be completed. Please try again.');
  return body as T;
}

async function sendVoiceNote(path: string, audio: Blob): Promise<{ text: string }> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': audio.type || 'application/octet-stream' }, body: audio });
  const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!response.ok || !body.text) throw new ApiError(body.error ?? 'The voice note could not be read. Please try again.');
  return { text: body.text };
}

export const api = {
  cameras: () => request<Camera[]>('/api/cameras'),
  runSetup: (camera: string) => request<CameraSetup>(`/api/cameras/${encodeURIComponent(camera)}/setup`, { method: 'POST' }),
  rules: (camera?: string) => request<SavedRule[]>(`/api/rules${camera ? `?camera=${encodeURIComponent(camera)}` : ''}`),
  readRule: (rule: NewRule) => request<RuleReading>('/api/rule-drafts', { method: 'POST', body: JSON.stringify(rule) }),
  addRule: (draft: string, guidePlan: GuidePlan | null) =>
    request<SavedRule>('/api/rules', { method: 'POST', body: JSON.stringify({ draft, guidePlan }) }),
  trialEstimate: (draft: string) => request<TrialEstimate>(`/api/rule-drafts/${encodeURIComponent(draft)}/trial-estimate`),
  startTrial: (draft: string, confirmedCostMicroUsd: number | null) =>
    request<{ id: string }>('/api/trials', { method: 'POST', body: JSON.stringify({ draft, confirmedCostMicroUsd }) }),
  trial: (id: string) => request<Trial>(`/api/trials/${encodeURIComponent(id)}`),
  planRule: (camera: string, sentence: string) => request<PlanResult & { elsewhere: ElsewhereCamera[] }>('/api/guide/plans', { method: 'POST', body: JSON.stringify({ camera, sentence }) }),
  renameZone: (camera: string, zone: { word: string; label: string; objectId: string; name: string }) =>
    request<{ zones: CameraZone[]; rules: number; events: number }>(`/api/cameras/${encodeURIComponent(camera)}/zones`, {
      method: 'PATCH',
      body: JSON.stringify(zone),
    }),
  removeRule: (id: number) => request<{ removed: true }>(`/api/rules/${id}`, { method: 'DELETE' }),
  events: () => request<StoredEvent[]>('/api/events'),
  event: (id: number) => request<StoredEvent>(`/api/events/${id}`),
  frames: (id: number) => request<EventFrame[]>(`/api/events/${id}/frames`),
  eventCaption: (id: number, language: CaptionLanguage) =>
    request<{ language: CaptionLanguage; text: string }>(`/api/events/${id}/captions`, { method: 'POST', body: JSON.stringify({ language }) }),
  clips: () => request<Clip[]>('/api/clips'),
  things: (clip: string, frame: number) => request<ThingsFound>(`/api/clips/${encodeURIComponent(clip)}/frames/${frame}/things`),
  outline: (clip: string, frame: number, what: { word: string } | { box: { left: number; top: number; right: number; bottom: number } } | Record<string, never>) =>
    request<ThingsFound>(`/api/clips/${encodeURIComponent(clip)}/frames/${frame}/things`, { method: 'POST', body: JSON.stringify(what) }),
  follows: (clip: string) => request<Follow[]>(`/api/clips/${encodeURIComponent(clip)}/follows`),
  startFollow: (clip: string, frame: number, thing: string) =>
    request<{ id: string }>(`/api/clips/${encodeURIComponent(clip)}/follows`, { method: 'POST', body: JSON.stringify({ frame, thing }) }),
  followJob: (clip: string, id: string) => request<FollowJob>(`/api/clips/${encodeURIComponent(clip)}/follows/${encodeURIComponent(id)}`),
  app: () => request<AppInfo>('/api/app'),
  demoClips: () => request<DemoClipSummary[]>('/api/demo/clips'),
  demoCameras: () => request<DemoCamera[]>('/api/demo/cameras'),
  routeSentence: (sentence: string) => request<{ cameras: CameraOffer[] }>('/api/demo/route', { method: 'POST', body: JSON.stringify({ sentence }) }),
  routeFromClip: (clip: string, sentence: string) => request<{ elsewhere: CameraOffer[] }>(`/api/demo/clips/${encodeURIComponent(clip)}/route`, { method: 'POST', body: JSON.stringify({ sentence }) }),
  voiceNoteOnPage: (audio: Blob) => sendVoiceNote('/api/demo/voice-notes', audio),
  demoClip: (clip: string) => request<DemoClip>(`/api/demo/clips/${encodeURIComponent(clip)}`),
  demoSetup: (clip: string) => request<DemoSetup>(`/api/demo/clips/${encodeURIComponent(clip)}/setup`),
  demoAlerts: (clip: string, ticks: DemoTick[]) =>
    request<{ alerts: DemoAlert[] }>(`/api/demo/clips/${encodeURIComponent(clip)}/alerts`, { method: 'POST', body: JSON.stringify({ ticks }) }),
  telegramStatus: (clip: string) => request<{ linked: boolean; link: string | null }>(`/api/demo/telegram?clip=${encodeURIComponent(clip)}`),
  telegramChoose: (clip: string, language: string) => request<{ linked: boolean }>('/api/demo/telegram', { method: 'PUT', body: JSON.stringify({ clip, language }) }),
  telegramTurnOff: () => request<{ linked: boolean }>('/api/demo/telegram', { method: 'DELETE' }),
  sendAlertToTelegram: (clip: string, rule: string, key: string) =>
    request<{ sent: true }>(`/api/demo/clips/${encodeURIComponent(clip)}/telegram-alerts`, { method: 'POST', body: JSON.stringify({ rule, key }) }),
  voiceNoteOnCamera: (camera: string, audio: Blob) => sendVoiceNote(`/api/cameras/${encodeURIComponent(camera)}/voice-notes`, audio),
  voiceNoteOnClip: (clip: string, audio: Blob) => sendVoiceNote(`/api/demo/clips/${encodeURIComponent(clip)}/voice-notes`, audio),
  planOnClip: (clip: string, sentence: string) => request<PlanResult>(`/api/demo/clips/${encodeURIComponent(clip)}/plans`, { method: 'POST', body: JSON.stringify({ sentence }) }),
  addToClip: (clip: string, rule: { text: string } | { plan: GuidePlan }) =>
    request<{ id: string }>(`/api/demo/clips/${encodeURIComponent(clip)}/rules`, { method: 'POST', body: JSON.stringify(rule) }),
  removeClipRule: (clip: string, id: string) => request<{ removed: true }>(`/api/demo/clips/${encodeURIComponent(clip)}/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clipRule: (clip: string, id: string) => request<DemoRule>(`/api/demo/clips/${encodeURIComponent(clip)}/rules/${encodeURIComponent(id)}`),
  setUpOwnPicture: async (file: File): Promise<OwnPictureSetup> => {
    const response = await fetch('/api/demo/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const body = (await response.json().catch(() => ({}))) as OwnPictureSetup & { error?: string };
    if (!response.ok) throw new ApiError(body.error ?? 'The picture could not be set up. Please try again.');
    return body;
  },
  ask: (question: string) => request<Answer>('/api/questions', { method: 'POST', body: JSON.stringify({ question }) }),
};

export const pictureUrl = (camera: string, file: string) =>
  `/camera-pictures/${encodeURIComponent(camera)}/${encodeURIComponent(file)}`;
export const nowUrl = (camera: string, at: number) => `/api/cameras/${encodeURIComponent(camera)}/now?at=${at}`;
export const mediaUrl = (file: string) => `/media/${encodeURIComponent(file)}`;
export const clipVideoUrl = (clip: string) => `/clip-videos/${encodeURIComponent(clip)}`;
export const clipPictureUrl = (clip: string, frame: number) => `/clip-pictures/${encodeURIComponent(clip)}/${frame}`;
