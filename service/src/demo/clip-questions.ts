import { z } from 'zod';
import type { CameraZone } from '../cameras/camera-zones.js';
import type { Box } from '../sam/outlines.js';
import type { SparkTool } from '../spark/client.js';
import { countInView, kindsSeen, throughOpening, zoneCrossings, type ClipDetections, type Window } from './detections.js';

export interface ToolAsker {
  withTools(instruction: string, tools: SparkTool[], run: (name: string, args: unknown) => Promise<unknown>): Promise<string>;
}

export interface ClipAnswer {
  answer: string;
  // Moments the tools found, for the person to see on the clip.
  moments: Array<{ atMs: number; label: string }>;
}

const MOST_MOMENTS = 12;
const STATES_ITS_APPROXIMATE = /\b(about|approximately|around|roughly|nearly)\b/i;
const NUMBER = /\d+:\d\d|\d+/g;

const clockOf = (ms: number) => `${Math.floor(Math.round(ms / 1000) / 60)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
const asked = z.object({ kind: z.string(), zone: z.string().optional(), from_seconds: z.number().optional(), to_seconds: z.number().optional() });
const MOST_COUNTS = 4;
// With more than one count made, no single one of them answers the question on the model's behalf.
const SEVERAL_COUNTS = 'several';
// What the detector itself counts, so a person's feet in its outline say nothing: a parked car is not a place people cross.
const COUNTED_THING = /\b(person|people|car|cars|vehicle|vehicles|truck|trucks|suv|van|bus|motorcycle|bicycle|backpack|handbag|suitcase)\b/i;

// A place a question can name: every outline setup found under one word, such as the two leaves of a door, so a person is counted
// once. An outline the visitor renamed stands alone under that name.
interface Place {
  name: string;
  boxes: Box[];
}

const boxesOfZone = (zone: CameraZone): Box[] => (Object.values(zone.outlines).find((o) => o.length > 0) ?? []).map((o) => o.box);

function placesOf(zones: CameraZone[]): Place[] {
  const renamed = (z: CameraZone) => z.name !== z.word && !(z.name.startsWith(`${z.word} `) && /^\d+$/.test(z.name.slice(z.word.length + 1)));
  const groups = new Map<string, CameraZone[]>();
  for (const zone of zones.filter((z) => !COUNTED_THING.test(z.word) && !COUNTED_THING.test(z.item))) {
    const key = renamed(zone) ? `name:${zone.name}` : `word:${zone.word}`;
    groups.set(key, [...(groups.get(key) ?? []), zone]);
  }
  return [...groups.values()].map((group) => ({ name: group.length > 1 ? group[0]!.word : group[0]!.name, boxes: group.flatMap(boxesOfZone) }));
}

// One far down the picture is too few pixels to show a person's feet reaching it.
function nearbyBoxesOf({ boxes }: Place): Box[] {
  const tallest = Math.max(...boxes.map((b) => b.bottom - b.top));
  return boxes.filter((b) => b.bottom - b.top >= tallest / 2);
}

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// The model chooses the tool and writes the sentence. The numbers are the tools', and a sentence stating any others, or stating them flatly, is replaced.
export async function answerClipQuestion({ question, lengthMs, detections, zones, spark }: { question: string; lengthMs: number; detections: ClipDetections; zones: CameraZone[]; spark: ToolAsker }): Promise<ClipAnswer> {
  const kinds = kindsSeen(detections);
  const places = placesOf(zones);
  const placeNames = places.map((p) => p.name);
  const moments: ClipAnswer['moments'] = [];
  const allowed = new Set<string>([...(question.match(NUMBER) ?? []), ...placeNames.flatMap((n) => n.match(NUMBER) ?? [])]);
  const allow = (...values: Array<string | number>) => values.forEach((v) => String(v).match(NUMBER)?.forEach((n) => allowed.add(n)));
  let plain: string | null = null;
  let counts = 0;
  let toldToStop = false;

  const run = async (name: string, args: unknown): Promise<unknown> => {
    if (counts >= MOST_COUNTS) {
      toldToStop = true;
      return { error: 'That is enough counting. Answer now, or say this cannot be answered.' };
    }
    counts += 1;
    const parsed = asked.safeParse(args);
    if (!parsed.success) return { error: 'Those arguments are not valid.' };
    const { kind, zone: zoneName, from_seconds, to_seconds } = parsed.data;
    const window: Window = { ...(from_seconds === undefined ? {} : { fromMs: from_seconds * 1000 }), ...(to_seconds === undefined ? {} : { toMs: to_seconds * 1000 }) };
    const place = zoneName === undefined ? undefined : places.find((p) => p.name.toLowerCase() === zoneName.trim().toLowerCase());
    if (zoneName !== undefined && !place) return { error: `No zone is called "${zoneName}". The zones are: ${placeNames.join(', ')}.` };

    const at = (ms: number[]) => ms.slice(0, MOST_MOMENTS).map(clockOf);
    // "In" and "out" depend on which side of a door the camera is on, so the words say only what the picture shows.
    if (name === 'zone_crossings') {
      if (!place) return { error: 'A zone is needed.' };
      const { entered, left } = zoneCrossings(detections, { kind, zone: place.boxes, ...window });
      moments.push(...entered.map((atMs) => ({ atMs, label: 'Moved onto' })), ...left.map((atMs) => ({ atMs, label: 'Moved off' })));
      allow(entered.length, left.length, ...at(entered), ...at(left));
      plain = plain === null ? `About ${entered.length} moved onto ${place.name} and about ${left.length} moved off it.` : SEVERAL_COUNTS;
      return { moved_onto: { about: entered.length, at: at(entered) }, moved_off: { about: left.length, at: at(left) } };
    }
    if (name === 'through_opening') {
      if (!place) return { error: 'A zone is needed.' };
      const { wentIn, cameOut } = throughOpening(detections, { kind, openings: nearbyBoxesOf(place), ...window });
      moments.push(...wentIn.map((atMs) => ({ atMs, label: 'Went through' })), ...cameOut.map((atMs) => ({ atMs, label: 'Came through' })));
      allow(wentIn.length, cameOut.length, ...at(wentIn), ...at(cameOut));
      plain = plain === null ? `About ${wentIn.length} went through ${place.name} out of view and about ${cameOut.length} came through it into view.` : SEVERAL_COUNTS;
      return { went_through: { about: wentIn.length, at: at(wentIn) }, came_through: { about: cameOut.length, at: at(cameOut) } };
    }
    if (name === 'count_in_view') {
      const { distinct, mostAtOnce, mostAtOnceAtMs } = countInView(detections, { kind, ...(place ? { zone: place.boxes } : {}), ...window });
      const peak = mostAtOnceAtMs === null ? null : clockOf(mostAtOnceAtMs);
      if (mostAtOnceAtMs !== null) moments.push({ atMs: mostAtOnceAtMs, label: 'Most at once' });
      allow(distinct, mostAtOnce, ...(peak ? [peak] : []));
      plain = plain === null ? `About ${distinct} seen (${kind}), with about ${mostAtOnce} at once${peak ? ` at ${peak}` : ''}.` : SEVERAL_COUNTS;
      return { about_distinct: distinct, most_at_once: mostAtOnce, most_at_once_at: peak };
    }
    return { error: `There is no tool called "${name}".` };
  };

  const properties = {
    kind: { type: 'string', enum: kinds, description: 'What to count.' },
    from_seconds: { type: 'number', description: 'Start of the time asked about, in seconds from the start of the clip. Leave out for the start.' },
    to_seconds: { type: 'number', description: 'End of the time asked about, in seconds from the start of the clip. Leave out for the end.' },
  };
  const zoneProperty = { type: 'string', enum: placeNames, description: 'A zone outlined on this camera.' };
  const tools: SparkTool[] = [
    {
      name: 'count_in_view',
      description: 'Approximately how many different ones of a kind were in view during the clip, and the most at one moment; in one zone if a zone is given.',
      parameters: { type: 'object', properties: { ...properties, ...(places.length > 0 ? { zone: zoneProperty } : {}) }, required: ['kind'] },
    },
    ...(places.length > 0
      ? [
          {
            name: 'zone_crossings',
            description: 'Approximately how many of a kind moved onto an area and off it, with the moment of each. Use this for an area that stays in view, such as a road or a lawn.',
            parameters: { type: 'object', properties: { ...properties, zone: zoneProperty }, required: ['kind', 'zone'] },
          },
          {
            name: 'through_opening',
            description: 'Approximately how many of a kind went through a zone that leads out of sight and so left the picture, and how many came through it into the picture, with the moment of each. Use this for a door, a gate or an entrance.',
            parameters: { type: 'object', properties: { ...properties, zone: zoneProperty }, required: ['kind', 'zone'] },
          },
        ]
      : []),
  ];

  const said = await spark.withTools(
    `A person asked this about a recorded clip that is ${clockOf(lengthMs)} long: "${question}"
A detector and a tracker have already gone over the clip. Use the tools to answer. Times are in seconds from the start of the clip. Count once for what was asked: name a zone only if the person named a place, and cover the whole clip unless the person named a stretch of time.

Answer in one or two plain sentences, using only numbers the tools returned, with "about" before each count, since a tracker can lose someone or count them twice. Give a time only if the person asked when. Say "went through" and "came through" for a door, a gate or an entrance, never "in" or "out", since the camera may be on either side of it. If the tools cannot answer the question, say so in one sentence. Do not describe the tools.`,
    tools,
    run,
  );

  const declined = { answer: `That cannot be answered from what Streamatic counted on this clip. It counted ${list(kinds)}, and can count them in a zone.`, moments: [] };
  if (plain === null || toldToStop) return declined;
  const numbers = said.match(NUMBER) ?? [];
  // Counts found and none quoted means the model did not answer from them, whatever it counted on the way.
  if (numbers.length === 0 && moments.length > 0) return declined;
  const holds = numbers.length === 0 || (numbers.every((n) => allowed.has(n)) && STATES_ITS_APPROXIMATE.test(said));
  const fallback: string = plain;
  if (!(holds && said.trim()) && fallback === SEVERAL_COUNTS) return declined;
  return { answer: holds && said.trim() ? said.trim() : fallback, moments: moments.sort((a, b) => a.atMs - b.atMs).slice(0, MOST_MOMENTS) };
}
