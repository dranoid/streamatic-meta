import { sentenceWithPlaces } from '../backend/place.js';
import type { CameraZone } from '../cameras/camera-zones.js';
import { checkPlan, type GuidePlan } from '../guide/plan.js';
import type { Box } from '../sam/outlines.js';
import type { RuleZone } from './store.js';

const boxPath = ({ left, top, right, bottom }: Box) => `M${left} ${top}H${right}V${bottom}H${left}Z`;
export const zonePaths = (zone: Pick<CameraZone, 'outlines'>) => Object.values(zone.outlines).flat().map((o) => o.path);
const zoneBoxOf = (zone: CameraZone): Box => Object.values(zone.outlines).flat()[0]!.box;

// On a clip nobody can draw, so a box the plan left unplaced goes over the one zone its sentence names, if it names one.
export function placedBox(plan: GuidePlan, zones: CameraZone[]): GuidePlan {
  if (!plan.box || plan.box.over !== null) return plan;
  const said = new Set(plan.sentence.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const named = zones.filter((z) => z.word.toLowerCase().split(/\s+/).every((w) => said.has(w)));
  // Two zones under one word could be either, and a wrong place in the sentence is worse than none.
  return named.length === 1 ? { ...plan, box: { ...plan.box, over: named[0]!.name } } : plan;
}

// What a planned rule sends: each zone's place is written into the sentence, and its outlines go to the player. Null when the plan does not fit the clip.
export function ruleFromPlan(plan: GuidePlan, cameraZones: CameraZone[], size: { width: number; height: number }): { sent: string; zones: RuleZone[] } | null {
  if (!checkPlan(plan, cameraZones, plan.about).passed) return null;
  const named = (name: string) => cameraZones.find((z) => z.name.toLowerCase() === name.trim().toLowerCase())!;
  const zones = plan.zones.map(named);
  const over = plan.box?.over ? named(plan.box.over) : null;
  const places = [...zones, ...(over && !zones.includes(over) ? [over] : [])].map((z) => ({ name: z.name, box: zoneBoxOf(z) }));
  const shown: RuleZone[] = [
    ...zones.map((z) => ({ name: z.name, paths: zonePaths(z) })),
    ...(plan.box && over ? [{ name: plan.box.name, paths: [boxPath(zoneBoxOf(over))] }] : []),
  ];
  const asked = [plan.sentence, ...(plan.box ? [plan.box.question] : [])].join(' ');
  return { sent: sentenceWithPlaces(asked, places, size), zones: shown };
}
