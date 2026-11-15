import { describe, expect, it } from 'vitest';
import { RequestTimings, stepTimer, timerLag } from '../../src/core/web/timings';

describe('RequestTimings', () => {
  it('logs a request over the slow limit with its steps, and none under it', () => {
    const t = new RequestTimings(2000);
    expect(t.note('GET detail', 150, 'cards 100ms, turns 50ms', 0)).toBeUndefined();
    expect(t.note('GET detail', 2500, 'cards 2400ms, turns 100ms', 1)).toBe('slow: GET detail took 2500ms: cards 2400ms, turns 100ms');
  });

  it("logs one far over its label's usual time, with that time", () => {
    const t = new RequestTimings(10_000);
    for (let i = 0; i < 10; i++) t.note('GET detail', 200, '', i);
    expect(t.note('GET detail', 1500, 'pane 1400ms', 100)).toBe('slow: GET detail took 1500ms, usually 200ms (p90 200ms, last 10): pane 1400ms');
    // 3x the median but under 500ms over it: usual enough.
    for (let i = 0; i < 10; i++) t.note('GET cards', 20, '', i);
    expect(t.note('GET cards', 90, '', 100_000)).toBeUndefined();
  });

  it('sums up each label since the last summary, then starts over', () => {
    const t = new RequestTimings();
    for (const ms of [100, 200, 300, 400, 2500]) t.note('GET detail', ms, '', 0);
    t.note('poll cards', 80, '', 0);
    expect(t.summary()).toBe('timings: GET detail n=5 p50 300ms p90 2500ms max 2500ms; poll cards n=1 p50 80ms p90 80ms max 80ms');
    expect(t.summary()).toBeUndefined();
  });
});

describe('stepTimer', () => {
  it('times each step from the end of the one before', () => {
    let now = 1000;
    const s = stepTimer(() => now);
    now = 1080;
    s.mark('cards');
    now = 1092.4;
    s.mark('pane');
    expect(s.describe()).toBe('cards 80ms, pane 12ms');
    expect(s.total()).toBeCloseTo(92.4);
  });
});

describe('timerLag', () => {
  it('is how much later than its interval a timer fired, never below 0', () => {
    expect(timerLag(0, 1700, 1000)).toBe(700);
    expect(timerLag(0, 990, 1000)).toBe(0);
  });
});
