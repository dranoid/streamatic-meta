import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoAlert, DemoRule } from '../demo/store.js';
import type { BotChat } from './api.js';
import { drawOutlines } from './draw.js';
import type { AlertLanguage } from './links.js';

export const ruleWords = (rule: DemoRule) => (rule.kind === 'typed' ? rule.text : rule.name);

const ASKING = /^(please\s+)?(alert(\s+me)?|tell\s+me|notify\s+me|warn\s+me|let\s+me\s+know)\s+(when|whenever|if)\s+/i;
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clockOf = (ms: number) => `${Math.floor(Math.round(ms / 1000) / 60)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;

// A rule is worded as a request and an alert states what happened.
function whatHappened(rule: string): string {
  const stated = rule.trim().replace(ASKING, '').replace(/[.!]+$/, '');
  return stated.charAt(0).toUpperCase() + stated.slice(1);
}

const alertLines = (camera: string, happened: string) => `🚨 <b>ALERT: ${escaped(camera.toUpperCase())}</b>\n<b>${escaped(happened)}</b>`;

// The camera, what happened and when. The backend's scene caption stays out: it describes a sampled frame, often not the event.
export function alertText(camera: string, rule: string, alert: DemoAlert, language: AlertLanguage): string {
  const happened = language === 'english' ? whatHappened(rule) : (alert.captions[language] ?? whatHappened(rule));
  return `${alertLines(camera, happened)}\n⏱ ${clockOf(alert.atMs)}`;
}

// An alert matters more than its picture, so one whose picture cannot be drawn or sent still arrives as words.
async function pictureOrWords(chat: Pick<BotChat, 'sendText' | 'sendPicture'>, to: number, picture: () => Promise<Uint8Array>, text: string): Promise<void> {
  try {
    await chat.sendPicture(to, await picture(), text);
  } catch (error) {
    console.error(`Telegram picture: ${error instanceof Error ? error.message : String(error)}`);
    await chat.sendText(to, text, undefined, { html: true });
  }
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
  if (!kept) return chat.sendText(to, text, undefined, { html: true });
  const paths = rule.zones.flatMap((z) => z.paths);
  return pictureOrWords(chat, to, async () => (paths.length ? drawOutlines(kept, paths, clip) : new Uint8Array(kept)), text);
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
  const text = alertLines(event.camera, whatHappened(words));
  const kept = event.picture ? await readFile(join(mediaDir, event.picture)).catch(() => null) : null;
  if (!kept) return chat.sendText(to, text, undefined, { html: true });
  return pictureOrWords(chat, to, async () => (event.outline ? drawOutlines(kept, [event.outline]) : new Uint8Array(kept)), text);
}
