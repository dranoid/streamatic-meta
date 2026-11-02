import { describe, expect, it } from 'vitest';
import type { CameraZone } from '../src/cameras/camera-zones.js';
import { checkPlan, planRule, type GuidePlan, type GuidePlanner } from '../src/guide/plan.js';

const outline = (word: string) => ({ word, objectId: '0', box: { left: 0, top: 0, right: 1, bottom: 1 }, path: 'M0 0Z' });
const zones: CameraZone[] = [
  { word: 'gate', name: 'Main gate', outlines: { night: [outline('gate')] } },
  { word: 'auto rickshaw', name: 'auto rickshaw 1', outlines: { day: [outline('auto rickshaw')] } },
  { word: 'yard', name: 'yard', outlines: { day: [outline('yard')] } },
];

const asked = 'Alert me if the main gate is open after 10 pm.';
const gatePlan: GuidePlan = { sentence: asked, about: 'main gate', zones: ['Main gate'], box: null, hours: { from: 22, to: 6 } };

describe('checkPlan', () => {
  it('passes a plan whose zones are on the camera and whose hours are on the clock', () => {
    expect(checkPlan(gatePlan, zones, asked)).toEqual({ passed: true, problems: [] });
  });

  it('names a zone the camera does not have, and the zones it does have', () => {
    const { passed, problems } = checkPlan({ ...gatePlan, zones: ['drain'] }, zones, asked);
    expect(passed).toBe(false);
    expect(problems).toEqual(['"drain" is not a zone on this camera. Its zones are: Main gate, auto rickshaw 1, yard.']);
  });

  it('refuses a plan with no zone and no box, or with more than four', () => {
    expect(checkPlan({ ...gatePlan, zones: [] }, zones, asked).passed).toBe(false);
    expect(checkPlan({ ...gatePlan, zones: ['Main gate', 'yard', 'auto rickshaw 1', 'Main gate', 'yard'] }, zones, asked).passed).toBe(false);
  });

  it('refuses hours that are not whole hours of the day, or that start and end at the same hour', () => {
    expect(checkPlan({ ...gatePlan, hours: { from: 22, to: 24 } }, zones, asked).passed).toBe(false);
    expect(checkPlan({ ...gatePlan, hours: { from: 6, to: 6 } }, zones, asked).passed).toBe(false);
  });

  it('refuses a box without a question, or named like a zone the camera already has', () => {
    expect(checkPlan({ ...gatePlan, zones: [], box: { name: 'doorway', question: '', over: null } }, zones, asked).passed).toBe(false);
    expect(checkPlan({ ...gatePlan, zones: [], box: { name: 'Yard', question: 'Is someone in the yard?', over: null } }, zones, asked).passed).toBe(false);
  });

  it('places a box over a zone the camera has, and refuses one over a zone it does not', () => {
    const box = { name: 'by the gate', question: 'Is a keke parked by the gate?' };
    expect(checkPlan({ ...gatePlan, zones: [], box: { ...box, over: 'Main gate' } }, zones, asked).passed).toBe(true);
    expect(checkPlan({ ...gatePlan, zones: [], box: { ...box, over: 'drain' } }, zones, asked).problems).toEqual([
      'The box is to go over "drain", which is not a zone on this camera. Its zones are: Main gate, auto rickshaw 1, yard.',
    ]);
  });
});

describe('checkPlan on what the rule is about', () => {
  const kekeAsked = 'Tell me when a keke is parked by the main gate after 11 pm.';
  const kekePlan: GuidePlan = { sentence: kekeAsked, about: 'keke', zones: ['Main gate'], box: null, hours: { from: 23, to: 6 } };
  const door: CameraZone = { word: 'door', name: 'front door', outlines: { day: [outline('door')] } };

  it('refuses a zone when the rule is about something else near it', () => {
    expect(checkPlan(kekePlan, zones, kekeAsked).problems).toEqual([
      'The rule is about "keke", but the Main gate zone alerts only when the gate itself changes; watch for "keke" with a box.',
    ]);
  });

  it('passes a box for the thing near the zone', () => {
    const box = { name: 'by the gate', question: 'Is a keke parked in this area?', over: 'Main gate' };
    expect(checkPlan({ ...kekePlan, zones: [], box }, zones, kekeAsked).passed).toBe(true);
  });

  it("passes a zone when the rule is about the zone's outlined word or the name the person gave it", () => {
    const asked = 'Tell me when the front door is left open.';
    expect(checkPlan({ sentence: asked, about: 'door', zones: ['front door'], box: null, hours: null }, [door], asked).passed).toBe(true);
    expect(checkPlan({ sentence: asked, about: 'the front door', zones: ['front door'], box: null, hours: null }, [door], asked).passed).toBe(true);
  });

  it('refuses a zone for a different word than the zone was outlined or named by', () => {
    const asked = 'Tell me when the entrance is left open.';
    const plan: GuidePlan = { sentence: asked, about: 'entrance', zones: ['front door'], box: null, hours: null };
    expect(checkPlan(plan, [door], asked).passed).toBe(false);
  });

  it("refuses what the rule is about when it is not in the person's own words, even if the plan's sentence says it", () => {
    const plan = { ...kekePlan, sentence: 'Alert when the main gate opens after 11 pm.', about: 'gate opening' };
    expect(checkPlan(plan, zones, kekeAsked).problems).toEqual([
      '"gate opening" is not in the request. Give what the alert is about in the request\'s own words.',
    ]);
  });

  it('refuses a plan that does not say what the rule is about', () => {
    expect(checkPlan({ ...kekePlan, about: ' ' }, zones, kekeAsked).problems).toContain('The plan does not say what the alert is about.');
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

    const result = await planRule({ sentence: asked, site: 'an estate gate', zones, planner });

    expect(result).toEqual({ status: 'ready', plan: gatePlan, attempts: [{ plan: gatePlan, problems: [] }] });
  });

  it('hands a refused plan back with what was wrong, and takes the corrected one', async () => {
    const wrong = { ...gatePlan, zones: ['drain'] };
    const { planner, seen } = fakePlanner([wrong, gatePlan]);

    const result = await planRule({ sentence: asked, site: 'an estate gate', zones, planner });

    expect(result.status).toBe('ready');
    expect(seen[1]).toEqual([{ plan: wrong, problems: [checkPlan(wrong, zones, asked).problems[0]] }]);
    expect(result.attempts.map((a) => a.problems.length > 0)).toEqual([true, false]);
  });

  it('stops after three refused plans and asks a person, with what was wrong', async () => {
    const wrong = { ...gatePlan, zones: ['drain'] };
    const { planner, seen } = fakePlanner([wrong]);

    const result = await planRule({ sentence: asked, site: 'an estate gate', zones, planner });

    expect(seen).toHaveLength(3);
    expect(result).toMatchObject({ status: 'needs-person', problems: checkPlan(wrong, zones, asked).problems });
    expect(result.attempts).toHaveLength(3);
  });
});
