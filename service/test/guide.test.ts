import { describe, expect, it } from 'vitest';
import type { CameraZone } from '../src/cameras/camera-zones.js';
import { checkPlan, planRule, type GuidePlan, type GuidePlanner } from '../src/guide/plan.js';

const outline = (word: string) => ({ word, objectId: '0', box: { left: 0, top: 0, right: 1, bottom: 1 }, path: 'M0 0Z' });
const zones: CameraZone[] = [
  { word: 'gate', name: 'Main gate', outlines: { night: [outline('gate')] } },
  { word: 'auto rickshaw', name: 'auto rickshaw 1', outlines: { day: [outline('auto rickshaw')] } },
  { word: 'yard', name: 'yard', outlines: { day: [outline('yard')] } },
];

const gatePlan: GuidePlan = { sentence: 'Alert me if the main gate is open after 10 pm.', zones: ['Main gate'], box: null, hours: { from: 22, to: 6 } };

describe('checkPlan', () => {
  it('passes a plan whose zones are on the camera and whose hours are on the clock', () => {
    expect(checkPlan(gatePlan, zones)).toEqual({ passed: true, problems: [] });
  });

  it('names a zone the camera does not have, and the zones it does have', () => {
    const { passed, problems } = checkPlan({ ...gatePlan, zones: ['drain'] }, zones);
    expect(passed).toBe(false);
    expect(problems).toEqual(['"drain" is not a zone on this camera. Its zones are: Main gate, auto rickshaw 1, yard.']);
  });

  it('refuses a plan with no zone and no box, or with more than four', () => {
    expect(checkPlan({ ...gatePlan, zones: [] }, zones).passed).toBe(false);
    expect(checkPlan({ ...gatePlan, zones: ['Main gate', 'yard', 'auto rickshaw 1', 'Main gate', 'yard'] }, zones).passed).toBe(false);
  });

  it('refuses hours that are not whole hours of the day, or that start and end at the same hour', () => {
    expect(checkPlan({ ...gatePlan, hours: { from: 22, to: 24 } }, zones).passed).toBe(false);
    expect(checkPlan({ ...gatePlan, hours: { from: 6, to: 6 } }, zones).passed).toBe(false);
  });

  it('refuses a box without a question, or named like a zone the camera already has', () => {
    expect(checkPlan({ ...gatePlan, zones: [], box: { name: 'doorway', question: '', over: null } }, zones).passed).toBe(false);
    expect(checkPlan({ ...gatePlan, zones: [], box: { name: 'Yard', question: 'Is someone in the yard?', over: null } }, zones).passed).toBe(false);
  });

  it('places a box over a zone the camera has, and refuses one over a zone it does not', () => {
    const box = { name: 'by the gate', question: 'Is a keke parked by the gate?' };
    expect(checkPlan({ ...gatePlan, zones: [], box: { ...box, over: 'Main gate' } }, zones).passed).toBe(true);
    expect(checkPlan({ ...gatePlan, zones: [], box: { ...box, over: 'drain' } }, zones).problems).toEqual([
      'The box is to go over "drain", which is not a zone on this camera. Its zones are: Main gate, auto rickshaw 1, yard.',
    ]);
  });
});

function fakePlanner(plans: GuidePlan[]) {
  const seen: Array<Array<{ plan: GuidePlan; problems: string[] }>> = [];
  const planner: GuidePlanner = {
    async draft(_request, refused) {
      seen.push(refused.map((r) => ({ ...r })));
      return plans[Math.min(seen.length - 1, plans.length - 1)]!;
    },
  };
  return { planner, seen };
}

describe('planRule', () => {
  it('returns the first plan that passes the checks', async () => {
    const { planner } = fakePlanner([gatePlan]);

    const result = await planRule({ sentence: gatePlan.sentence, site: 'an estate gate', zones, planner });

    expect(result).toEqual({ status: 'ready', plan: gatePlan, attempts: [{ plan: gatePlan, problems: [] }] });
  });

  it('hands a refused plan back with what was wrong, and takes the corrected one', async () => {
    const wrong = { ...gatePlan, zones: ['drain'] };
    const { planner, seen } = fakePlanner([wrong, gatePlan]);

    const result = await planRule({ sentence: gatePlan.sentence, site: 'an estate gate', zones, planner });

    expect(result.status).toBe('ready');
    expect(seen[1]).toEqual([{ plan: wrong, problems: [checkPlan(wrong, zones).problems[0]] }]);
    expect(result.attempts.map((a) => a.problems.length > 0)).toEqual([true, false]);
  });

  it('stops after three refused plans and asks a person, with what was wrong', async () => {
    const wrong = { ...gatePlan, zones: ['drain'] };
    const { planner, seen } = fakePlanner([wrong]);

    const result = await planRule({ sentence: gatePlan.sentence, site: 'an estate gate', zones, planner });

    expect(seen).toHaveLength(3);
    expect(result).toMatchObject({ status: 'needs-person', problems: checkPlan(wrong, zones).problems });
    expect(result.attempts).toHaveLength(3);
  });
});
