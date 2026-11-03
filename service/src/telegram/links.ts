import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CaptionLanguage } from '../spark/alert-caption.js';

export type AlertLanguage = 'english' | CaptionLanguage;

export interface TelegramLink {
  // Telegram's own number for the person: it comes with every message, so nobody can claim to be someone else, as a typed name would allow.
  person: number;
  visitor: string;
  clip: string;
  language: AlertLanguage;
}

interface Pending {
  token: string;
  visitor: string;
  clip: string;
  until: number;
}

const LINK_LASTS_MS = 15 * 60 * 1000;
// A link about to be opened should have time to reach Start, so one nearer its end than this is replaced. The old one keeps working until it lapses, as it may already be open.
const LINK_GIVEN_WITH_AT_LEAST_MS = 5 * 60 * 1000;

// Who on the page is who on Telegram. A link is made only from the page, whose small print a person has then had in front of them.
export class TelegramLinks {
  readonly #db: DatabaseSync;
  readonly #pending = new Map<string, Pending>();

  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.#db = new DatabaseSync(file);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS telegram_links (
      person INTEGER PRIMARY KEY, visitor TEXT NOT NULL UNIQUE, clip TEXT NOT NULL, language TEXT NOT NULL
    )`);
  }

  token(visitor: string, clip: string): string {
    const now = this.now();
    for (const [token, { until }] of this.#pending) if (until <= now) this.#pending.delete(token);
    const held = [...this.#pending.values()].find((p) => p.visitor === visitor && p.clip === clip && p.until - now >= LINK_GIVEN_WITH_AT_LEAST_MS);
    if (held) return held.token;
    const token = randomBytes(16).toString('base64url');
    this.#pending.set(token, { token, visitor, clip, until: now + LINK_LASTS_MS });
    return token;
  }

  // One use: a link forwarded to someone else after that does nothing.
  claim(token: string, person: number): boolean {
    const held = this.#pending.get(token);
    if (!held || held.until <= this.now()) return false;
    for (const [other, { visitor }] of this.#pending) if (visitor === held.visitor) this.#pending.delete(other);
    this.#db.prepare('DELETE FROM telegram_links WHERE person = ? OR visitor = ?').run(person, held.visitor);
    this.#db.prepare('INSERT INTO telegram_links (person, visitor, clip, language) VALUES (?, ?, ?, ?)').run(person, held.visitor, held.clip, 'english');
    return true;
  }

  ofVisitor(visitor: string): TelegramLink | null {
    return (this.#db.prepare('SELECT * FROM telegram_links WHERE visitor = ?').get(visitor) as unknown as TelegramLink | undefined) ?? null;
  }

  ofPerson(person: number): TelegramLink | null {
    return (this.#db.prepare('SELECT * FROM telegram_links WHERE person = ?').get(person) as unknown as TelegramLink | undefined) ?? null;
  }

  choose(visitor: string, clip: string, language: AlertLanguage): void {
    this.#db.prepare('UPDATE telegram_links SET clip = ?, language = ? WHERE visitor = ?').run(clip, language, visitor);
  }

  unlink(visitor: string): void {
    this.#db.prepare('DELETE FROM telegram_links WHERE visitor = ?').run(visitor);
  }
}
