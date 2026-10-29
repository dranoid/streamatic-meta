import { z } from 'zod';
import { drawOutlines } from '../alerts/draw.js';
import type { SecondOpinion, SecondOpinionJudge } from '../alerts/second-opinion.js';
import type { Picture } from '../sam/client.js';
import type { SparkClient } from './client.js';

type Mark = (jpeg: Uint8Array, path: string) => Promise<Uint8Array>;

const markZone: Mark = (jpeg, path) => drawOutlines(jpeg, [{ path, colour: '#ffffff', dashed: true }]);

export class SparkSecondOpinion implements SecondOpinionJudge {
  constructor(
    private readonly spark: SparkClient,
    private readonly mark: Mark = markZone,
  ) {}

  // Spark Open sees the rule and the two pictures, never the first check's verdict, so its answer is independent.
  // The mark shows only where the zone is, which the rule's words alone leave open when a scene has two doors.
  async judge({ rule, zone, zoneOutline, before, now }: { rule: string; zone: string; zoneOutline: string; before: Picture; now: Picture }): Promise<SecondOpinion> {
    const marked = async (picture: Picture): Promise<Picture> => ({ ...picture, bytes: await this.mark(picture.bytes, zoneOutline) });
    return this.spark.json(
      `A camera watches this rule: "${rule}"
On both pictures, a dashed white outline marks where the ${zone} was when the camera was set up. The first picture shows it as it normally is, taken at setup. The second picture was taken now.
Judge from the pictures alone whether the second picture shows what the rule describes, compared with the first. If the pictures cannot tell, answer null.
Reply with JSON only: {"confirmed": true, "reason": "one short sentence on what the second picture shows"}`,
      [
        { label: 'at setup', picture: await marked(before) },
        { label: 'now', picture: await marked(now) },
      ],
      z.object({ confirmed: z.boolean().nullable(), reason: z.string() }),
    );
  }
}
