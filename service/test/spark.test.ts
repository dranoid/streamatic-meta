import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SparkClient } from '../src/spark/client.js';
import { SparkAlertCaption } from '../src/spark/alert-caption.js';
import { SparkSetupPlanner } from '../src/spark/setup-planner.js';

function reply(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status });
}

const pictures = [
  { label: 'day', picture: { bytes: Uint8Array.of(0xff, 0xd8, 0xff), mimeType: 'image/jpeg' as const } },
  { label: 'night', picture: { bytes: Uint8Array.of(0xff, 0xd8, 0xfe), mimeType: 'image/jpeg' as const } },
];

describe('SparkClient.json', () => {
  it('asks Muse Spark Open on Baseten, labelling each picture', async () => {
    let sent: any;
    let url = '';
    let auth = '';
    const spark = new SparkClient({
      apiKey: 'test',
      fetch: async (u, init) => {
        url = String(u);
        auth = new Headers(init?.headers).get('Authorization') ?? '';
        sent = JSON.parse(String(init?.body));
        return reply('{"items":["gate"]}');
      },
    });

    const answer = await spark.json('List things.', pictures, z.object({ items: z.array(z.string()) }));

    expect(answer).toEqual({ items: ['gate'] });
    expect(url).toBe('https://inference.baseten.co/v1/chat/completions');
    expect(auth).toBe('Api-Key test');
    expect(sent.model).toBe('meta-models/muse-spark-open-1026');
    expect(sent.messages[0].content).toEqual([
      { type: 'text', text: 'List things.' },
      { type: 'text', text: 'Picture: day' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } },
      { type: 'text', text: 'Picture: night' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j+' } },
    ]);
  });

  it('reads JSON wrapped in a code fence', async () => {
    const spark = new SparkClient({ apiKey: 'test', fetch: async () => reply('```json\n{"items":["gate"]}\n```') });

    await expect(spark.json('List.', [], z.object({ items: z.array(z.string()) }))).resolves.toEqual({ items: ['gate'] });
  });

  it('fails when the reply does not have the asked shape', async () => {
    const spark = new SparkClient({ apiKey: 'test', fetch: async () => reply('{"things":"gate"}') });

    await expect(spark.json('List.', [], z.object({ items: z.array(z.string()) }))).rejects.toThrow(/shape/);
  });

  it('waits and tries again when rate-limited', async () => {
    const statuses = [429, 200];
    const spark = new SparkClient({
      apiKey: 'test',
      retryDelayMs: 0,
      fetch: async () => reply('{"items":[]}', statuses.shift()),
    });

    await expect(spark.json('List.', [], z.object({ items: z.array(z.string()) }))).resolves.toEqual({ items: [] });
  });
});

describe('SparkSetupPlanner', () => {
  it("names the site in the rules prompt and passes Spark's rules through", async () => {
    let prompt = '';
    const spark = new SparkClient({
      apiKey: 'test',
      fetch: async (_url, init) => {
        prompt = JSON.parse(String(init?.body)).messages[0].content[0].text;
        return reply('{"rules":[{"sentence":"Alert me if the gate is open after 10 pm.","zones":["gate"]}]}');
      },
    });

    const rules = await new SparkSetupPlanner(spark, 'a residential street gate').proposeRules(
      [{ name: 'gate', seenAt: ['day', 'night'] }],
      pictures,
    );

    expect(prompt).toContain('a residential street gate');
    expect(prompt).toContain('gate (seen: day, night)');
    expect(rules).toEqual([{ sentence: 'Alert me if the gate is open after 10 pm.', zones: ['gate'] }]);
  });
});

describe('SparkAlertCaption', () => {
  const asked: string[] = [];
  const spark = { json: (async (instruction: string, pictures: unknown[], shape: z.ZodType) => (asked.push(instruction), expect(pictures).toEqual([]), shape.parse({ caption: ' Person don open the door. ' }))) as never };

  it('asks for the language chosen, from the rule alone', async () => {
    const caption = await new SparkAlertCaption(spark).write('Someone opens the door', 'pidgin');
    expect(caption).toBe('Person don open the door.');
    expect(asked.at(-1)).toContain('Nigerian Pidgin');
    expect(asked.at(-1)).toContain('Someone opens the door');
  });

  it('asks for fixed text the software sends, so a rule worded as a request is not read as a doubt', async () => {
    await new SparkAlertCaption(spark).write('Tell me when someone is opening the front door.', 'pidgin');
    expect(asked.at(-1)).toMatch(/fixed notice text/);
    expect(asked.at(-1)).toMatch(/claims nothing about this moment/);
    expect(asked.at(-1)).toMatch(/never say it is unknown/i);
  });

  it('refuses a Yoruba caption left in English, so that it is not kept', async () => {
    await expect(new SparkAlertCaption(spark).write('Someone opens the door', 'yoruba')).rejects.toThrow(/Yoruba/);
    const yoruba = { json: (async (_: string, __: unknown[], shape: z.ZodType) => shape.parse({ caption: 'Ẹnìkan ṣí ìlẹ̀kùn.' })) as never };
    expect(await new SparkAlertCaption(yoruba).write('Someone opens the door', 'yoruba')).toBe('Ẹnìkan ṣí ìlẹ̀kùn.');
  });

  it('asks for Yoruba with its marks', async () => {
    await new SparkAlertCaption(spark).write('Someone opens the door', 'yoruba').catch(() => null);
    expect(asked.at(-1)).toContain('Yoruba, with its proper tone marks');
  });
});
