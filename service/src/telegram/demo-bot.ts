import { randomUUID } from 'node:crypto';
import type { CameraFolder } from '../cameras/camera-folder.js';
import { COST_MICRO_USD, NEEDS_BACKEND, NEEDS_KEYS } from '../demo/routes.js';
import type { DemoEngine } from '../demo/engine.js';
import type { DemoLimits, Spending } from '../demo/limits.js';
import { placedBox, ruleFromPlan } from '../demo/rule-plan.js';
import { withZoneEdits } from '../demo/visitor-zones.js';
import type { DemoAlert, DemoStore } from '../demo/store.js';
import type { ClipFolder } from '../follow/clips.js';
import { planRule, type GuidePlan, type GuidePlanner } from '../guide/plan.js';
import { voiceKeywords, type VoiceNotes } from '../voice/voice-note.js';
import type { BotChat, Update } from './api.js';
import { sendDemoAlert } from './demo-alert.js';
import type { TelegramLink, TelegramLinks } from './links.js';

const MAX_VOICE_BYTES = 8_000_000;
const POLL_MS = 5_000;
// A rule that has not finished by then is reported as unfinished, so the wait does not run for ever.
const MAX_POLLS = 180;
const MAX_ALERTS_SENT = 5;
const FINAL = new Set(['ready', 'refused', 'failed']);
const TRY_AGAIN = 'That could not be completed. Please try again.';

class Refused extends Error {}

interface Held {
  id: string;
  clip: string;
  plan: GuidePlan;
}

export interface DemoBotOptions {
  chat: BotChat;
  links: TelegramLinks;
  store: Pick<DemoStore, 'clip' | 'rule' | 'zoneEdits'>;
  engine: Pick<DemoEngine, 'type' | 'typed'>;
  limits: Pick<DemoLimits, 'charge'>;
  cameras: Pick<CameraFolder, 'get'>;
  clips: Pick<ClipFolder, 'get'>;
  planner: GuidePlanner;
  voiceNotes: Pick<VoiceNotes, 'readAudio'>;
  alertsOf: (rule: string) => DemoAlert[];
  folder: string;
  page: string | null;
  abilities: { models: boolean; rules: boolean };
  wait?: (ms: number) => Promise<void>;
}

// The chat a visitor links from the page: a voice note or a sentence becomes a plan, and a confirmed plan a rule whose alerts
// come back here. Only what the page already does is done here, under the same limits, counted on the person's Telegram number.
export class DemoBot {
  readonly #options: DemoBotOptions;
  readonly #held = new Map<number, Held>();
  readonly #busy = new Set<number>();
  readonly #following = new Set<Promise<void>>();

  constructor(options: DemoBotOptions) {
    this.#options = options;
  }

  // Once every rule being read has finished; a confirmed rule goes on being read after its button press is answered.
  async settled(): Promise<void> {
    await Promise.all(this.#following);
  }

  async handle(update: Update): Promise<void> {
    const person = update.message?.from?.id ?? update.callback_query?.from.id;
    if (person === undefined) return;
    try {
      if (update.callback_query) await this.#pressed(person, update.callback_query.id, update.callback_query.data ?? '');
      else if (update.message?.chat.type === 'private') await this.#message(person, update.message);
    } catch (error) {
      if (error instanceof Refused) return void (await this.#say(person, error.message));
      console.error(`Telegram message: ${error instanceof Error ? error.message : String(error)}`);
      await this.#say(person, TRY_AGAIN);
    }
  }

  async #say(person: number, text: string, buttons?: Array<{ text: string; data: string }>): Promise<void> {
    await this.#options.chat.sendText(person, text, buttons).catch((error: unknown) => console.error(`Telegram send: ${error instanceof Error ? error.message : String(error)}`));
  }

  #toThePage(): string {
    return `To use this chat, open a clip on the Streamatic page and select “Send alerts to Telegram”.${this.#options.page ? ` ${this.#options.page}` : ''}`;
  }

  #linkLapsed(): string {
    return `This link has lapsed or has already been used, so this chat is not linked. Please select “Send alerts to Telegram” on the clip again.${this.#options.page ? ` ${this.#options.page}` : ''}`;
  }

  async #charge(person: number, kind: Spending): Promise<void> {
    const reached = await this.#options.limits.charge(`telegram:${person}`, kind, COST_MICRO_USD[kind]);
    if (reached) throw new Refused(reached);
  }

  async #message(person: number, message: NonNullable<Update['message']>): Promise<void> {
    const { links, abilities } = this.#options;
    const text = message.text?.trim() ?? '';
    if (text.startsWith('/start')) {
      const token = text.slice('/start'.length).trim();
      if (token && links.claim(token, person)) return this.#greet(person);
      if (links.ofPerson(person)) return this.#greet(person);
      return this.#say(person, token ? this.#linkLapsed() : this.#toThePage());
    }
    const link = links.ofPerson(person);
    if (!link) return this.#say(person, this.#toThePage());
    if (text === '/stop') {
      links.unlink(link.visitor);
      return this.#say(person, 'Alerts to this chat have stopped. You can link it again from the page.');
    }
    const voice = message.voice ?? message.audio;
    if (!voice && !text) return this.#say(person, 'Please send a voice note or a sentence.');
    if (!abilities.models) return this.#say(person, NEEDS_KEYS);
    if ((voice?.file_size ?? 0) > MAX_VOICE_BYTES) return this.#say(person, 'That voice note is too large. Please choose one under 8 MB.');
    if (this.#busy.has(person)) return this.#say(person, 'The previous message is still being worked on. Please wait for its reply.');
    this.#busy.add(person);
    try {
      await this.#plan(person, link, voice ? await this.#heard(person, link, voice.file_id) : text);
    } finally {
      this.#busy.delete(person);
    }
  }

  async #greet(person: number): Promise<void> {
    const link = this.#options.links.ofPerson(person)!;
    const name = (await this.#options.clips.get(link.clip))?.name ?? 'the clip';
    await this.#say(person, `Linked to ${name}. Alerts from the rules you tick on the page will arrive here as the clip plays. You can also send a voice note in English, or a sentence, here to add a rule to this clip. Send /stop to end this.`);
  }

  // The camera with the zones as the person's page shows them.
  async #camera(link: TelegramLink) {
    const camera = await this.#options.cameras.get(link.clip);
    return camera && withZoneEdits(camera, this.#options.store.zoneEdits(link.visitor, link.clip));
  }

  async #heard(person: number, link: TelegramLink, file: string): Promise<string> {
    const camera = await this.#camera(link);
    const reply = await this.#options.voiceNotes.readAudio(await this.#options.chat.download(file), voiceKeywords(camera?.zones ?? []), () => this.#charge(person, 'plan'));
    if ('error' in reply.body) throw new Refused(reply.body.error);
    return reply.body.text;
  }

  async #plan(person: number, link: TelegramLink, sentence: string): Promise<void> {
    const { clips, planner } = this.#options;
    const clip = await clips.get(link.clip);
    const camera = await this.#camera(link);
    if (!clip || !camera) throw new Refused('That clip is no longer available. Please link this chat from the page again.');
    if (sentence.length < 3 || sentence.length > 300) throw new Refused('Please say what to watch in one sentence.');
    await this.#charge(person, 'plan');
    const result = await planRule({ sentence, site: camera.site, zones: camera.zones, planner });
    if (result.status === 'search') {
      return this.#say(person, `You said: ${sentence}\n\nFinding and tracking an item is done on the page, on the clip. In this chat, please say what ${clip.name} should alert you about.`);
    }
    if (result.status !== 'ready') {
      return this.#say(person, `You said: ${sentence}\n\nA rule for this could not be planned on ${clip.name}. It holds: ${camera.zones.map((z) => z.name).join(', ')}. Please say it another way.`);
    }
    const plan = placedBox(result.plan, camera.zones);
    const id = randomUUID().slice(0, 8);
    this.#held.set(person, { id, clip: link.clip, plan });
    const lines = [
      clip.name,
      `You said: ${sentence}`,
      `Watches for: ${plan.about}`,
      ...(plan.zones.length ? [`Zones: ${plan.zones.join(', ')}`] : []),
      ...(plan.box ? [`A box${plan.box.over ? ` over the ${plan.box.over}` : ''}: ${plan.box.question}`] : []),
      'Select Confirm to read this rule over the clip, or Cancel and send it again if a word is wrong.',
    ];
    await this.#say(person, lines.join('\n'), [
      { text: 'Confirm', data: `confirm:${id}` },
      { text: 'Cancel', data: `cancel:${id}` },
    ]);
  }

  async #pressed(person: number, press: string, data: string): Promise<void> {
    const { chat, links, abilities, store, engine, clips } = this.#options;
    await chat.answer(press).catch(() => undefined);
    const link = links.ofPerson(person);
    if (!link) return this.#say(person, this.#toThePage());
    const [action, id] = data.split(':');
    const held = this.#held.get(person);
    if (!held || held.id !== id) return this.#say(person, 'That plan is no longer open. Please send it again.');
    this.#held.delete(person);
    if (action !== 'confirm') return this.#say(person, 'Cancelled.');
    if (!abilities.rules) return this.#say(person, NEEDS_BACKEND);
    const row = store.clip(held.clip);
    const clip = await clips.get(held.clip);
    const camera = await this.#camera({ ...link, clip: held.clip });
    const made = clip && camera ? ruleFromPlan(held.plan, camera.zones, clip) : null;
    if (!row || !made) throw new Refused('That plan does not fit this clip. Please send it again.');
    await this.#charge(person, 'rule');
    const rule = await engine.type(row, link.visitor, held.plan.sentence, made.sent, made.zones);
    await this.#say(person, 'Reading the rule over the clip. This can take some minutes. Its alerts will arrive here.');
    const following = this.#follow(person, link, row, rule)
      .catch(async (error: unknown) => {
        console.error(`Telegram rule: ${error instanceof Error ? error.message : String(error)}`);
        await this.#say(person, TRY_AGAIN);
      })
      .finally(() => this.#following.delete(following));
    this.#following.add(following);
  }

  async #follow(person: number, link: TelegramLink, row: NonNullable<ReturnType<DemoStore['clip']>>, id: string): Promise<void> {
    const { engine, links, alertsOf, chat, folder, clips, wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = this.#options;
    let rule = await engine.typed(row, link.visitor, id);
    for (let polls = 0; rule && !FINAL.has(rule.status) && polls < MAX_POLLS; polls++) {
      await wait(POLL_MS);
      rule = await engine.typed(row, link.visitor, id);
    }
    if (rule?.status === 'refused') {
      const others = rule.rewrites.length ? `\n\nYou could say:\n${rule.rewrites.join('\n')}` : '';
      return this.#say(person, `${rule.reason ?? 'Streamatic cannot watch for this as written.'}${others}`);
    }
    if (rule?.status !== 'ready') return this.#say(person, 'This rule could not be finished. Please try again.');
    const clip = await clips.get(row.id);
    if (!clip) return;
    const alerts = alertsOf(id);
    if (!rule.canAnswer) await this.#say(person, 'Streamatic may not be able to see this on this clip. The rule still ran.');
    if (alerts.length === 0) return this.#say(person, `${clip.name}\nThis rule raised nothing on this clip.`);
    const language = links.ofPerson(person)?.language ?? link.language;
    for (const alert of alerts.slice(0, MAX_ALERTS_SENT)) await sendDemoAlert({ chat, to: person, folder, clip, rule, alert, language });
  }
}
