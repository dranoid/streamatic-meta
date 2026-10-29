import type { EventFilter, EventStore, StoredEvent } from '../events/store.js';

export type Period = 'today' | 'yesterday' | 'last 7 days' | 'all';

export interface Plan {
  tool: 'count' | 'list' | 'none';
  camera: string | null;
  zone: string | null;
  period: Period;
  hours: { from: number; to: number } | null;
  reason?: string;
}

export interface QuestionFacts {
  today: string;
  timeZone: string;
  places: Array<{ camera: string; zone: string }>;
}

export interface QuestionPlanner {
  plan(question: string, facts: QuestionFacts): Promise<Plan>;
}

export interface Answer {
  text: string;
  count: number | null;
  events: StoredEvent[];
  plan: Plan;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Spark only chooses what to look up; the store counts, and the answer's words are written from its rows.
export async function answerQuestion({
  question,
  store,
  planner,
  now,
  timeZone,
}: {
  question: string;
  store: EventStore;
  planner: QuestionPlanner;
  now: number;
  timeZone: string;
}): Promise<Answer> {
  const places = store.places();
  const plan = await planner.plan(question, { today: longDate(now, timeZone), timeZone, places });
  if (plan.tool === 'none') {
    return { text: plan.reason ?? 'The recorded events cannot answer this question.', count: null, events: [], plan };
  }
  const known = places.some((p) => (plan.zone === null || p.zone === plan.zone) && (plan.camera === null || p.camera === plan.camera));
  if (!known) {
    const place = [plan.zone, plan.camera].filter(Boolean).join(' on ');
    return { text: `No rule watches ${place}, so there are no events for it.`, count: null, events: [], plan };
  }

  const filter: EventFilter = {
    ...(plan.camera === null ? {} : { camera: plan.camera }),
    ...(plan.zone === null ? {} : { zone: plan.zone }),
    ...periodRange(plan.period, plan.hours, now, timeZone),
    ...(plan.hours === null ? {} : { hours: plan.hours }),
  };
  const count = store.count(filter);
  const events = store.list(filter);
  const subject = plan.zone ? `The ${plan.zone}` : 'The watched zones';
  const when = [periodWords(plan.period, plan.hours), plan.hours ? `between ${hour(plan.hours.from)} and ${hour(plan.hours.to)}` : '']
    .filter(Boolean)
    .join(', ');
  const text = `${subject} changed ${count} ${count === 1 ? 'time' : 'times'}${when ? ` ${when}` : ''}.`;
  return { text, count, events, plan };
}

// Hours across midnight on a named day mean the night that began on it: "after 10 pm yesterday" runs into this morning.
function periodRange(period: Period, hours: Plan['hours'], now: number, timeZone: string): { from?: number; to?: number } {
  const today = localMidnight(now, timeZone);
  const day =
    period === 'today' ? today : period === 'yesterday' ? localMidnight(today - DAY / 2, timeZone) : null;
  if (day !== null && hours && hours.from > hours.to) {
    const nextDay = localMidnight(day + DAY + DAY / 2, timeZone);
    return { from: day + hours.from * HOUR, to: Math.min(now, nextDay + hours.to * HOUR - 1) };
  }
  switch (period) {
    case 'today':
      return { from: today, to: now };
    case 'yesterday':
      return { from: day!, to: today - 1 };
    case 'last 7 days':
      return { from: localMidnight(today - 6 * DAY + DAY / 2, timeZone), to: now };
    case 'all':
      return {};
  }
}

function periodWords(period: Period, hours: Plan['hours']): string {
  if (period === 'all') return '';
  if (period === 'last 7 days') return 'in the last 7 days';
  return hours && hours.from > hours.to ? `on the night that began ${period}` : period;
}

function localMidnight(at: number, timeZone: string): number {
  const p = parts(at, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day);
  return guess - offset(guess, timeZone);
}

// How far the zone's wall clock is ahead of UTC at this moment.
function offset(at: number, timeZone: string): number {
  const p = parts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
}

function parts(at: number, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  );
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}

function longDate(at: number, timeZone: string): string {
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(at);
  return `${format({ weekday: 'long' })} ${format({ day: 'numeric' })} ${format({ month: 'long' })} ${format({ year: 'numeric' })}`;
}

function hour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}
