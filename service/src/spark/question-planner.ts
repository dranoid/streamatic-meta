import { z } from 'zod';
import type { Plan, QuestionFacts, QuestionPlanner } from '../questions/answer.js';
import type { SparkClient } from './client.js';

const hour = z.number().int().min(0).max(23);
const planShape = z.object({
  tool: z.enum(['count', 'list', 'none']),
  camera: z.string().nullable(),
  zone: z.string().nullable(),
  period: z.enum(['today', 'yesterday', 'last 7 days', 'all']),
  hours: z.object({ from: hour, to: hour }).nullable(),
  reason: z.string().optional(),
});

export class SparkQuestionPlanner implements QuestionPlanner {
  constructor(private readonly spark: SparkClient) {}

  // Spark is handed the date and the zone names, so it never works out a date or invents a zone.
  async plan(question: string, facts: QuestionFacts): Promise<Plan> {
    const places = facts.places.map((p) => `- "${p.zone}" on camera "${p.camera}"`).join('\n');
    return this.spark.json(
      `Cameras record an event each time a watched zone changes. Choose how to look up the answer to this question; a database will do the counting.
Question: "${question}"
Today is ${facts.today}, time zone ${facts.timeZone}.
Zones with events:
${places || '- none yet'}

Reply with JSON only, with these keys:
- "tool": "count" for how many times, "list" to show the events, "none" if events of watched zones cannot answer it.
- "zone" and "camera": exactly one of the names above, or null for all.
- "period": one of "today", "yesterday", "last 7 days", "all".
- "hours": {"from": H, "to": H} in 24-hour local time when the question names a time of day, else null; "after 9 pm" is {"from": 21, "to": 6}.
- "reason": only when "tool" is "none", one sentence saying why.`,
      [],
      planShape,
    );
  }
}
