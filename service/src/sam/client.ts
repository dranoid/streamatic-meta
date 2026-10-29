import { outlinesFromText, type Outline } from './outlines.js';

export interface Picture {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface SamClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

const RESPONSES_URL = 'https://api.meta.ai/v1/responses';
const MAX_ATTEMPTS = 6;
// Six calls at once drew 429s on 49 of 110; two at a time with retries drew none.
const CONCURRENCY = 2;

export class SamError extends Error {}

export class SamClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;

  constructor(options: SamClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
  }

  async outline(picture: Picture, word: string): Promise<Outline[]> {
    const phrase = word.trim();
    if (phrase === '') {
      throw new SamError('SAM 3.1 needs a word naming what to outline.');
    }
    const text = await this.#request(picture, phrase);
    const { outlines, diagnostics } = await outlinesFromText(phrase, text);
    const dropped = diagnostics.filter((d) => d.severity === 'error');
    if (dropped.length > 0) {
      throw new SamError(`SAM 3.1 reply for "${phrase}" had unreadable records: ${dropped[0]!.message}`);
    }
    return outlines;
  }

  async outlineAll(picture: Picture, words: string[]): Promise<Record<string, Outline[]>> {
    const found: Record<string, Outline[]> = {};
    const queue = [...words];
    const worker = async () => {
      for (let word = queue.shift(); word !== undefined; word = queue.shift()) {
        found[word] = await this.outline(picture, word);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, words.length) }, worker));
    return Object.fromEntries(words.map((w) => [w, found[w] ?? []]));
  }

  async #request(picture: Picture, phrase: string): Promise<string> {
    const body = JSON.stringify({
      model: 'sam-3.1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: phrase },
            { type: 'input_image', image_url: `data:${picture.mimeType};base64,${Buffer.from(picture.bytes).toString('base64')}` },
          ],
        },
      ],
    });
    for (let attempt = 1; ; attempt++) {
      const response = await this.#fetch(RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}` },
        body,
      });
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, this.#retryDelayMs * attempt));
        continue;
      }
      if (!response.ok) {
        throw new SamError(`SAM 3.1 returned ${response.status} for "${phrase}".`);
      }
      const reply = (await response.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> };
      return (reply.output ?? []).flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('');
    }
  }
}
