import { useEffect } from 'react';
import { api, type DemoRule } from '@/lib/api';

// What a visitor has done in Setup, kept in this browser. Their rules themselves are kept by the server, under their visitor cookie.
export interface CameraProgress {
  ready: boolean;
  // Rules already run on the clip: selecting one spends nothing.
  offered: string[];
  // Rules added from Setup, each run on the clip for this visitor.
  added: string[];
}

const KEY = 'streamatic-setup';
const NOT_SET_UP: CameraProgress = { ready: false, offered: [], added: [] };

function readAll(): Record<string, CameraProgress> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, CameraProgress>;
  } catch {
    return {};
  }
}

export const progressOf = (clip: string): CameraProgress => readAll()[clip] ?? NOT_SET_UP;

export function saveProgress(clip: string, progress: CameraProgress | null): void {
  const { [clip]: _gone, ...rest } = readAll();
  try {
    localStorage.setItem(KEY, JSON.stringify(progress ? { ...rest, [clip]: progress } : rest));
  } catch {
    // Storage can be refused; Setup then simply starts afresh on the next visit.
  }
}

export function rulesChosenInSetup(clip: string): string[] {
  const { offered, added } = progressOf(clip);
  return [...offered, ...added];
}

export const RULE_FINISHED = new Set(['ready', 'refused', 'failed']);
const REFRESH_RULES_BEING_ADDED_MS = 3_000;

// A rule added from setup can still be running when its page is opened, and only reading it moves it on.
export function useRefreshRulesBeingAdded(clip: string, rules: DemoRule[], refresh: () => void): void {
  const being = rules.filter((r) => r.kind === 'typed' && !RULE_FINISHED.has(r.status)).map((r) => r.id).join(',');
  useEffect(() => {
    if (!being) return;
    const timer = setInterval(() => {
      void Promise.all(being.split(',').map((rule) => api.clipRule(clip, rule).catch(() => null))).then(refresh);
    }, REFRESH_RULES_BEING_ADDED_MS);
    return () => clearInterval(timer);
  }, [being, clip, refresh]);
}
