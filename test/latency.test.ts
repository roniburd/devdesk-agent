import { describe, expect, it } from 'vitest';
import { LatencyStats } from '../src/core/latency';

const rule = { factor: 3, minMs: 50 };

describe('LatencyStats', () => {
  const warmed = (ms = 20, n = 10) => {
    const stats = new LatencyStats();
    for (let i = 0; i < n; i++) stats.record('board render', ms, rule, i);
    return stats;
  };

  it('reports a duration far above the usual one, with the usual one', () => {
    expect(warmed().record('board render', 200, rule, 100_000)).toEqual({ ms: 200, p50: 20, p90: 20, samples: 10 });
  });

  it('needs enough samples first', () => {
    expect(warmed(20, 9).record('board render', 500, rule, 100_000)).toBeUndefined();
  });

  it('ignores a big ratio that is only a few milliseconds (minMs) and a small ratio (factor)', () => {
    expect(warmed(2).record('board render', 30, rule, 100_000)).toBeUndefined();
    expect(warmed(200).record('board render', 500, rule, 100_000)).toBeUndefined();
  });

  it('keeps labels apart, never reports with factor 0, and reports one of a burst', () => {
    const stats = warmed();
    expect(stats.record('tmux attach', 500, rule, 100_000)).toBeUndefined();
    expect(stats.record('board render', 500, { factor: 0, minMs: 0 }, 100_000)).toBeUndefined();
    expect(stats.record('board render', 500, rule, 100_000)).toBeDefined();
    expect(stats.record('board render', 500, rule, 100_500)).toBeUndefined();
  });
});
