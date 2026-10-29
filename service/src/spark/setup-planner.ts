import { z } from 'zod';
import type { LabelledPicture, SetupPlanner, SuggestedRule, ZoneSummary } from '../setup/camera-setup.js';
import type { SparkClient } from './client.js';

const MAX_ITEMS = 15;

export class SparkSetupPlanner implements SetupPlanner {
  constructor(
    private readonly spark: SparkClient,
    // A short description of the site, supplied rather than guessed, so Spark's rules fit it.
    private readonly site: string,
  ) {}

  async listItems(pictures: LabelledPicture[]): Promise<string[]> {
    const { items } = await this.spark.json(
      `These pictures come from one fixed security camera at ${this.site}, taken at different times of day.
List the fixed things, places and regularly present objects in view that the site's manager might write an alert rule about: entrances, barriers, structures, equipment, and vehicles that are usually parked there.
Use the most ordinary short name for each, one or two words, singular. Leave out people, the sky, plants, and text drawn on the picture by the camera.
List at most ${MAX_ITEMS} items. Reply with JSON only: {"items": ["..."]}`,
      pictures,
      z.object({ items: z.array(z.string()) }),
    );
    return items.slice(0, MAX_ITEMS);
  }

  async alternatives(items: string[], pictures: LabelledPicture[]): Promise<Record<string, string[]>> {
    const { alternatives } = await this.spark.json(
      `An outlining model looked for these things in the pictures and found nothing under these names: ${items.join(', ')}.
For each one, give up to two other common names for the same thing as it appears here, plainest first. If a thing is not actually in the pictures, give an empty list for it.
Reply with JSON only: {"alternatives": {"<name>": ["...", "..."]}}`,
      pictures,
      z.object({ alternatives: z.record(z.string(), z.array(z.string())) }),
    );
    return alternatives;
  }

  async proposeRules(zones: ZoneSummary[], pictures: LabelledPicture[]): Promise<SuggestedRule[]> {
    const named = zones.map((z) => `${z.name} (seen: ${z.seenAt.join(', ')})`).join('\n');
    const { rules } = await this.spark.json(
      `This camera watches ${this.site}. These things were outlined in its pictures, with the times they were visible:
${named}
Suggest three to five alert rules the site's manager would want, each one plain English sentence starting "Alert me if" or "Tell me when", about things a camera picture can show.
Refer to things only by the names above, exactly as written (add "the" where English needs it), and list the names each rule uses.
Reply with JSON only: {"rules": [{"sentence": "...", "zones": ["..."]}]}`,
      pictures,
      z.object({ rules: z.array(z.object({ sentence: z.string(), zones: z.array(z.string()) })) }),
    );
    return rules;
  }
}
