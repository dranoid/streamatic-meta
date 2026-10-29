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

export interface Camera {
  id: string;
  name: string;
  site: string;
  baseWords: string[];
  pictures: Record<string, string>;
  setup: CameraSetup | null;
}

export type Zone =
  | { name: string; kind: 'outline'; word: string; reference: Box; path: string }
  | { name: string; kind: 'box'; box: Box };

export interface SavedRule {
  id: number;
  camera: string;
  sentence: string;
  zone: Zone;
  question: string | null;
  activeHours: { from: number; to: number } | null;
}

export type NewZone =
  | { kind: 'outline'; name: string; word: string; label: string; objectId: string }
  | { kind: 'box'; name: string; box: Box; question: string };

export interface StoredEvent {
  id: number;
  camera: string;
  zone: string;
  rule: string;
  at: number;
  picture: string | null;
  clip: string | null;
  outline: string | null;
  reference: string | null;
  secondOpinion: { confirmed: boolean | null; reason: string } | null;
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

export const api = {
  cameras: () => request<Camera[]>('/api/cameras'),
  runSetup: (camera: string) => request<CameraSetup>(`/api/cameras/${encodeURIComponent(camera)}/setup`, { method: 'POST' }),
  rules: (camera?: string) => request<SavedRule[]>(`/api/rules${camera ? `?camera=${encodeURIComponent(camera)}` : ''}`),
  addRule: (rule: { camera: string; sentence: string; zone: NewZone; activeHours: { from: number; to: number } | null }) =>
    request<SavedRule>('/api/rules', { method: 'POST', body: JSON.stringify(rule) }),
  removeRule: (id: number) => request<{ removed: true }>(`/api/rules/${id}`, { method: 'DELETE' }),
  events: () => request<StoredEvent[]>('/api/events'),
  event: (id: number) => request<StoredEvent>(`/api/events/${id}`),
  frames: (id: number) => request<EventFrame[]>(`/api/events/${id}/frames`),
  ask: (question: string) => request<Answer>('/api/questions', { method: 'POST', body: JSON.stringify({ question }) }),
};

export const pictureUrl = (camera: string, file: string) =>
  `/camera-pictures/${encodeURIComponent(camera)}/${encodeURIComponent(file)}`;
export const mediaUrl = (file: string) => `/media/${encodeURIComponent(file)}`;
