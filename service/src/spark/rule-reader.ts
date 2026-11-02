import { z } from 'zod';
import { SETTLED_BY, type SettledBy } from '../rules/rule-store.js';
import { SparkError, type SparkClient } from './client.js';

export interface RuleReading {
  settledBy: SettledBy;
  // Each drawn box's question, in the order given, reworded only where the rule is settled by a change.
  questions: string[];
}

export interface RuleReader {
  read(sentence: string, questions: string[]): Promise<RuleReading>;
}

// Reads what settles a rule from its sentence, so the person never chooses how many pictures are judged.
export class SparkRuleReader implements RuleReader {
  constructor(private readonly spark: SparkClient) {}

  async read(sentence: string, questions: string[]): Promise<RuleReading> {
    const boxes = questions.length
      ? `It watches drawn boxes, each with a question for a model that looks inside the box:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : 'It watches outlines that a segmentation model draws; it has no questions.';
    const reading = await this.spark.json(
      `A person wrote this rule for a security camera: "${sentence}"
${boxes}

Decide what settles the rule's answer, one of three:
- "one-picture": a state that lasts long enough for one picture to show it, however long it has to hold: a door standing open, a van parked in the bay, someone lying on the floor, a screen that is off.
- "change": the answer is in what differs between pictures a few seconds apart, so no single picture shows it: a conveyor belt running or stopped, a departures board frozen on one screen, a vehicle turning.
- "brief-change": a change over within a moment or two, which pictures several seconds apart would step over: someone running across the yard, someone stepping through a doorway. Choose it even where one picture could show the act, because the next picture is seconds later and nothing is left behind.
Choose "brief-change" only when the change is that quick; any other change is "change". A length of time never makes a change: a door left open for ten minutes is one picture. Nor does an action whose result one picture shows: a shutter pulled down is one picture of it down.

Then give each question back, in the same order. Keep it as written when it fits. When the rule is settled by a change or a brief change and a question asks about one moment, ask about the change itself instead ("Is anything on the board changing?", not "Is the board showing a flight?"). Never mention pictures or how many there are.
Reply with JSON only: {"settledBy": "one-picture", "questions": []}`,
      [],
      z.object({ settledBy: z.enum(SETTLED_BY), questions: z.array(z.string().trim().min(1)) }),
    );
    if (reading.questions.length !== questions.length) {
      throw new SparkError(`Muse Spark Open gave ${reading.questions.length} questions back for ${questions.length} boxes.`);
    }
    return reading;
  }
}
