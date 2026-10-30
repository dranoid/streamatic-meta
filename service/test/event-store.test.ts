import { describe, expect, it } from 'vitest';
import { EventStore, type NewEvent } from '../src/events/store.js';

// 21:24 and 23:10 on 28 October in Lagos, and 14:00 the next day.
const EVENING = Date.UTC(2026, 9, 28, 20, 24, 0);
const LATE = Date.UTC(2026, 9, 28, 22, 10, 0);
const AFTERNOON = Date.UTC(2026, 9, 29, 13, 0, 0);

function event(at: number, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    camera: 'Table parlour',
    zone: 'front door',
    rule: 'Alert me if the front door opens after 9 pm.',
    at,
    picture: `${at}.jpg`,
    clip: null,
    outline: 'M0 0L1 1Z',
    reference: 'M0 0L2 2Z',
    ...overrides,
  };
}

const store = () => new EventStore(':memory:', 'Africa/Lagos');

describe('EventStore', () => {
  it('returns an added event by its id', () => {
    const events = store();
    const id = events.add(event(EVENING));
    expect(events.get(id)).toEqual({ id, ...event(EVENING) });
  });

  it('counts and lists only the events inside the local hours asked, across midnight', () => {
    const events = store();
    events.add(event(EVENING));
    events.add(event(LATE));
    events.add(event(AFTERNOON));
    const afterTen = { hours: { from: 22, to: 6 } };
    expect(events.count(afterTen)).toBe(1);
    expect(events.list(afterTen).map((e) => e.at)).toEqual([LATE]);
  });

  it('filters by zone, camera and time range, newest first', () => {
    const events = store();
    events.add(event(EVENING));
    events.add(event(LATE, { zone: 'gate', camera: 'Amosu' }));
    events.add(event(AFTERNOON));
    expect(events.count({ zone: 'front door' })).toBe(2);
    expect(events.count({ camera: 'Amosu' })).toBe(1);
    expect(events.list({ from: EVENING + 1, to: AFTERNOON }).map((e) => e.at)).toEqual([AFTERNOON, LATE]);
  });

  it('lists the zones and cameras it holds events for', () => {
    const events = store();
    events.add(event(EVENING));
    events.add(event(LATE, { zone: 'gate', camera: 'Amosu' }));
    expect(events.places()).toEqual([
      { camera: 'Amosu', zone: 'gate' },
      { camera: 'Table parlour', zone: 'front door' },
    ]);
  });

  it('keeps the frames around an event in time order, with the outline on each judged one', () => {
    const events = store();
    const id = events.add(event(EVENING));
    const other = events.add(event(LATE));
    events.addFrames(id, [
      { at: EVENING + 3000, file: 'b.jpg', outline: 'M2 2Z' },
      { at: EVENING - 2000, file: 'a.jpg', outline: null },
    ]);
    events.addFrames(other, [{ at: LATE, file: 'c.jpg', outline: null }]);
    expect(events.frames(id)).toEqual([
      { at: EVENING - 2000, file: 'a.jpg', outline: null },
      { at: EVENING + 3000, file: 'b.jpg', outline: 'M2 2Z' },
    ]);
  });
});
