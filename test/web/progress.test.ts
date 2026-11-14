import { describe, expect, it } from 'vitest';
import { elapsed, progressLine, workProgress } from '../../src/core/web/progress';

describe('workProgress', () => {
  const now = 1_000_000;

  it("takes the spinner's verb, time and tokens", () => {
    expect(workProgress({ state: 'working', turnStartedAt: now - 5000 }, { verb: 'Cogitating', seconds: 72, tokens: '↓ 3.4k tokens' }, now)).toEqual({
      verb: 'Cogitating',
      seconds: 72,
      tokens: '↓ 3.4k tokens',
    });
  });

  it("counts from the hooks' turn start when the spinner shows no time, or none shows", () => {
    expect(workProgress({ state: 'working', turnStartedAt: now - 65_500 }, { verb: 'Pondering' }, now)).toEqual({ verb: 'Pondering', seconds: 65 });
    expect(workProgress({ state: 'working', turnStartedAt: now - 3000 }, undefined, now)).toEqual({ seconds: 3 });
  });

  it('is undefined with no spinner and no turn the hooks say still works', () => {
    expect(workProgress({ state: 'done', turnStartedAt: now - 3000 }, undefined, now)).toBeUndefined();
    expect(workProgress({ state: 'working' }, undefined, now)).toBeUndefined();
  });
});

describe('progressLine', () => {
  it("reads like Claude's spinner, its time counted on", () => {
    expect(progressLine({ verb: 'Cogitating', seconds: 72, tokens: '↓ 3.4k tokens' }, 2.6)).toBe('Cogitating… 1m 14s · ↓ 3.4k tokens');
    expect(progressLine({ seconds: 5 })).toBe('Working… 5s');
    expect(progressLine({ verb: 'Pondering' }, 10)).toBe('Pondering…');
    expect(progressLine(undefined)).toBe('Working…');
  });

  it('counts seconds, minutes and hours as the spinner does', () => {
    expect([elapsed(0), elapsed(60), elapsed(3723)]).toEqual(['0s', '1m 0s', '1h 2m 3s']);
  });
});
