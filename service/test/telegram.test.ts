import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { CameraFolder } from '../src/cameras/camera-folder.js';
import { DemoLimits } from '../src/demo/limits.js';
import { DemoStore, type DemoAlert, type DemoRule } from '../src/demo/store.js';
import type { GuidePlanner } from '../src/guide/plan.js';
import { pollUpdates, TelegramApi, TelegramError, type BotChat, type Update } from '../src/telegram/api.js';
import { alertText, sendDemoAlert, sendEventAlert } from '../src/telegram/demo-alert.js';
import { DemoBot } from '../src/telegram/demo-bot.js';
import { TelegramLinks } from '../src/telegram/links.js';

const TOKEN = '123:secret-token';
const CLIP = 'entrance';
const PERSON = 555;
const VISITOR = 'visitor-1';

function fakeChat() {
  const sent: Array<{ to: number; text: string; buttons?: Array<{ text: string; data: string }>; picture?: Uint8Array }> = [];
  const chat: BotChat = {
    sendText: async (to, text, buttons) => void sent.push({ to, text, ...(buttons ? { buttons } : {}) }),
    sendPicture: async (to, picture, text) => void sent.push({ to, text, picture }),
    answer: async () => undefined,
    download: async () => new Uint8Array([1, 2, 3]),
  };
  return { chat, sent };
}

const message = (over: Record<string, unknown>, id = PERSON): Update => ({ update_id: 1, message: { from: { id }, chat: { id, type: 'private' }, ...over } }) as Update;
const button = (data: string, id = PERSON): Update => ({ update_id: 2, callback_query: { id: 'cb', from: { id }, data } }) as Update;

async function picture() {
  return new Uint8Array(await sharp({ create: { width: 64, height: 36, channels: 3, background: '#222' } }).jpeg().toBuffer());
}

const RULE: DemoRule = { id: 'rule-1', clip: CLIP, kind: 'offered', visitor: null, text: 'Door', name: 'Alert when someone opens the door', readsAs: null, status: 'ready', progress: { done: 0, total: null }, rewrites: [], reason: null, canAnswer: true, zones: [] };
const ALERT: DemoAlert = { key: 'k1', rule: 'rule-1', atMs: 42_000, shownMs: 60_000, delayMs: 18_000, message: 'answered true', severity: 'medium', picture: 'k1.jpg', caption: 'A scene the model described', captions: { pidgin: 'Somebody don open di door' } };

describe('TelegramApi', () => {
  it('never puts its token in an error', async () => {
    const api = new TelegramApi({ token: TOKEN, fetch: (async () => new Response(JSON.stringify({ ok: false, description: 'Forbidden' }), { status: 403 })) as unknown as typeof fetch });
    const failure = await api.sendText(1, 'hello').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramError);
    expect((failure as TelegramError).message).not.toContain(TOKEN);
    expect((failure as TelegramError).status).toBe(403);
  });

  // A dropped connection reaches the caller as fetch's TypeError, with the socket's reason as its cause.
  const droppedThenAccepted = (drops: number) => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(new URL(url).pathname);
      if (calls.length <= drops) throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;
    return { calls, fake };
  };

  it('sends a picture again when the connection drops, since Telegram never answered', async () => {
    const { calls, fake } = droppedThenAccepted(2);
    const waits: number[] = [];
    const api = new TelegramApi({ token: TOKEN, fetch: fake, wait: async (ms) => void waits.push(ms) });
    await api.sendPicture(PERSON, new Uint8Array([1, 2, 3]), 'Door');
    expect(calls).toEqual(Array(3).fill(`/bot${TOKEN}/sendPhoto`));
    expect(waits).toHaveLength(2);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  it('sends words again when the connection drops', async () => {
    const { calls, fake } = droppedThenAccepted(1);
    const api = new TelegramApi({ token: TOKEN, fetch: fake, wait: async () => undefined });
    await api.sendText(PERSON, 'Door');
    expect(calls).toHaveLength(2);
  });

  it('stops trying after a few dropped connections, and lets the caller know, with no token in the error', async () => {
    const { calls, fake } = droppedThenAccepted(50);
    const api = new TelegramApi({ token: TOKEN, fetch: fake, wait: async () => undefined });
    const failure = await api.sendPicture(PERSON, new Uint8Array([1]), 'Door').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(6);
  });

  it('does not send again when Telegram itself refused', async () => {
    let calls = 0;
    const api = new TelegramApi({
      token: TOKEN,
      wait: async () => undefined,
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      }) as unknown as typeof fetch,
    });
    await expect(api.sendPicture(PERSON, new Uint8Array([1]), 'Door')).rejects.toBeInstanceOf(TelegramError);
    expect(calls).toBe(1);
  });

  const sentBody = () => {
    const bodies: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      bodies.push({ url, body: init.body });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;
    return { bodies, fake };
  };

  it('asks Telegram to show bold words on an alert’s picture and on an alert sent as words', async () => {
    const { bodies, fake } = sentBody();
    const api = new TelegramApi({ token: TOKEN, fetch: fake });
    await api.sendPicture(PERSON, new Uint8Array([1]), '<b>Door</b>');
    await api.sendText(PERSON, '<b>Door</b>', undefined, { html: true });
    expect((bodies[0]!.body as FormData).get('parse_mode')).toBe('HTML');
    expect(JSON.parse(bodies[1]!.body as string).parse_mode).toBe('HTML');
  });

  it('sends every other message as plain words, since a person’s own sentence may hold any character', async () => {
    const { bodies, fake } = sentBody();
    await new TelegramApi({ token: TOKEN, fetch: fake }).sendText(PERSON, 'You said: 3 < 4');
    expect(JSON.parse(bodies[0]!.body as string).parse_mode).toBeUndefined();
  });

  it('asks only for the messages and button presses it handles, after the last update seen', async () => {
    const asked: string[] = [];
    const api = new TelegramApi({
      token: TOKEN,
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ ok: true, result: [] }));
      }) as unknown as typeof fetch,
    });
    await api.updates(41, 25);
    const url = new URL(asked[0]!);
    expect(url.pathname).toBe(`/bot${TOKEN}/getUpdates`);
    expect(url.searchParams.get('offset')).toBe('41');
    expect(url.searchParams.get('allowed_updates')).toBe('["message","callback_query"]');
  });
});

describe('pollUpdates', () => {
  it('moves past each update it has seen, and stops for good on a bot it may not read, since that may be another product’s', async () => {
    const offsets: number[] = [];
    let turn = 0;
    const seen: number[] = [];
    await pollUpdates(
      {
        updates: async (offset) => {
          offsets.push(offset);
          if (turn++ === 0) return [{ update_id: 7 }, { update_id: 8 }];
          throw new TelegramError('Conflict', 409);
        },
      },
      (u) => void seen.push(u.update_id),
    );
    expect(seen).toEqual([7, 8]);
    expect(offsets).toEqual([0, 9]);
  });

  it('carries on after a passing failure', async () => {
    let turn = 0;
    const waits: number[] = [];
    await pollUpdates(
      {
        updates: async () => {
          if (turn++ === 0) throw new Error('network');
          throw new TelegramError('Unauthorized', 401);
        },
      },
      () => undefined,
      { wait: async (ms) => void waits.push(ms) },
    );
    expect(turn).toBe(2);
    expect(waits).toHaveLength(1);
  });
});

describe('an alert of the private app', () => {
  it('names the camera and the words, and draws SAM’s outline on the event’s picture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-'));
    const plain = await picture();
    await writeFile(join(root, 'door.jpg'), plain);
    const { chat, sent } = fakeChat();
    await sendEventAlert({ chat, to: PERSON, mediaDir: root, event: { camera: 'Table parlour', picture: 'door.jpg', outline: 'M0 0H32V18H0Z' }, words: 'Pesin dey open front door' });
    expect(sent[0]!.text).toBe('🚨 <b>ALERT: TABLE PARLOUR</b>\n<b>Pesin dey open front door</b>');
    expect(Buffer.compare(Buffer.from(sent[0]!.picture!), Buffer.from(plain))).not.toBe(0);
  });

  it('sends the picture as it is when SAM drew nothing on it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-'));
    const plain = await picture();
    await writeFile(join(root, 'door.jpg'), plain);
    const { chat, sent } = fakeChat();
    await sendEventAlert({ chat, to: PERSON, mediaDir: root, event: { camera: 'Table parlour', picture: 'door.jpg', outline: null }, words: 'w' });
    expect(Buffer.compare(Buffer.from(sent[0]!.picture!), Buffer.from(plain))).toBe(0);
  });

  it('still arrives as words when its picture cannot be sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-'));
    await writeFile(join(root, 'door.jpg'), await picture());
    const { chat, sent } = fakeChat();
    chat.sendPicture = async () => {
      throw new TypeError('fetch failed');
    };
    await sendEventAlert({ chat, to: PERSON, mediaDir: root, event: { camera: 'Table parlour', picture: 'door.jpg', outline: null }, words: 'Pesin dey open front door' });
    expect(sent).toEqual([{ to: PERSON, text: '🚨 <b>ALERT: TABLE PARLOUR</b>\n<b>Pesin dey open front door</b>' }]);
  });
});

describe('TelegramLinks', () => {
  it('gives a fresh link when the one held is near its end, and the one already opened still works', () => {
    let now = 1_000;
    const links = new TelegramLinks(':memory:', () => now);
    const first = links.token(VISITOR, CLIP);
    expect(links.claim('no-such-link', 777)).toBe(false);
    now += 11 * 60 * 1000;
    const second = links.token(VISITOR, CLIP);
    expect(second).not.toBe(first);
    expect(links.claim(first, PERSON)).toBe(true);
    expect(links.ofVisitor(VISITOR)?.person).toBe(PERSON);
    expect(links.claim(second, 777)).toBe(false);
  });

  it('hands out a link that one person can claim once, and only for a short while', () => {
    let now = 1_000;
    const links = new TelegramLinks(':memory:', () => now);
    const token = links.token(VISITOR, CLIP);
    expect(token).toMatch(/^[\w-]{1,64}$/);
    expect(links.token(VISITOR, CLIP)).toBe(token);
    expect(links.claim(token, PERSON)).toBe(true);
    expect(links.ofVisitor(VISITOR)?.person).toBe(PERSON);
    expect(links.claim(token, 777)).toBe(false);
    expect(links.ofVisitor(VISITOR)?.person).toBe(PERSON);

    const later = links.token('visitor-2', CLIP);
    now += 60 * 60 * 1000;
    expect(links.claim(later, 888)).toBe(false);
  });

  it('holds one link per person and per visitor, whichever links again', () => {
    const links = new TelegramLinks(':memory:');
    links.claim(links.token(VISITOR, CLIP), PERSON);
    links.claim(links.token('visitor-2', CLIP), PERSON);
    expect(links.ofVisitor(VISITOR)).toBeNull();
    expect(links.ofPerson(PERSON)?.visitor).toBe('visitor-2');
    links.claim(links.token('visitor-2', CLIP), 777);
    expect(links.ofPerson(PERSON)).toBeNull();
    expect(links.ofVisitor('visitor-2')?.person).toBe(777);
  });

  it('remembers the clip and language a visitor has chosen, and forgets them when unlinked', () => {
    const links = new TelegramLinks(':memory:');
    links.claim(links.token(VISITOR, CLIP), PERSON);
    expect(links.ofVisitor(VISITOR)).toMatchObject({ clip: CLIP, language: 'english' });
    links.choose(VISITOR, 'car-park', 'pidgin');
    expect(links.ofPerson(PERSON)).toMatchObject({ clip: 'car-park', language: 'pidgin' });
    links.unlink(VISITOR);
    expect(links.ofPerson(PERSON)).toBeNull();
  });
});

describe('an alert on Telegram', () => {
  it('names only the camera it stands for and what happened, in the language chosen', () => {
    expect(alertText('Building entrance', RULE.name, ALERT, 'pidgin')).toBe('🚨 <b>ALERT: BUILDING ENTRANCE</b>\n<b>Somebody don open di door</b>\n⏱ 0:42');
  });

  it('says the rule in English as what happened, never the scene the model described, since that describes a sampled frame', () => {
    const text = alertText('Building entrance', RULE.name, ALERT, 'english');
    expect(text).toBe('🚨 <b>ALERT: BUILDING ENTRANCE</b>\n<b>Someone opens the door</b>\n⏱ 0:42');
    expect(text).not.toContain(ALERT.caption);
  });

  it('falls back to the rule when a language was not written', () => {
    expect(alertText('Building entrance', RULE.name, ALERT, 'yoruba')).toContain('<b>Someone opens the door</b>');
  });

  it('drops the asking from a sentence someone typed, so the alert states what happened', () => {
    expect(alertText('Gate', 'Tell me when a car stops by the gate.', ALERT, 'english')).toContain('<b>A car stops by the gate</b>');
    expect(alertText('Gate', 'Let me know if someone climbs the wall', ALERT, 'english')).toContain('<b>Someone climbs the wall</b>');
  });

  it('keeps a person’s own characters from being read as formatting', () => {
    const text = alertText('Gate & yard', 'Tell me when <b>3 & 4</b> arrive', ALERT, 'english');
    expect(text).toContain('ALERT: GATE &amp; YARD');
    expect(text).toContain('&lt;b&gt;3 &amp; 4&lt;/b&gt; arrive');
  });

  it('carries the kept picture, with the rule’s zones drawn on it in the clip’s own pixels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alert-'));
    await mkdir(join(root, 'clips', CLIP, 'evidence'), { recursive: true });
    const plain = await picture();
    await writeFile(join(root, 'clips', CLIP, 'evidence', 'k1.jpg'), plain);
    const { chat, sent } = fakeChat();
    const zones = [{ name: 'door', paths: ['M0 0H640V360H0Z'] }];
    await sendDemoAlert({ chat, to: PERSON, folder: root, clip: { id: CLIP, name: 'Building entrance', width: 1280, height: 720 }, rule: { ...RULE, zones }, alert: ALERT, language: 'pidgin' });
    expect(sent[0]).toMatchObject({ to: PERSON, text: '🚨 <b>ALERT: BUILDING ENTRANCE</b>\n<b>Somebody don open di door</b>\n⏱ 0:42' });
    expect(Buffer.compare(Buffer.from(sent[0]!.picture!), Buffer.from(plain))).not.toBe(0);
    const { width } = await sharp(sent[0]!.picture!).metadata();
    expect(width).toBe(64);
  });

  it('is sent as words when no picture was kept', async () => {
    const { chat, sent } = fakeChat();
    await sendDemoAlert({ chat, to: PERSON, folder: '/nowhere', clip: { id: CLIP, name: 'Building entrance', width: 1280, height: 720 }, rule: RULE, alert: { ...ALERT, picture: null }, language: 'english' });
    expect(sent[0]).toMatchObject({ text: '🚨 <b>ALERT: BUILDING ENTRANCE</b>\n<b>Someone opens the door</b>\n⏱ 0:42' });
    expect(sent[0]!.picture).toBeUndefined();
  });

  it('still arrives as words when its picture cannot be sent, so an alert is never lost to the picture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alert-'));
    await mkdir(join(root, 'clips', CLIP, 'evidence'), { recursive: true });
    await writeFile(join(root, 'clips', CLIP, 'evidence', 'k1.jpg'), await picture());
    const { chat, sent } = fakeChat();
    chat.sendPicture = async () => {
      throw new TypeError('fetch failed');
    };
    await sendDemoAlert({ chat, to: PERSON, folder: root, clip: { id: CLIP, name: 'Building entrance', width: 1280, height: 720 }, rule: RULE, alert: ALERT, language: 'english' });
    expect(sent).toEqual([{ to: PERSON, text: '🚨 <b>ALERT: BUILDING ENTRANCE</b>\n<b>Someone opens the door</b>\n⏱ 0:42' }]);
  });

  it('reports a failure when the words cannot be sent either', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alert-'));
    await mkdir(join(root, 'clips', CLIP, 'evidence'), { recursive: true });
    await writeFile(join(root, 'clips', CLIP, 'evidence', 'k1.jpg'), await picture());
    const { chat } = fakeChat();
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    chat.sendPicture = offline;
    chat.sendText = offline;
    await expect(sendDemoAlert({ chat, to: PERSON, folder: root, clip: { id: CLIP, name: 'Building entrance', width: 1280, height: 720 }, rule: RULE, alert: ALERT, language: 'english' })).rejects.toThrow();
  });
});

describe('the demo bot', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bot-'));
    await mkdir(join(root, 'cameras', CLIP), { recursive: true });
    await writeFile(join(root, 'cameras', CLIP, 'camera.json'), JSON.stringify({ name: 'Building entrance', site: 'a building', baseWords: [], pictures: { clip: 'still.jpg' } }));
    await writeFile(
      join(root, 'cameras', CLIP, 'setup.json'),
      JSON.stringify({ zones: [{ name: 'door', item: 'door', seenAt: ['clip'], outlines: { clip: [{ word: 'door', objectId: '1', box: { left: 960, top: 100, right: 1280, bottom: 500 }, path: 'M960 100 Z' }] } }], notOutlined: [], rules: [] }),
    );
  });

  const planner: GuidePlanner = { draft: async ({ sentence }) => ({ sentence, about: 'door', zones: ['door'], box: null, hours: null }) };

  function bot({ abilities = { models: true, rules: true }, heard = 'Tell me when someone opens the door.', ruleEnds = 'ready', draft = planner, alerts = [ALERT] }: { abilities?: { models: boolean; rules: boolean }; heard?: string; ruleEnds?: string; draft?: GuidePlanner; alerts?: DemoAlert[] } = {}) {
    const { chat, sent } = fakeChat();
    const links = new TelegramLinks(':memory:');
    const store = new DemoStore(':memory:');
    store.saveClip({ id: CLIP, scenario: 's', name: 'Building entrance', description: null, position: 0, startsAt: 0, lengthMs: 60_000 });
    const typed: Array<{ visitor: string; text: string; sent: string }> = [];
    const charged: Array<{ who: string; kind: string }> = [];
    const heardAudio: Array<{ keywords: string[] }> = [];
    let polls = 0;
    const engine = {
      type: async (_clip: unknown, visitor: string, text: string, sentence: string) => {
        typed.push({ visitor, text, sent: sentence });
        store.addRule({ id: 'typed-1', clip: CLIP, kind: 'typed', visitor, text, name: text, readsAs: null, status: 'parsing', zones: [] });
        return 'typed-1';
      },
      typed: async () => {
        polls++;
        const status = polls > 1 ? ruleEnds : 'asking';
        const rule = store.rule('typed-1')!;
        return { ...rule, status, reason: status === 'refused' ? 'Two things in order.' : null, rewrites: status === 'refused' ? ['Tell me when someone opens a door.'] : [] };
      },
    };
    const limits = new DemoLimits({ file: join(root, 'limits.json'), ceilingMicroUsd: 5_000_000 });
    const realCharge = limits.charge.bind(limits);
    limits.charge = async (who, kind, cost) => {
      charged.push({ who, kind });
      return realCharge(who, kind, cost);
    };
    const instance = new DemoBot({
      chat,
      links,
      store,
      engine,
      limits,
      cameras: new CameraFolder(root),
      clips: { get: async () => ({ id: CLIP, name: 'Building entrance', width: 1280, height: 720, fps: 10, frames: 600, video: 'v' }) },
      planner: draft,
      voiceNotes: {
        readAudio: async (_bytes: Uint8Array, keywords: string[], beforeAsking?: () => Promise<void>) => {
          await beforeAsking?.();
          heardAudio.push({ keywords });
          return { status: 200, body: { text: heard } };
        },
      },
      alertsOf: () => alerts,
      folder: root,
      page: 'https://example.test',
      abilities,
      wait: async () => undefined,
    });
    return { instance, sent, links, typed, charged, heardAudio, store };
  }

  const linked = async (b: ReturnType<typeof bot>) => {
    await b.instance.handle(message({ text: `/start ${b.links.token(VISITOR, CLIP)}` }));
    b.sent.length = 0;
  };

  it('links through the token the page gave, and says what the chat is for', async () => {
    const b = bot();
    await b.instance.handle(message({ text: `/start ${b.links.token(VISITOR, CLIP)}` }));
    expect(b.links.ofPerson(PERSON)?.visitor).toBe(VISITOR);
    expect(b.sent[0]!.text).toContain('any clip');
    expect(b.sent[0]!.text).not.toMatch(/^Linked to Building entrance/);
    expect(b.sent[0]!.text).toContain('the clip you last opened, which is Building entrance at the moment');
  });

  it('sends someone who found the bot on their own to the page, and spends nothing on them', async () => {
    const b = bot();
    await b.instance.handle(message({ voice: { file_id: 'f', file_size: 100 } }));
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    expect(b.charged).toEqual([]);
    expect(b.heardAudio).toEqual([]);
    expect(b.sent).toHaveLength(2);
    expect(b.sent[0]!.text).toContain('https://example.test');
  });

  it('refuses a link that has been used, and sends them to the page', async () => {
    const b = bot();
    const token = b.links.token(VISITOR, CLIP);
    await b.instance.handle(message({ text: `/start ${token}` }));
    b.sent.length = 0;
    await b.instance.handle(message({ text: `/start ${token}` }, 777));
    expect(b.links.ofPerson(777)).toBeNull();
    expect(b.sent[0]!.text).toContain('has lapsed or has already been used');
    expect(b.sent[0]!.text).toContain('https://example.test');
  });

  it('ignores a group, whoever writes in it', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle({ update_id: 3, message: { from: { id: PERSON }, chat: { id: -99, type: 'group' }, text: 'Tell me when the door opens.' } } as Update);
    expect(b.sent).toEqual([]);
    expect(b.charged).toEqual([]);
  });

  it('reads a voice note back and plans it, listening for the clip’s zones, and spends no rule until it is confirmed', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ voice: { file_id: 'f', file_size: 100 } }));
    expect(b.heardAudio[0]!.keywords).toContain('door');
    expect(b.charged.map((c) => c.kind)).toEqual(['plan', 'plan']);
    expect(b.typed).toEqual([]);
    const plan = b.sent.at(-1)!;
    expect(plan.text).toContain('Tell me when someone opens the door.');
    expect(plan.text).toContain('Building entrance');
    expect(plan.buttons?.map((x) => x.text)).toEqual(['Confirm', 'Cancel']);
  });

  it('says plainly that finding an item is done on the page, and holds nothing to confirm', async () => {
    const b = bot({ draft: { draft: async () => ({ search: { item: 'ladder', words: ['ladder'] } }) } });
    await linked(b);
    await b.instance.handle(message({ text: 'Track the ladder' }));
    const reply = b.sent.at(-1)!;
    expect(reply.text).toContain('Finding and tracking an item is done on the page');
    expect(reply.buttons ?? []).toEqual([]);
  });

  it('counts against the person’s Telegram id, so clearing a cookie resets nothing', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    expect(b.charged[0]!.who).toBe(`telegram:${PERSON}`);
  });

  it('refuses an oversized voice note before fetching it', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ voice: { file_id: 'f', file_size: 9_000_000 } }));
    expect(b.heardAudio).toEqual([]);
    expect(b.charged).toEqual([]);
    expect(b.sent[0]!.text).toContain('8 MB');
  });

  it('on Confirm, reads the rule with the zone’s place in the sentence, under the visitor who linked, then sends its alerts', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    const confirm = b.sent.at(-1)!.buttons![0]!.data;
    await b.instance.handle(button(confirm));
    await b.instance.settled();
    expect(b.typed[0]).toMatchObject({ visitor: VISITOR, text: 'Tell me when the door opens.' });
    expect(b.typed[0]!.sent).toContain('right');
    expect(b.charged.at(-1)).toEqual({ who: `telegram:${PERSON}`, kind: 'rule' });
    expect(b.sent.at(-1)!.text).toContain('🚨 <b>ALERT: BUILDING ENTRANCE</b>\n<b>The door opens</b>');
  });

  it('spends one rule however many times Confirm is pressed', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    const confirm = b.sent.at(-1)!.buttons![0]!.data;
    await b.instance.handle(button(confirm));
    await b.instance.handle(button(confirm));
    await b.instance.settled();
    expect(b.typed).toHaveLength(1);
  });

  it('does not let another person confirm someone’s plan', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    const confirm = b.sent.at(-1)!.buttons![0]!.data;
    await b.instance.handle(button(confirm, 777));
    await b.instance.settled();
    expect(b.typed).toEqual([]);
  });

  it('says so when the rule raises nothing on the clip', async () => {
    const b = bot({ alerts: [] });
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    await b.instance.handle(button(b.sent.at(-1)!.buttons![0]!.data));
    await b.instance.settled();
    expect(b.sent.at(-1)!.text).toContain('raised nothing');
  });

  it('passes on a refusal with the wording Streamatic suggests', async () => {
    const b = bot({ ruleEnds: 'refused' });
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    await b.instance.handle(button(b.sent.at(-1)!.buttons![0]!.data));
    await b.instance.settled();
    const last = b.sent.at(-1)!.text;
    expect(last).toContain('Two things in order.');
    expect(last).toContain('Tell me when someone opens a door.');
  });

  it('plans on the zones as the linked visitor’s page shows them', async () => {
    const b = bot({ draft: { draft: async ({ sentence, zones }) => ({ sentence, about: 'entrance', zones: zones.map((z) => z.name), box: null, hours: null }) } });
    await linked(b);
    b.store.saveZoneEdit(VISITOR, CLIP, { zone: 'door', name: 'entrance' });
    await b.instance.handle(message({ text: 'Tell me when the entrance opens.' }));
    expect(b.sent.at(-1)!.text).toContain('Zones: entrance');
  });

  it('sends a question about the clip to the page, and plans no rule', async () => {
    const b = bot({ draft: { draft: async () => ({ question: true }) } });
    await linked(b);
    await b.instance.handle(message({ text: 'How many people came in?' }));
    expect(b.sent.at(-1)!.text).toContain('Questions about a clip are answered on the page');
    expect(b.sent.at(-1)!.buttons).toBeUndefined();
  });

  it('asks for other words when no plan fits the clip, showing what it holds and no model’s reasoning', async () => {
    const b = bot({ draft: { draft: async ({ sentence }) => ({ sentence, about: 'door', zones: ['gate'], box: null, hours: null }) } });
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    const last = b.sent.at(-1)!;
    expect(last.buttons).toBeUndefined();
    expect(last.text).toContain('door');
    expect(last.text).not.toContain('is not a zone');
  });

  it('says what is missing on a copy with no keys, and spends nothing', async () => {
    const b = bot({ abilities: { models: false, rules: false } });
    await linked(b);
    await b.instance.handle(message({ voice: { file_id: 'f', file_size: 100 } }));
    expect(b.heardAudio).toEqual([]);
    expect(b.charged).toEqual([]);
    expect(b.sent[0]!.text).toContain('Provide your keys');
  });

  it('stops at /stop, which forgets the person', async () => {
    const b = bot();
    await linked(b);
    await b.instance.handle(message({ text: '/stop' }));
    expect(b.links.ofPerson(PERSON)).toBeNull();
  });

  it('keeps going when one message fails, and tells the person', async () => {
    const b = bot({ draft: { draft: async () => { throw new Error('secret internal detail'); } } });
    await linked(b);
    await b.instance.handle(message({ text: 'Tell me when the door opens.' }));
    expect(b.sent.at(-1)!.text).not.toContain('secret internal detail');
    expect(b.sent.at(-1)!.text).toContain('Please try again');
  });
});

describe('no copy of a voice note is kept', () => {
  it('has no route to the disk in the bot', async () => {
    const source = await readFile(new URL('../src/telegram/demo-bot.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/writeFile|createWriteStream/);
  });
});
