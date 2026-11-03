import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoAlert, DemoRule } from '../demo/store.js';
import type { BotChat } from './api.js';
import { drawOutlines } from './draw.js';
import type { AlertLanguage } from './links.js';

export const ruleWords = (rule: DemoRule) => (rule.kind === 'typed' ? rule.text : rule.name);

// The camera and what happened. The backend's scene caption stays out: it describes a sampled frame, often not the event.
export function alertText(camera: string, rule: string, alert: DemoAlert, language: AlertLanguage): string {
  return `${camera}\n${language === 'english' ? rule : (alert.captions[language] ?? rule)}`;
}

export async function sendDemoAlert({
  chat,
  to,
  folder,
  clip,
  rule,
  alert,
  language,
}: {
  chat: Pick<BotChat, 'sendText' | 'sendPicture'>;
  to: number;
  folder: string;
  clip: { id: string; name: string; width: number; height: number };
  rule: DemoRule;
  alert: DemoAlert;
  language: AlertLanguage;
}): Promise<void> {
  const text = alertText(clip.name, ruleWords(rule), alert, language);
  const kept = alert.picture ? await readFile(join(folder, 'clips', clip.id, 'evidence', alert.picture)).catch(() => null) : null;
  if (!kept) return chat.sendText(to, text);
  const paths = rule.zones.flatMap((z) => z.paths);
  return chat.sendPicture(to, paths.length ? await drawOutlines(kept, paths, clip) : new Uint8Array(kept), text);
}

// An event of the private app, on the picture it was copied with and SAM's outline on that picture.
export async function sendEventAlert({
  chat,
  to,
  mediaDir,
  event,
  words,
}: {
  chat: Pick<BotChat, 'sendText' | 'sendPicture'>;
  to: number;
  mediaDir: string;
  event: { camera: string; picture: string | null; outline: string | null };
  words: string;
}): Promise<void> {
  const text = `${event.camera}\n${words}`;
  const kept = event.picture ? await readFile(join(mediaDir, event.picture)).catch(() => null) : null;
  if (!kept) return chat.sendText(to, text);
  return chat.sendPicture(to, event.outline ? await drawOutlines(kept, [event.outline]) : new Uint8Array(kept), text);
}
