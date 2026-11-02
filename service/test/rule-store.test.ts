import { describe, expect, it } from 'vitest';
import { RuleStore, zoneRule, type NewRule } from '../src/rules/rule-store.js';

const door: NewRule = {
  camera: 'table-parlour',
  sentence: 'Alert me if the front door opens after 9 pm.',
  zones: [{ name: 'front door', kind: 'outline', word: 'door', reference: { left: 869, top: 317, right: 1053, bottom: 592 }, path: 'M869 317Z' }],
  activeHours: { from: 21, to: 6 },
  settledBy: 'one-picture',
};

const gate: NewRule = {
  camera: 'amosu',
  sentence: 'Tell me when a car is parked across the gate.',
  zones: [{ name: 'gate', kind: 'box', box: { left: 10, top: 20, right: 30, bottom: 40 }, question: 'Is a car parked across the gate?' }],
  activeHours: null,
  settledBy: 'one-picture',
};

describe('RuleStore', () => {
  it('returns a saved rule as it was given, with its id', () => {
    const rules = new RuleStore(':memory:');
    const id = rules.add(door);
    expect(rules.get(id)).toEqual({ id, ...door });
  });

  it('lists the rules of one camera, or of all cameras, oldest first', () => {
    const rules = new RuleStore(':memory:');
    const first = rules.add(door);
    const second = rules.add(gate);
    const third = rules.add({ ...door, sentence: 'Alert me if the front door opens.' , activeHours: null });
    expect(rules.list('table-parlour').map((r) => r.id)).toEqual([first, third]);
    expect(rules.list().map((r) => r.id)).toEqual([first, second, third]);
  });

  it('removes only the rule asked for', () => {
    const rules = new RuleStore(':memory:');
    const kept = rules.add(door);
    const removed = rules.add(gate);
    expect(rules.remove(removed)).toBe(true);
    expect(rules.remove(removed)).toBe(false);
    expect(rules.list().map((r) => r.id)).toEqual([kept]);
  });
});

describe('zoneRule', () => {
  it('judges one picture when one picture settles the rule, and three pictures 3 s or 10 s apart for a brief change or a change', () => {
    const timing = (settledBy: NewRule['settledBy']) => {
      const { samples, sampleGapMs } = zoneRule({ id: 1, ...door, settledBy });
      return [samples, sampleGapMs];
    };
    expect([timing('one-picture'), timing('brief-change'), timing('change')]).toEqual([
      [1, 0],
      [3, 3_000],
      [3, 10_000],
    ]);
  });
});
