import { describe, expect, it } from 'vitest';
import { countHead, durationText, timeLeftText } from '../src/core/usageProgress';

const p = { phase: 'reading' as const, found: 900, listed: 900, files: 120, totalFiles: 900, bytes: 3 * 1024 ** 3, totalBytes: 12 * 1024 ** 3 };

describe('count progress text', () => {
  it("says what the count does, in the popover's words and the page's", () => {
    expect(countHead(p, 'transcripts')).toBe('Reading 120 of 900 transcripts…');
    expect(countHead(p, 'Claude transcripts', true)).toBe('Reading 120 of 900 transcripts: 3.0 GB of 12.0 GB');
    expect(countHead({ ...p, phase: 'listing', listed: 0 }, 'transcripts')).toBe('Listing transcripts: 900 found…');
    expect(countHead({ ...p, phase: 'listing', listed: 0, found: 0 }, 'Claude transcripts')).toBe('Listing Claude transcripts…');
    expect(countHead({ ...p, phase: 'listing', listed: 12 }, 'Claude transcripts')).toBe('Checking which Claude transcripts changed: 12 of 900…');
    expect(countHead({ ...p, phase: 'today' }, 'transcripts')).toBe('Counting today…');
  });

  it('says how long, in minutes or (on the page) seconds too', () => {
    expect(durationText(45_000, true)).toBe('45 s');
    expect(durationText(45_000, false)).toBe('1 min');
    expect(durationText(89_600, true)).toBe('2 min');
    expect(durationText(89_600, false)).toBe('1 min');
    expect(durationText(65 * 60_000, false)).toBe('1 h 5 min');
    expect(timeLeftText(undefined, false)).toBe('');
    expect(timeLeftText(undefined, true, 'working out the time left')).toBe('working out the time left');
    expect(timeLeftText(30_000, true)).toBe('less than a minute left');
    expect(timeLeftText(240_000, true)).toBe('about 4 min left');
  });
});
