import { z } from 'zod';
import type { BoxJudge } from '../rules/zone-rule.js';
import type { LabelledPicture } from '../setup/camera-setup.js';
import type { SparkClient } from './client.js';

const VISIBLE_ONLY = 'Judge only what is visible. Do not infer intent, ownership, identity or wrongdoing.';

// Asks a drawn box's question of one picture, or of the change across several, as Streamatic's rules already do.
export class SparkBoxJudge implements BoxJudge {
  constructor(private readonly spark: SparkClient) {}

  async judge(question: string, crops: LabelledPicture[], gapSeconds: number | null) {
    if (crops.length === 1) {
      const { answer } = await this.spark.json(
        `This picture shows one area of a security camera's view.
Question: ${question}
${VISIBLE_ONLY}
Reply with JSON only: {"answer": true}, where "answer" is true, false, or null when the picture cannot tell.`,
        crops,
        z.object({ answer: z.boolean().nullable() }),
      );
      return { answer, shownIn: answer === true ? 1 : null };
    }
    return this.spark.json(
      `These ${crops.length} pictures show the same area of one fixed camera's view, in time order${gapSeconds ? `, ${gapSeconds} seconds apart` : ''}.
Answer the question below by comparing the pictures with each other.
Movement means something is in a different position in a later picture than in an earlier one. A moving pose on its own, such as mid-stride or blurred, is not movement. If everything is in the same position in every picture, the answer is false.
Never treat not seeing something as proof that it did not happen: if the question turns on something these pictures cannot show, the answer is null.
${VISIBLE_ONLY}
Question: ${question}
Also say which picture shows it most clearly, by its number, or null if only the change between pictures shows it.
Reply with JSON only: {"answer": true, "shownIn": 2}, where "answer" is true, false, or null when these pictures cannot settle it.`,
      crops,
      z.object({ answer: z.boolean().nullable(), shownIn: z.number().int().nullable() }),
    );
  }
}
