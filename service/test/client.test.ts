import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SamClient } from '../src/sam/client.js';

const amosuNightGate = readFileSync(new URL('./fixtures/amosu-night-gate.txt', import.meta.url), 'utf8');
const picture = { bytes: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' as const };

function reply(status: number, text = ''): Response {
  const body = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
  return new Response(JSON.stringify(status === 200 ? body : { error: { message: 'busy' } }), { status });
}

describe('SamClient.outline', () => {
  it('sends the word and the picture, and returns the outlines', async () => {
    const sent: unknown[] = [];
    const client = new SamClient({
      apiKey: 'test',
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return reply(200, amosuNightGate);
      },
    });

    const outlines = await client.outline(picture, 'gate');

    expect(outlines).toHaveLength(2);
    expect(sent).toEqual([
      {
        model: 'sam-3.1',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'gate' },
              { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/' },
            ],
          },
        ],
      },
    ]);
  });

  it('waits and tries again when the API is rate-limited', async () => {
    const statuses = [429, 429, 200];
    const client = new SamClient({
      apiKey: 'test',
      retryDelayMs: 0,
      fetch: async () => reply(statuses.shift()!, amosuNightGate),
    });

    await expect(client.outline(picture, 'gate')).resolves.toHaveLength(2);
    expect(statuses).toEqual([]);
  });

  it('fails on any other error status without retrying', async () => {
    let calls = 0;
    const client = new SamClient({
      apiKey: 'test',
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return reply(400);
      },
    });

    await expect(client.outline(picture, 'gate')).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('refuses an empty word before calling the API, since SAM 3.1 needs one', async () => {
    let calls = 0;
    const client = new SamClient({ apiKey: 'test', fetch: async () => (calls++, reply(200)) });

    await expect(client.outline(picture, '  ')).rejects.toThrow(/word/);
    expect(calls).toBe(0);
  });
});

describe('SamClient.outlineAll', () => {
  it('outlines every word, never more than two calls at a time', async () => {
    let running = 0;
    let most = 0;
    const client = new SamClient({
      apiKey: 'test',
      fetch: async (_url, init) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        const word = JSON.parse(String(init?.body)).input[0].content[0].text;
        return reply(200, word === 'gate' ? amosuNightGate : '');
      },
    });

    const found = await client.outlineAll(picture, ['gate', 'wall', 'keke', 'car', 'person']);

    expect(most).toBe(2);
    expect(Object.fromEntries(Object.entries(found).map(([w, o]) => [w, o.length]))).toEqual({
      gate: 2,
      wall: 0,
      keke: 0,
      car: 0,
      person: 0,
    });
  });
});
