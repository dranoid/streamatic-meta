import { describe, expect, it } from 'vitest';
import { SparkClient } from '../src/spark/client.js';
import { SparkQuestionPlanner } from '../src/spark/question-planner.js';

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
}

const facts = {
  today: 'Thursday 29 October 2026',
  timeZone: 'Africa/Lagos',
  places: [{ camera: 'Table parlour', zone: 'front door' }],
};

describe('SparkQuestionPlanner', () => {
  it('gives Spark Open the question, the date and the watched zones, and returns its plan', async () => {
    let prompt = '';
    const spark = new SparkClient({
      apiKey: 'test',
      fetch: async (_u, init) => {
        prompt = JSON.parse(String(init?.body)).messages[0].content[0].text;
        return reply('{"tool":"count","camera":null,"zone":"front door","period":"yesterday","hours":{"from":22,"to":6}}');
      },
    });

    const plan = await new SparkQuestionPlanner(spark).plan('How often was the front door opened after 10 pm yesterday?', facts);

    expect(plan).toEqual({ tool: 'count', camera: null, zone: 'front door', period: 'yesterday', hours: { from: 22, to: 6 } });
    expect(prompt).toContain('How often was the front door opened after 10 pm yesterday?');
    expect(prompt).toContain('Thursday 29 October 2026');
    expect(prompt).toContain('"front door" on camera "Table parlour"');
  });

  it('refuses a period it was not offered', async () => {
    const spark = new SparkClient({
      apiKey: 'test',
      fetch: async () => reply('{"tool":"count","camera":null,"zone":"front door","period":"last month","hours":null}'),
    });

    await expect(new SparkQuestionPlanner(spark).plan('Last month?', facts)).rejects.toThrow(/shape/);
  });
});
