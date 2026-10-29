import { z } from 'zod';
import type { BoxJudge } from '../rules/zone-rule.js';
import type { LabelledPicture } from '../setup/camera-setup.js';
import type { SparkClient } from './client.js';

export class SparkBoxJudge implements BoxJudge {
  constructor(
    private readonly spark: SparkClient,
    private readonly gapSeconds: number,
  ) {}

  async judge(question: string, crops: LabelledPicture[]) {
    return this.spark.json(
      `These ${crops.length} pictures show the same area of a security camera's view, ${this.gapSeconds} seconds apart, oldest first.
Question: ${question}
Answer true or false, or null if the pictures cannot tell. Also say which picture shows it most clearly, by its number, or null if no single picture shows it (for example, when it can only be seen as a change between pictures).
Reply with JSON only: {"answer": true, "shownIn": 1}`,
      crops,
      z.object({ answer: z.boolean().nullable(), shownIn: z.number().int().nullable() }),
    );
  }
}
