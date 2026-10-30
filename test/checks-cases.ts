import type { CheckConclusion } from '../src/types.js';

/** Shared raw-run cases exercise summarization before every ingress filter. */
export const checksCases: { name: string; conclusions: CheckConclusion[]; emits: boolean }[] = [
  ...(['success', 'neutral', 'skipped', 'stale'] as const).map((conclusion) => ({ name: conclusion, conclusions: [conclusion], emits: false })),
  ...(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'] as const)
    .map((conclusion) => ({ name: conclusion, conclusions: [conclusion], emits: true })),
  { name: 'mixed green suites', conclusions: ['success', 'neutral', 'skipped', 'stale'], emits: false },
  { name: 'mixed failing suites', conclusions: ['success', 'neutral', 'failure', 'cancelled'], emits: true },
];

export function checkRuns(conclusions: readonly CheckConclusion[]) {
  return conclusions.map((conclusion, index) => ({
    name: `job-${index}`, status: 'completed', conclusion, html_url: `https://ci/${index}`,
  }));
}
