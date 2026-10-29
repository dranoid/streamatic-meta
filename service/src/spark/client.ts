import type { z } from 'zod';
import type { LabelledPicture } from '../setup/camera-setup.js';

export interface SparkClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

// Muse Spark Open, Meta's open-weights model, served by Baseten.
const CHAT_URL = 'https://inference.baseten.co/v1/chat/completions';
const MODEL = 'meta-models/muse-spark-open-1026';
const MAX_ATTEMPTS = 6;

export class SparkError extends Error {}

export class SparkClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;

  constructor(options: SparkClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 5_000;
  }

  async json<T>(instruction: string, pictures: LabelledPicture[], shape: z.ZodType<T>): Promise<T> {
    const content = await this.#ask([
      { type: 'text', text: instruction },
      ...pictures.flatMap(({ label, picture }) => [
        { type: 'text', text: `Picture: ${label}` },
        {
          type: 'image_url',
          image_url: { url: `data:${picture.mimeType};base64,${Buffer.from(picture.bytes).toString('base64')}` },
        },
      ]),
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    } catch {
      throw new SparkError(`Muse Spark Open did not reply with JSON: ${content.slice(0, 200)}`);
    }
    const result = shape.safeParse(parsed);
    if (!result.success) {
      throw new SparkError(`Muse Spark Open's reply did not have the asked shape: ${content.slice(0, 200)}`);
    }
    return result.data;
  }

  async #ask(content: unknown[]): Promise<string> {
    // Spark Open always reasons; no effort setting reliably shortens it, so none is sent.
    const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }] });
    for (let attempt = 1; ; attempt++) {
      const response = await this.#fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${this.#apiKey}` },
        body,
      });
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, this.#retryDelayMs * attempt));
        continue;
      }
      if (!response.ok) {
        throw new SparkError(`Muse Spark Open returned ${response.status}.`);
      }
      const reply = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return reply.choices?.[0]?.message?.content ?? '';
    }
  }
}
