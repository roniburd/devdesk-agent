import { LatencyStats, type OutlierRule } from '../latency';

/**
 * How long the web access daemon's requests and polls take, for its log (`daemon.log`): a line for each one that is
 * slow (over `slowMs`, or far over what its label usually takes), with its steps, and every `summaryMs` a line per
 * label with its median, p90 and slowest since the last one, so a slow spell, or a version slower than the one before,
 * shows in the log afterwards.
 */

/** A request this slow is always logged. */
export const SLOW_REQUEST_MS = 2000;
/** One far over its label's usual time is too: 3 times its median and 500ms over it. */
const OUTLIER: OutlierRule = { factor: 3, minMs: 500 };
/** How often the summary line is written. */
export const TIMINGS_SUMMARY_MS = 10 * 60_000;

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** Times the steps of one request: `mark(step)` ends a step; `describe()` lists them (`cards 80ms, pane 12ms`). */
export function stepTimer(clock: () => number = () => performance.now()): { mark: (step: string) => void; total: () => number; describe: () => string } {
  const start = clock();
  let last = start;
  const steps: string[] = [];
  return {
    mark: (step) => {
      const now = clock();
      steps.push(`${step} ${Math.round(now - last)}ms`);
      last = now;
    },
    total: () => clock() - start,
    describe: () => steps.join(', '),
  };
}

export class RequestTimings {
  private readonly stats = new LatencyStats();
  private period = new Map<string, number[]>();

  constructor(private readonly slowMs = SLOW_REQUEST_MS) {}

  /** Records `ms` for `label`; returns the line to log when it was slow, else undefined. */
  note(label: string, ms: number, steps: string, now: number): string | undefined {
    const outlier = this.stats.record(label, ms, OUTLIER, now);
    const list = this.period.get(label) ?? [];
    list.push(ms);
    this.period.set(label, list);
    if (ms < this.slowMs && !outlier) return undefined;
    const usual = outlier ? `, usually ${Math.round(outlier.p50)}ms (p90 ${Math.round(outlier.p90)}ms, last ${outlier.samples})` : '';
    return `slow: ${label} took ${Math.round(ms)}ms${usual}${steps ? `: ${steps}` : ''}`;
  }

  /** `timings: GET detail n=120 p50 180ms p90 400ms max 2100ms; …` since the last summary, then starts a new period; undefined with nothing recorded. */
  summary(): string | undefined {
    const parts = [...this.period.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, list]) => {
        const sorted = [...list].sort((a, b) => a - b);
        return `${label} n=${sorted.length} p50 ${Math.round(quantile(sorted, 0.5))}ms p90 ${Math.round(quantile(sorted, 0.9))}ms max ${Math.round(sorted[sorted.length - 1])}ms`;
      });
    this.period = new Map();
    return parts.length ? `timings: ${parts.join('; ')}` : undefined;
  }
}

/**
 * How late a timer that should fire every `intervalMs` fired, by a monotonic clock (`performance.now`), which stands
 * still while the machine sleeps: a laptop that slept is not taken for a blocked event loop.
 */
export function timerLag(prev: number, now: number, intervalMs: number): number {
  return Math.max(0, Math.round(now - prev - intervalMs));
}
