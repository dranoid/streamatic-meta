import { describe, expect, it } from 'vitest';
import { EventStore, type NewEvent } from '../src/events/store.js';
import { answerQuestion, type Plan, type QuestionPlanner } from '../src/questions/answer.js';

// 29 October 2026, 18:00 in Lagos.
const NOW = Date.UTC(2026, 9, 29, 17, 0, 0);
const lagos = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 1, minute);

function event(at: number, zone = 'front door', camera = 'Table parlour'): NewEvent {
  return { camera, zone, rule: `Alert me if the ${zone} opens.`, at, picture: null, clip: null, outline: null, reference: null };
}

function seeded() {
  const store = new EventStore(':memory:', 'Africa/Lagos');
  store.add(event(lagos(28, 21, 24)));
  store.add(event(lagos(28, 23, 10)));
  store.add(event(lagos(29, 0, 30)));
  store.add(event(lagos(29, 14, 0)));
  store.add(event(lagos(20, 23, 0)));
  store.add(event(lagos(28, 3, 0)));
  store.add(event(lagos(28, 23, 30), 'gate', 'Amosu'));
  return store;
}

function planner(plan: Plan) {
  const seen: Array<Parameters<QuestionPlanner['plan']>[1]> = [];
  return { seen, async plan(_question: string, facts: Parameters<QuestionPlanner['plan']>[1]) { seen.push(facts); return plan; } };
}

const ask = (store: EventStore, plan: Plan, question = 'How many times was the front door opened after 10 pm yesterday?') => {
  const fake = planner(plan);
  return answerQuestion({ question, store, planner: fake, now: NOW, timeZone: 'Africa/Lagos' }).then((a) => ({ ...a, fake }));
};

describe('answerQuestion', () => {
  it('counts in the database over the night that began on the named day, and links every event it counted', async () => {
    const store = seeded();
    const answer = await ask(store, { tool: 'count', zone: 'front door', camera: null, period: 'yesterday', hours: { from: 22, to: 6 } });
    // "After 10 pm yesterday" is the night of 28 October: 23:10 and 00:30 on the 29th, not 03:00 on the 28th.
    expect(answer.count).toBe(2);
    expect(answer.events.map((e) => e.at)).toEqual([lagos(29, 0, 30), lagos(28, 23, 10)]);
    expect(answer.text).toContain('2 times');
  });

  it('gives Spark the date and the zones that have events, rather than leaving it to guess them', async () => {
    const { fake } = await ask(seeded(), { tool: 'count', zone: 'front door', camera: null, period: 'today', hours: null });
    expect(fake.seen[0]).toMatchObject({
      today: 'Thursday 29 October 2026',
      places: expect.arrayContaining([{ camera: 'Amosu', zone: 'gate' }, { camera: 'Table parlour', zone: 'front door' }]),
    });
  });

  it('covers the last seven local days for "last 7 days", newest event first', async () => {
    const answer = await ask(seeded(), { tool: 'list', zone: 'front door', camera: null, period: 'last 7 days', hours: null });
    expect(answer.events.map((e) => e.at)).toEqual([lagos(29, 14, 0), lagos(29, 0, 30), lagos(28, 23, 10), lagos(28, 21, 24), lagos(28, 3, 0)]);
  });

  it('says no rule watches a zone it has no events for, instead of answering zero', async () => {
    const answer = await ask(seeded(), { tool: 'count', zone: 'back gate', camera: null, period: 'all', hours: null });
    expect(answer.count).toBeNull();
    expect(answer.text).toMatch(/back gate/);
    expect(answer.events).toEqual([]);
  });

  it('declines a question the events cannot answer, with Spark\'s reason', async () => {
    const answer = await ask(seeded(), { tool: 'none', zone: null, camera: null, period: 'all', hours: null, reason: 'The events record doors and gates, not weather.' });
    expect(answer.count).toBeNull();
    expect(answer.text).toBe('The events record doors and gates, not weather.');
  });
});
