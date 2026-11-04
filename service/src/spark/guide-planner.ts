import { z } from 'zod';
import type { CameraZone } from '../cameras/camera-zones.js';
import type { GuideDraft, GuidePlanner, PlanAttempt } from '../guide/plan.js';
import type { SparkClient } from './client.js';

const hour = z.number().int();
const planShape = z.object({
  sentence: z.string(),
  about: z.string(),
  zones: z.array(z.string()),
  box: z.object({ name: z.string(), question: z.string(), over: z.string().nullable() }).nullable(),
  hours: z.object({ from: hour, to: hour }).nullable(),
});
const searchShape = z.object({ search: z.object({ item: z.string().min(1), words: z.array(z.string()) }) });
const draftShape = z.union([searchShape, planShape]);

// Spark Open drafts the plan; the guide checks it in code before anything is done in the app.
export class SparkGuidePlanner implements GuidePlanner {
  constructor(private readonly spark: SparkClient) {}

  async draft({ sentence, site, zones }: { sentence: string; site: string; zones: CameraZone[] }, refused: PlanAttempt[]): Promise<GuideDraft> {
    const listed = zones.map((z) => `- "${z.name}" (outlined as "${z.word}", on the ${Object.keys(z.outlines).join(', ')} pictures)`).join('\n');
    const corrections = refused.length
      ? `\nEarlier plans were refused. Fix exactly what each refusal says:\n${refused
          .map((r, i) => `${i + 1}. ${JSON.stringify(r.plan)}\n   Refused: ${r.problems.join(' ')}`)
          .join('\n')}\n`
      : '';
    return this.spark.json(
      `A person said this about a camera at ${site}: "${sentence}"
The camera's zones, each a thing SAM 3.1 outlined:
${listed || '- none'}

First decide what the person wants. If they want an item found or tracked in the footage now, with no alert to come ("Track the ladder", "Where is the blue van?", "Find the person in the red cap"), reply with JSON only:
{"search": {"item": "the item in the person's own words", "words": ["up to 3 short everyday names for that item, plainest first, that SAM 3.1 could outline it by"]}}
Otherwise they want an alert, and you plan the rule as follows.

A zone marks that thing itself, for a rule about it: it opens, moves, or is no longer there. To watch for something
appearing in or near a place (someone on the stairs, a van in the loading bay), mark the place with a box and a question instead.

Plan the rule the app will build:
- "sentence": the rule in one plain sentence, as the person would say it.
- "about": the thing whose presence or change the alert is for, in words copied from the request. For "tell me when a forklift blocks the fire exit" it is "forklift"; for "tell me if the shutter is left up" it is "shutter".
- "zones": the names of the zones whose own change the rule watches, copied exactly from the list; [] when none. A zone fits only when "about" contains its name or its outlined word; anything else is watched with a box.
- "box": when the rule watches for something in or near a place, {"name": a short name not in the list, "question": a yes-or-no question answerable from inside the box alone, "over": the name of the zone from the list the box covers, or null for the person to draw it}; otherwise null.
- "hours": {"from": H, "to": H} in 24-hour local time when the request names a time of day, else null. "After 11 pm" is {"from": 23, "to": 6}; "at night" is {"from": 22, "to": 6}; "during the day" is {"from": 8, "to": 18}.
${corrections}
Reply with JSON only: {"sentence": "", "about": "", "zones": [], "box": null, "hours": null}`,
      [],
      draftShape,
    );
  }
}
