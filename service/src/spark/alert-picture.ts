import { z } from 'zod';
import type { Picture } from '../sam/client.js';
import type { SparkClient } from './client.js';

// Chooses the picture an alert carries. The rule has already been decided, so the model is never asked whether it holds.
export class SparkAlertPicture {
  constructor(private readonly spark: SparkClient) {}

  async pick(event: string, pictures: Picture[]): Promise<number> {
    if (pictures.length <= 1) return 0;
    const { picture } = await this.spark.json(
      `These ${pictures.length} pictures are from one fixed camera, in time order. An alert has already been raised for them: ${event}
Do not judge whether the alert is right. Say which picture, by its number, a person should see first to understand the alert.
Reply with JSON only: {"picture": 2}`,
      pictures.map((p, i) => ({ label: `picture ${i + 1}`, picture: p })),
      z.object({ picture: z.number().int() }),
    );
    return Math.min(Math.max(picture - 1, 0), pictures.length - 1);
  }
}
