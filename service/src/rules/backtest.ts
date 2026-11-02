import type { Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';
import type { Outliner } from '../setup/camera-setup.js';
import { runZoneRule, type BoxJudge, type Frame, type ZoneAlert, type ZoneRule } from './zone-rule.js';

// Runs a rule over stored pictures in parts side by side, so a week of checks waits on the models in parallel,
// and returns the alerts it would have raised. Nothing is stored or sent.
export async function backtest({
  rule,
  frames,
  parts,
  onProgress,
  ...models
}: {
  rule: ZoneRule;
  frames: Frame[];
  sam: Outliner;
  judge?: BoxJudge;
  crop: (picture: Picture, box: Box) => Promise<Picture>;
  timeZone: string;
  parts: number;
  // Called as each part finishes, with how many of the pictures have been checked.
  onProgress?: (checked: number) => void;
}): Promise<{ checks: number; alerts: ZoneAlert[] }> {
  const size = Math.ceil(frames.length / parts);
  const reach = (rule.samples - 1) * rule.sampleGapMs;
  let checked = 0;
  const results = await Promise.all(
    Array.from({ length: parts }, async (_, k) => {
      const start = k * size;
      const end = Math.min(frames.length, start + size);
      if (start >= end) return { checks: [], alerts: [] };
      const lastAt = frames[end - 1]!.at;
      // A part starts one picture early, to compare its first picture with the one before, and runs on only as far as a check's later pictures reach.
      const part = [...frames.slice(Math.max(0, start - 1), end), ...frames.slice(end).filter((f) => f.at <= lastAt + reach)];
      const result = await runZoneRule({ ...models, rule, frames: part });
      checked += end - start;
      onProgress?.(checked);
      const own = (at: number) => at <= lastAt;
      return { checks: result.checks.filter((c) => own(c.at)), alerts: result.alerts.filter((a) => own(checkStart(a))) };
    }),
  );

  // A part starts without knowing the answer was already true when the part before it ended, so an alert on its first
  // check is only an answer still holding, and is dropped.
  let holding = false;
  const found = results.flatMap(({ checks, alerts }) => {
    const first = checks[0];
    const kept = holding && first ? alerts.filter((a) => checkStart(a) !== first.at) : alerts;
    if (checks.length) holding = checks[checks.length - 1]!.verdict;
    return kept;
  });

  // Each part kept its own quiet time after an alert; across the edge between parts it is applied here.
  const alerts: ZoneAlert[] = [];
  for (const alert of found.sort((a, b) => checkStart(a) - checkStart(b))) {
    const previous = alerts[alerts.length - 1];
    if (!previous || checkStart(alert) >= checkStart(previous) + rule.cooldownMs) alerts.push(alert);
  }
  return { checks: results.reduce((n, r) => n + r.checks.length, 0), alerts };
}

const checkStart = (alert: ZoneAlert) => alert.judged[0]?.at ?? alert.at;
