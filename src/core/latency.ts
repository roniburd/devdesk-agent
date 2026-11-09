/** How many recent durations are kept per label. */
const WINDOW = 50;
/** Durations a label needs before any of them can count as an outlier. */
const MIN_SAMPLES = 10;
/** An outlier is logged at most this often per label, so a burst of slow ones is one line. */
const COOLDOWN_MS = 10_000;

/** When a duration counts as an outlier: `factor` times the label's median and at least `minMs` over it; factor 0: never. */
export interface OutlierRule {
  factor: number;
  minMs: number;
}

/** A duration far above what the label usually takes. */
export interface Outlier {
  ms: number;
  p50: number;
  p90: number;
  samples: number;
}

const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * Recent durations per label (a command, a board render, a tmux call), to tell when one took much longer than that
 * label usually does: a slow moment worth debugging, unlike an operation that is always slow.
 */
export class LatencyStats {
  private readonly samples = new Map<string, number[]>();
  private readonly lastReported = new Map<string, number>();

  /** Records `ms` for `label`; returns it as an outlier against the durations before it, unless one was just reported. */
  record(label: string, ms: number, rule: OutlierRule, now: number): Outlier | undefined {
    const list = this.samples.get(label) ?? [];
    let outlier: Outlier | undefined;
    if (rule.factor > 0 && list.length >= MIN_SAMPLES) {
      const sorted = [...list].sort((a, b) => a - b);
      const p50 = quantile(sorted, 0.5);
      if (ms >= rule.factor * p50 && ms - p50 >= rule.minMs && now - (this.lastReported.get(label) ?? -Infinity) >= COOLDOWN_MS) {
        outlier = { ms, p50, p90: quantile(sorted, 0.9), samples: list.length };
        this.lastReported.set(label, now);
      }
    }
    list.push(ms);
    if (list.length > WINDOW) list.shift();
    this.samples.set(label, list);
    return outlier;
  }
}
