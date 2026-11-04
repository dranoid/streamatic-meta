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

// How many rounds of tool calls before tools are withdrawn and the model must answer.
const MOST_TOOL_ROUNDS = 4;

export class SparkError extends Error {}

// The model answered in words where JSON was asked for, which is how it declines a request.
export class SparkDeclined extends SparkError {}

export interface SparkTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface SparkMessage {
  content?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

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
      throw new SparkDeclined(`Muse Spark Open did not reply with JSON: ${content.slice(0, 200)}`);
    }
    const result = shape.safeParse(parsed);
    if (!result.success) {
      throw new SparkError(`Muse Spark Open's reply did not have the asked shape: ${content.slice(0, 200)}`);
    }
    return result.data;
  }

  // Each tool call is run here and its result sent back, until the model answers in words.
  async withTools(instruction: string, tools: SparkTool[], run: (name: string, args: unknown) => Promise<unknown>): Promise<string> {
    const messages: unknown[] = [{ role: 'user', content: instruction }];
    const offered = tools.map((tool) => ({ type: 'function', function: tool }));
    for (let round = 0; ; round++) {
      const canCall = round < MOST_TOOL_ROUNDS;
      const reply = await this.#send({ model: MODEL, messages, ...(canCall ? { tools: offered } : {}) });
      if (!canCall || !reply.tool_calls?.length) return reply.content ?? '';
      messages.push(reply);
      for (const call of reply.tool_calls) {
        const result = await this.#runTool(call.function, run);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  }

  async #runTool({ name, arguments: args }: { name: string; arguments: string }, run: (name: string, args: unknown) => Promise<unknown>): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return { error: 'The arguments could not be read.' };
    }
    return run(name, parsed);
  }

  async #ask(content: unknown[]): Promise<string> {
    return (await this.#send({ model: MODEL, messages: [{ role: 'user', content }] })).content ?? '';
  }

  async #send(request: unknown): Promise<SparkMessage> {
    // Spark Open always reasons; no effort setting reliably shortens it, so none is sent.
    const body = JSON.stringify(request);
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
      const reply = (await response.json()) as { choices?: Array<{ message?: SparkMessage }> };
      return reply.choices?.[0]?.message ?? {};
    }
  }
}
