import { describe, expect, it } from 'vitest';
import { answerClipQuestion, type ToolAsker } from '../src/demo/clip-questions.js';
import { countInView, kindsSeen, throughOpening, zoneCrossings, type ClipDetections } from '../src/demo/detections.js';
import { SparkClient } from '../src/spark/client.js';
import type { CameraZone } from '../src/cameras/camera-zones.js';

const DOOR = { left: 100, top: 100, right: 200, bottom: 300 };
// Bottom-centre of the box stands at (x, y), one point every 500 ms from `fromMs`.
const walking = (id: number, kind: string, fromMs: number, feet: Array<[number, number]>) => ({
  id,
  kind,
  points: feet.map(([x, y], i) => [fromMs + i * 500, x - 10, y - 50, x + 10, y] as [number, number, number, number, number]),
});
const OUTSIDE: [number, number] = [500, 500];
const INSIDE: [number, number] = [150, 200];
const detections: ClipDetections = {
  fps: 2,
  width: 1280,
  height: 720,
  tracks: [
    // Comes in from outside, stays, goes out again.
    walking(1, 'person', 0, [OUTSIDE, OUTSIDE, OUTSIDE, INSIDE, INSIDE, INSIDE, OUTSIDE, OUTSIDE]),
    // Never goes near the zone, and overlaps the first person in time.
    walking(2, 'person', 1000, [OUTSIDE, OUTSIDE, OUTSIDE, OUTSIDE]),
    walking(3, 'car', 0, [OUTSIDE, OUTSIDE, OUTSIDE]),
    // One stray point in the zone is the tracker's jitter, not a crossing.
    walking(4, 'person', 8000, [OUTSIDE, OUTSIDE, INSIDE, OUTSIDE, OUTSIDE]),
    // Already standing in the zone when the clip starts: nobody crossed anything.
    walking(5, 'person', 0, [INSIDE, INSIDE, INSIDE]),
  ],
};

describe('what the detector found on a clip', () => {
  it('lists the kinds seen, with vehicles as one kind besides their own', () => {
    expect(kindsSeen(detections)).toEqual(['car', 'person', 'vehicle']);
  });

  it('counts distinct tracks and the most at once, within the times asked', () => {
    expect(countInView(detections, { kind: 'person' })).toMatchObject({ distinct: 4, mostAtOnce: 3, mostAtOnceAtMs: 1000 });
    expect(countInView(detections, { kind: 'person', fromMs: 7500 }).distinct).toBe(1);
    expect(countInView(detections, { kind: 'vehicle' }).distinct).toBe(1);
    expect(countInView(detections, { kind: 'bicycle' })).toMatchObject({ distinct: 0, mostAtOnce: 0, mostAtOnceAtMs: null });
  });

  it('counts only those whose feet are in a zone when one is asked for', () => {
    expect(countInView(detections, { kind: 'person', zone: [DOOR] }).distinct).toBe(2);
  });

  it('gives the moments each person went into and came out of a zone, ignoring one stray point and anyone already there', () => {
    expect(zoneCrossings(detections, { kind: 'person', zone: [DOOR] })).toEqual({ entered: [1500], left: [3000] });
    expect(zoneCrossings(detections, { kind: 'person', zone: [DOOR], fromMs: 2000 })).toEqual({ entered: [], left: [3000] });
  });

  it('treats a zone of several outlines as those places, not the area around them all', () => {
    const between: ClipDetections = { ...detections, tracks: [walking(1, 'person', 0, [[400, 200], [400, 200], [400, 200]])] };
    const FAR = { left: 700, top: 100, right: 800, bottom: 300 };
    expect(countInView(between, { kind: 'person', zone: [DOOR, FAR] }).distinct).toBe(0);
    expect(countInView({ ...between, tracks: [walking(1, 'person', 0, [[750, 200], [750, 200]])] }, { kind: 'person', zone: [DOOR, FAR] }).distinct).toBe(1);
  });

  describe('one person the tracker split in two', () => {
    const clip = (...tracks: ClipDetections['tracks']): ClipDetections => ({ ...detections, tracks });
    const person = (id: number, fromMs: number, feet: Array<[number, number]>) => walking(id, 'person', fromMs, feet);

    it('counts one when the second track starts close by, soon after the first ended', () => {
      expect(countInView(clip(person(1, 0, [[300, 300], [300, 300]]), person(2, 2000, [[320, 310], [340, 320]])), { kind: 'person' }).distinct).toBe(1);
    });

    it('counts two when the second starts far away', () => {
      expect(countInView(clip(person(1, 0, [[300, 300], [300, 300]]), person(2, 2000, [[900, 600], [900, 600]])), { kind: 'person' }).distinct).toBe(2);
    });

    it('counts two when too long passes between them', () => {
      expect(countInView(clip(person(1, 0, [[300, 300], [300, 300]]), person(2, 10_000, [[300, 300], [300, 300]])), { kind: 'person' }).distinct).toBe(2);
    });

    it('counts two when both are in view at once', () => {
      expect(countInView(clip(person(1, 0, [[300, 300], [300, 300], [300, 300]]), person(2, 500, [[310, 300], [310, 300], [310, 300]])), { kind: 'person' }).distinct).toBe(2);
    });
  });

  describe('going through an opening, where people pass out of sight', () => {
    const AT_DOOR: [number, number] = [150, 310];
    const AWAY: [number, number] = [150, 650];
    const MIDWAY: [number, number] = [150, 480];
    // Someone else still in view at the end of the clip, so the clip runs on past each track here.
    const lastsTheClip = walking(99, 'person', 0, Array.from({ length: 200 }, (): [number, number] => [1200, 650]));
    const through = (...tracks: ClipDetections['tracks']) => throughOpening({ ...detections, tracks: [lastsTheClip, ...tracks] }, { kind: 'person', openings: [DOOR] });

    it('counts a track that ends at the opening as going in, at that moment', () => {
      expect(through(walking(1, 'person', 5000, [AWAY, MIDWAY, AT_DOOR]))).toEqual({ wentIn: [6000], cameOut: [] });
    });

    it('counts a track that begins at the opening as coming out, at that moment', () => {
      expect(through(walking(1, 'person', 5000, [AT_DOOR, MIDWAY, AWAY]))).toEqual({ wentIn: [], cameOut: [5000] });
    });

    it('counts feet just below the opening, where a person stands to pass through it', () => {
      expect(through(walking(1, 'person', 5000, [AWAY, [150, 300 + 50]]))).toEqual({ wentIn: [5500], cameOut: [] });
    });

    it('does not count someone who walks past it and on', () => {
      expect(through(walking(1, 'person', 5000, [[600, 400], AT_DOOR, [600, 200]]))).toEqual({ wentIn: [], cameOut: [] });
    });

    it('counts one person once when a split in their track falls away from the opening', () => {
      expect(through(walking(1, 'person', 5000, [AT_DOOR, [150, 380]]), walking(2, 'person', 6500, [[150, 400], AWAY]))).toEqual({ wentIn: [], cameOut: [5000] });
    });

    it('does not count someone who only stands at the opening, however often their track breaks', () => {
      expect(through(walking(1, 'person', 5000, [[150, 300], [150, 340]]))).toEqual({ wentIn: [], cameOut: [] });
      expect(through(walking(1, 'person', 5000, [AT_DOOR, AT_DOOR]), walking(2, 'person', 7000, [AT_DOOR, AT_DOOR]), walking(3, 'person', 9000, [AT_DOOR, AT_DOOR]))).toEqual({ wentIn: [], cameOut: [] });
    });

    it('does not count something that never moves from an opening in the picture, which is no person', () => {
      expect(through(walking(1, 'person', 5000, Array.from({ length: 60 }, () => AT_DOOR)))).toEqual({ wentIn: [], cameOut: [] });
    });

    it('does not count someone already at the opening when the clip starts, or still there when it ends', () => {
      expect(through(walking(1, 'person', 0, [AT_DOOR, MIDWAY, AWAY]))).toEqual({ wentIn: [], cameOut: [] });
      expect(through(walking(1, 'person', 98_500, [AWAY, MIDWAY, AT_DOOR, AT_DOOR]))).toEqual({ wentIn: [], cameOut: [] });
    });

    it('keeps to the times asked, and the kind asked', () => {
      const tracks = [lastsTheClip, walking(1, 'person', 5000, [AWAY, AT_DOOR]), walking(2, 'car', 5000, [AWAY, AT_DOOR])];
      expect(throughOpening({ ...detections, tracks }, { kind: 'person', openings: [DOOR], fromMs: 8000 })).toEqual({ wentIn: [], cameOut: [] });
      expect(throughOpening({ ...detections, tracks }, { kind: 'car', openings: [DOOR] }).wentIn).toEqual([5500]);
    });
  });
});

const doorZone: CameraZone = { word: 'door', item: 'door', name: 'door 1', outlines: { clip: [{ word: 'door', objectId: '1', box: DOOR, path: 'M0 0Z' }] } };
const asking = (reply: (run: (name: string, args: unknown) => Promise<unknown>) => Promise<string>): ToolAsker => ({
  withTools: async (_instruction, _tools, run) => reply(run),
});
const question = 'How many people went through the door?';
const answer = (spark: ToolAsker) => answerClipQuestion({ question, lengthMs: 60_000, detections, zones: [doorZone], spark });

describe('answering a question about a clip', () => {
  it('runs the model’s tool call on what was detected, and offers each moment found', async () => {
    const reply = await answer(
      asking(async (run) => {
        const result = await run('zone_crossings', { kind: 'person', zone: 'door 1' });
        expect(result).toEqual({ moved_onto: { about: 1, at: ['0:02'] }, moved_off: { about: 1, at: ['0:03'] } });
        return 'About 1 person moved onto it at 0:02 and about 1 moved off at 0:03.';
      }),
    );
    expect(reply.answer).toBe('About 1 person moved onto it at 0:02 and about 1 moved off at 0:03.');
    expect(reply.moments).toEqual([
      { atMs: 1500, label: 'Moved onto' },
      { atMs: 3000, label: 'Moved off' },
    ]);
  });

  it('answers going through an opening from the nearby outlines of the zone, not one too far off to show a person’s feet', async () => {
    const SMALL_AND_FAR = { left: 900, top: 20, right: 920, bottom: 50 };
    const twoDoors: CameraZone = { ...doorZone, name: 'door', outlines: { clip: [{ word: 'door', objectId: '1', box: DOOR, path: 'M0 0Z' }, { word: 'door', objectId: '2', box: SMALL_AND_FAR, path: 'M0 0Z' }] } };
    const toTheDoor = walking(1, 'person', 5000, [[150, 650], [150, 310]]);
    const toTheFarDoor = walking(2, 'person', 5000, [[910, 150], [910, 55]]);
    const lastsTheClip = walking(3, 'person', 0, Array.from({ length: 100 }, (): [number, number] => [1200, 650]));
    const reply = await answerClipQuestion({
      question,
      lengthMs: 60_000,
      detections: { ...detections, tracks: [toTheDoor, toTheFarDoor, lastsTheClip] },
      zones: [twoDoors],
      spark: asking(async (run) => {
        expect(await run('through_opening', { kind: 'person', zone: 'door' })).toEqual({ went_through: { about: 1, at: ['0:06'] }, came_through: { about: 0, at: [] } });
        return 'About 1 person went through, at 0:06.';
      }),
    });
    expect(reply.answer).toBe('About 1 person went through, at 0:06.');
    expect(reply.moments).toEqual([{ atMs: 5500, label: 'Went through' }]);
  });

  it('writes its own sentence for an opening when the model’s number is not the tool’s', async () => {
    const reply = await answer(
      asking(async (run) => {
        await run('through_opening', { kind: 'person', zone: 'door 1' });
        return 'About 9 people went through.';
      }),
    );
    expect(reply.answer).toMatch(/^About \d+ went through door 1 out of view and about \d+ came through it into view\.$/);
  });

  it('counts people across the clip through the counting tool', async () => {
    const reply = await answer(
      asking(async (run) => {
        const result = await run('count_in_view', { kind: 'person' });
        expect(result).toMatchObject({ about_distinct: 4, most_at_once: 3, most_at_once_at: '0:01' });
        return 'About 4 people, with about 3 at once at 0:01.';
      }),
    );
    expect(reply.answer).toBe('About 4 people, with about 3 at once at 0:01.');
    expect(reply.moments).toContainEqual({ atMs: 1000, label: 'Most at once' });
  });

  it('tells the model when a zone is not on this camera, instead of counting something else', async () => {
    await answer(
      asking(async (run) => {
        expect(await run('zone_crossings', { kind: 'person', zone: 'gate' })).toEqual({ error: 'No zone is called "gate". The zones are: door 1.' });
        return 'That zone is not on this camera.';
      }),
    );
  });

  it('replaces a number the tools never gave with one written from the results', async () => {
    const reply = await answer(
      asking(async (run) => {
        await run('zone_crossings', { kind: 'person', zone: 'door 1' });
        return 'About 9 people went through.';
      }),
    );
    expect(reply.answer).toBe('About 1 moved onto door 1 and about 1 moved off it.');
  });

  it('says it is approximate when the model states a count flatly', async () => {
    const reply = await answer(
      asking(async (run) => {
        await run('zone_crossings', { kind: 'person', zone: 'door 1' });
        return 'Exactly 1 person went in.';
      }),
    );
    expect(reply.answer).toBe('About 1 moved onto door 1 and about 1 moved off it.');
  });

  describe('the places a question can name', () => {
    const outline = (box: typeof DOOR) => ({ clip: [{ word: 'door', objectId: '1', box, path: 'M0 0Z' }] });
    const SECOND_LEAF = { left: 205, top: 100, right: 300, bottom: 300 };
    const leaves: CameraZone[] = [
      { word: 'door', item: 'door', name: 'door 1', outlines: outline(DOOR) },
      { word: 'door', item: 'door', name: 'door 2', outlines: outline(SECOND_LEAF) },
    ];
    const offered = async (zones: CameraZone[]) => {
      let names: unknown = null;
      await answerClipQuestion({
        question,
        lengthMs: 60_000,
        detections,
        zones,
        spark: {
          withTools: async (_instruction, tools) => {
            names = (tools[1]?.parameters as any)?.properties.zone.enum ?? (tools[0]!.parameters as any).properties.zone.enum;
            return '';
          },
        },
      });
      return names;
    };

    it('treats the outlines of one word as one place, and counts each person through it once', async () => {
      expect(await offered(leaves)).toEqual(['door']);
      const toTheSecondLeaf = walking(1, 'person', 5000, [[250, 650], [250, 310]]);
      const lastsTheClip = walking(2, 'person', 0, Array.from({ length: 100 }, (): [number, number] => [1200, 650]));
      const reply = await answerClipQuestion({
        question,
        lengthMs: 60_000,
        detections: { ...detections, tracks: [toTheSecondLeaf, lastsTheClip] },
        zones: leaves,
        spark: asking(async (run) => {
          expect(await run('through_opening', { kind: 'person', zone: 'door' })).toEqual({ went_through: { about: 1, at: ['0:06'] }, came_through: { about: 0, at: [] } });
          return 'About 1 person went through, at 0:06.';
        }),
      });
      expect(reply.answer).toBe('About 1 person went through, at 0:06.');
    });

    it('keeps an outline the visitor renamed as a place of its own', async () => {
      expect(await offered([{ ...leaves[0]!, name: 'Front door' }, leaves[1]!])).toEqual(['Front door', 'door 2']);
    });

    it('does not offer something the detector counts as a place to count in', async () => {
      const parked: CameraZone = { word: 'car', item: 'car', name: 'car 1', outlines: outline(SECOND_LEAF) };
      const pickup: CameraZone = { word: 'pickup truck', item: 'pickup truck', name: 'pickup truck', outlines: outline(SECOND_LEAF) };
      expect(await offered([...leaves, parked, pickup])).toEqual(['door']);
    });

    it('offers no places on a camera with only those', async () => {
      const parked: CameraZone = { word: 'car', item: 'car', name: 'car 1', outlines: outline(SECOND_LEAF) };
      let toolNames: string[] = [];
      await answerClipQuestion({ question, lengthMs: 60_000, detections, zones: [parked], spark: { withTools: async (_i, tools) => ((toolNames = tools.map((t) => t.name)), '') } });
      expect(toolNames).toEqual(['count_in_view']);
    });
  });

  describe('when the question does not fit the counts', () => {
    const DECLINED = 'That cannot be answered from what Streamatic counted on this clip. It counted car, person and vehicle, and can count them in a zone.';

    it('declines when the model keeps trying places, whatever it finally says', async () => {
      const reply = await answer(
        asking(async (run) => {
          for (let i = 0; i < 6; i++) await run('zone_crossings', { kind: 'car', zone: 'door 1' });
          return 'About 0 cars.';
        }),
      );
      expect(reply).toEqual({ answer: DECLINED, moments: [] });
    });

    it('tells the model to stop once it has asked enough', async () => {
      await answer(
        asking(async (run) => {
          for (let i = 0; i < 4; i++) await run('count_in_view', { kind: 'person' });
          expect(await run('count_in_view', { kind: 'person' })).toEqual({ error: 'That is enough counting. Answer now, or say this cannot be answered.' });
          return '';
        }),
      );
    });

    it('declines rather than quote the last of several counts when the model’s own sentence fails the check', async () => {
      const reply = await answer(
        asking(async (run) => {
          await run('count_in_view', { kind: 'person' });
          await run('count_in_view', { kind: 'car' });
          return 'About 9 people came with about 7 cars.';
        }),
      );
      expect(reply).toEqual({ answer: DECLINED, moments: [] });
    });

    it('declines, with no moments to show, when the model counted something and then says it cannot answer', async () => {
      const reply = await answer(
        asking(async (run) => {
          await run('zone_crossings', { kind: 'person', zone: 'door 1' });
          return 'The tools cannot answer how many cars drove in.';
        }),
      );
      expect(reply).toEqual({ answer: DECLINED, moments: [] });
    });

    it('keeps a sentence with no numbers when every count came to nothing', async () => {
      const reply = await answer(
        asking(async (run) => {
          await run('zone_crossings', { kind: 'car', zone: 'door 1' });
          return 'No cars moved onto it.';
        }),
      );
      expect(reply).toEqual({ answer: 'No cars moved onto it.', moments: [] });
    });
  });

  it('declines without inventing an answer when no tool was used', async () => {
    const reply = await answer(asking(async () => 'The door is painted green and there were 40 visitors.'));
    expect(reply.answer).toBe('That cannot be answered from what Streamatic counted on this clip. It counted car, person and vehicle, and can count them in a zone.');
    expect(reply.moments).toEqual([]);
  });
});

describe('calling Muse Spark Open with tools', () => {
  const replying = (replies: unknown[]) => {
    const sent: any[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { sent, spark: new SparkClient({ apiKey: 'k', fetch: fetchImpl, retryDelayMs: 0 }) };
  };
  const tool = { name: 'count', description: 'Counts.', parameters: { type: 'object', properties: {} } };

  it('runs each tool call, sends the result back and returns the final words', async () => {
    const call = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: '{"kind":"person"}' } }] };
    const { spark, sent } = replying([call, { role: 'assistant', content: 'About 3.' }]);
    const ran: unknown[] = [];
    expect(await spark.withTools('How many?', [tool], async (name, args) => (ran.push([name, args]), { about: 3 }))).toBe('About 3.');
    expect(ran).toEqual([['count', { kind: 'person' }]]);
    expect(sent[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"about":3}' });
    expect(sent[0].tools[0]).toEqual({ type: 'function', function: tool });
  });

  it('stops offering tools after a few rounds, so the model must answer', async () => {
    const call = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: '{}' } }] };
    const { spark, sent } = replying([call, call, call, call, { role: 'assistant', content: 'Done.' }]);
    expect(await spark.withTools('How many?', [tool], async () => ({}))).toBe('Done.');
    expect(sent).toHaveLength(5);
    expect(sent[4].tools).toBeUndefined();
  });

  it('passes a tool’s refusal back as its result when the arguments are not readable', async () => {
    const call = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'count', arguments: 'not json' } }] };
    const { spark, sent } = replying([call, { role: 'assistant', content: 'Sorry.' }]);
    await spark.withTools('How many?', [tool], async () => ({}));
    expect(JSON.parse(sent[1].messages.at(-1).content)).toEqual({ error: 'The arguments could not be read.' });
  });
});
