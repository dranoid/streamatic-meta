import { buildObjectPrompt } from '@meta-sam/parser';
import { framesFromText, outlinesFromText, type Box, type FollowedFrame, type Outline } from './outlines.js';

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

export interface MediaSize {
  width: number;
  height: number;
}

// What to follow: the box of an outline, or a click on the thing itself. A word is never mixed in; SAM refuses both at once.
export type FollowTarget = { box: Box } | { point: { x: number; y: number } };

const FILES_URL = 'https://api.meta.ai/v1/files';
// SAM reports each object under the id the request gave it, and a request here follows one thing.
const FOLLOWED_ID = 1;

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

  // One click on a picture: the outline of what was clicked, or null when SAM finds nothing there.
  async outlineAt(picture: Picture, size: MediaSize, point: { x: number; y: number }, name: string): Promise<Outline | null> {
    const prompt = buildObjectPrompt({ size, objects: [{ id: FOLLOWED_ID, prompts: [{ points: [point] }] }] });
    const { outlines } = await outlinesFromText(name, await this.#request(picture, prompt));
    return outlines[0] ?? null;
  }

  async upload(video: Uint8Array): Promise<string> {
    const form = new FormData();
    form.set('purpose', 'user_data');
    form.set('file', new Blob([new Uint8Array(video)], { type: 'video/mp4' }), 'clip.mp4');
    const response = await this.#fetch(FILES_URL, { method: 'POST', headers: { Authorization: `Bearer ${this.#apiKey}` }, body: form });
    if (!response.ok) throw new SamError(`SAM 3.1 returned ${response.status} for a video upload.`);
    return ((await response.json()) as { id: string }).id;
  }

  // Follows one thing through an uploaded video, both ways from the frame it was selected on. The reply lists only the
  // frames the thing is on, so onFrames can report how many so far but never how far through the video.
  async track(fileId: string, size: MediaSize, frame: number, target: FollowTarget, onFrames: (seen: number) => void): Promise<FollowedFrame[]> {
    const prompt = 'box' in target
      ? { frame, box: { ...target.box, right: Math.min(target.box.right, size.width), bottom: Math.min(target.box.bottom, size.height) } }
      : { frame, points: [target.point] };
    const body = JSON.stringify({
      model: 'sam-3.1',
      stream: true,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: buildObjectPrompt({ size, objects: [{ id: FOLLOWED_ID, prompts: [prompt] }] }) },
            { type: 'input_video', file_id: fileId },
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
      if (!response.ok || !response.body) throw new SamError(`SAM 3.1 returned ${response.status} for a video.`);
      return framesFromText(await readStream(response.body, onFrames));
    }
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

async function readStream(body: ReadableStream<Uint8Array>, onFrames: (seen: number) => void): Promise<string> {
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let seen = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const event = JSON.parse(line.slice(5)) as { type?: string; delta?: string };
      if (event.type === 'error' || event.type === 'response.failed') throw new SamError('SAM 3.1 could not finish the video.');
      if (event.type !== 'response.output_text.delta') continue;
      text += event.delta ?? '';
      // A frame's marker is only counted once its line has ended, so a marker cut across two deltas is not missed or doubled.
      const finished = text.split('\n').length - 1;
      if (finished !== seen) onFrames((seen = finished));
    }
  }
  return text;
}
