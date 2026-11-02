import type { CameraZone } from '../cameras/camera-zones.js';

// The rule the guide will build: the camera's zones by name, a box where no zone fits, and the hours. A box goes over
// a zone's place when it names one; otherwise the person draws it.
export interface GuidePlan {
  sentence: string;
  zones: string[];
  box: { name: string; question: string; over: string | null } | null;
  hours: { from: number; to: number } | null;
}

export interface PlanAttempt {
  plan: GuidePlan;
  problems: string[];
}

export interface GuidePlanner {
  // Each refused plan comes back with what was wrong with it, so the next draft can put it right.
  draft(request: { sentence: string; site: string; zones: CameraZone[] }, refused: PlanAttempt[]): Promise<GuidePlan>;
}

export type PlanResult =
  | { status: 'ready'; plan: GuidePlan; attempts: PlanAttempt[] }
  | { status: 'needs-person'; problems: string[]; attempts: PlanAttempt[] };

const MAX_ZONES = 4;
// After this many refused plans the guide stops and asks the person.
const MAX_TRIES = 3;

// Checked in code, never by the model: a plan the model checked itself could say anything.
export function checkPlan(plan: GuidePlan, zones: CameraZone[]): { passed: boolean; problems: string[] } {
  const problems: string[] = [];
  const named = (name: string) => zones.find((z) => z.name.toLowerCase() === name.trim().toLowerCase());
  const known = `Its zones are: ${zones.map((z) => z.name).join(', ')}.`;
  for (const name of plan.zones) {
    if (!named(name)) problems.push(`"${name}" is not a zone on this camera. ${known}`);
  }
  if (new Set(plan.zones.map((n) => n.trim().toLowerCase())).size !== plan.zones.length) problems.push('A zone is named twice.');
  const count = plan.zones.length + (plan.box ? 1 : 0);
  if (count === 0) problems.push('The plan has no zone and no box; a rule watches at least one.');
  if (count > MAX_ZONES) problems.push(`A rule watches at most ${MAX_ZONES} zones and boxes; this plan has ${count}.`);
  if (plan.box) {
    if (!plan.box.name.trim()) problems.push('The box has no name.');
    if (!plan.box.question.trim()) problems.push('The box has no question for Muse Spark Open to answer about it.');
    if (named(plan.box.name)) problems.push(`The box is named "${plan.box.name}", which is already a zone on this camera; name it differently.`);
    if (plan.box.over !== null && !named(plan.box.over)) problems.push(`The box is to go over "${plan.box.over}", which is not a zone on this camera. ${known}`);
  }
  if (plan.hours) {
    const { from, to } = plan.hours;
    const onClock = (h: number) => Number.isInteger(h) && h >= 0 && h <= 23;
    if (!onClock(from) || !onClock(to)) problems.push('Hours must be whole hours from 0 to 23.');
    else if (from === to) problems.push('The hours start and end at the same hour; leave them out to watch all day.');
  }
  if (!plan.sentence.trim()) problems.push('The plan has no rule sentence.');
  return { passed: problems.length === 0, problems };
}

// Drafts a plan and checks it; a refused plan goes back to the planner with its problems, until one passes or the tries run out.
export async function planRule({
  sentence,
  site,
  zones,
  planner,
}: {
  sentence: string;
  site: string;
  zones: CameraZone[];
  planner: GuidePlanner;
}): Promise<PlanResult> {
  const attempts: PlanAttempt[] = [];
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const plan = await planner.draft({ sentence, site, zones }, attempts.slice());
    const { passed, problems } = checkPlan(plan, zones);
    attempts.push({ plan, problems });
    if (passed) return { status: 'ready', plan, attempts };
  }
  return { status: 'needs-person', problems: attempts[attempts.length - 1]!.problems, attempts };
}
