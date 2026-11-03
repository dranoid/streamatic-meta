import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

export type Spending = 'rule' | 'plan' | 'track' | 'look' | 'upload';

// What one visitor may start in a day. What is already kept costs nothing and is never counted.
const PER_VISITOR: Record<Spending, number> = { rule: 10, plan: 20, track: 8, look: 30, upload: 8 };

interface Day {
  day: string;
  spentMicroUsd: number;
  visitors: Record<string, Partial<Record<Spending, number>>>;
}

const REACHED_VISITOR = 'You have reached today’s limit for this on the demo. The recorded clips still work. Please try again tomorrow.';
const REACHED_CEILING = 'The demo has reached today’s limit on new model calls. The recorded clips still work. Please try again tomorrow.';

// The public page's spending: counted per visitor, under one ceiling a day, kept in a file so a restart does not reset it.
export class DemoLimits {
  #today: Day;

  constructor(private readonly options: { file: string; ceilingMicroUsd: number; now?: () => number }) {
    let saved: Day | null = null;
    try {
      saved = JSON.parse(readFileSync(options.file, 'utf8')) as Day;
    } catch {
      // No file yet: the first day starts empty.
    }
    this.#today = saved ?? this.#fresh();
  }

  #fresh(): Day {
    return { day: this.#dayNow(), spentMicroUsd: 0, visitors: {} };
  }

  #dayNow(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString().slice(0, 10);
  }

  // Null when it may go ahead, and it is then counted; otherwise what to tell the person.
  async charge(visitor: string, kind: Spending, costMicroUsd: number): Promise<string | null> {
    if (this.#today.day !== this.#dayNow()) this.#today = this.#fresh();
    const counts = (this.#today.visitors[visitor] ??= {});
    if ((counts[kind] ?? 0) >= PER_VISITOR[kind]) return REACHED_VISITOR;
    if (this.#today.spentMicroUsd + costMicroUsd > this.options.ceilingMicroUsd) return REACHED_CEILING;
    counts[kind] = (counts[kind] ?? 0) + 1;
    this.#today.spentMicroUsd += costMicroUsd;
    await writeFile(this.options.file, JSON.stringify(this.#today));
    return null;
  }
}
