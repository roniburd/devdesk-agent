import { describe, expect, it } from 'vitest';
import { REDRAW_SUMMARY_MS, RedrawLog, summarizeRedraws } from '../src/core/boardRedraws';

const redraw = (scriptMs: number, frameMs: number, rebuilt: number, cards = 91) => ({ scriptMs, frameMs, rebuilt, cards });

describe('summarizeRedraws', () => {
  it('says how many redraws, their script and paint times, and how many cards each rebuilt', () => {
    const line = summarizeRedraws([redraw(2.04, 8, 1), redraw(9, 21, 3), redraw(1.5, 7, 0)], 60_000);
    expect(line).toBe('board: 3 redraws in the last 60s; script median 2ms, max 9ms; painted median 8ms, max 21ms; cards rebuilt median 1, max 3; 91 cards shown');
  });

  it('says one redraw in the singular', () => {
    expect(summarizeRedraws([redraw(1, 7, 91)], 90_000)).toMatch(/^board: 1 redraw in the last 90s;/);
  });
});

describe('RedrawLog', () => {
  it('sums up the redraws once a minute has passed, then starts again', () => {
    const log = new RedrawLog(0);
    expect(log.add(redraw(1, 7, 1), 1_000)).toBeUndefined();
    expect(log.add(redraw(3, 9, 2), REDRAW_SUMMARY_MS - 1)).toBeUndefined();
    expect(log.add(redraw(2, 8, 0), REDRAW_SUMMARY_MS)).toMatch(/^board: 3 redraws in the last 60s;/);
    expect(log.add(redraw(2, 8, 0), REDRAW_SUMMARY_MS + 1_000)).toBeUndefined();
    // Redraws that stopped for a while are summed up with the next one, over the time that really passed.
    expect(log.add(redraw(2, 8, 0), 5 * REDRAW_SUMMARY_MS)).toMatch(/^board: 2 redraws in the last 240s;/);
  });
});
