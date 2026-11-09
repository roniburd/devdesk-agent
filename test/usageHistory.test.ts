import { describe, expect, it } from 'vitest';
import { UsageScan } from '../src/core/usage';
import {
  addDays,
  DayCounter,
  dayKey,
  dayStart,
  decodeDay,
  decodeHistory,
  type DayUsage,
  encodeDay,
  formatShare,
  OTHER,
  periods,
  type PlaceDay,
  placesOf,
  pruneHistory,
  sumDays,
  trimLedger,
  upgradeDay,
  usageByDay,
  usagePage,
  usagePopover,
  weekOf,
} from '../src/core/usageHistory';
import { DEVDESK, type Place, UNKNOWN } from '../src/core/usagePlace';
import { scopeDays } from '../src/core/usageScope';

const at = (day: string, hour = 12) => dayStart(day) + hour * 3600_000;
const line = (requestId: string, ms: number, usage: Record<string, number>, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', requestId, timestamp: new Date(ms).toISOString(), message: { id: `m-${requestId}`, model, usage } });
const scan = (...lines: string[]) => {
  const s = new UsageScan();
  s.feed(Buffer.from(`${lines.join('\n')}\n`));
  return s;
};
const day = (key: string, total: number, cached = 0, extra: Partial<DayUsage> = {}): DayUsage => ({
  day: key,
  sessions: { total, cached, requests: 1 },
  byModel: [{ model: 'm', tokens: { total, cached, requests: 1 } }],
  bySession: [{ sessionId: 's1', name: 'One', total, cached, requests: 1 }],
  devdesk: { total: 0, cached: 0, requests: 0, failed: 0 },
  ...extra,
});

describe('days', () => {
  it('keys local days, across a DST change', () => {
    expect(dayKey(new Date(2026, 10, 1, 23, 59).getTime())).toBe('2026-11-01');
    expect(dayKey(new Date(2026, 10, 2, 0, 0).getTime())).toBe('2026-11-02');
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayKey(dayStart('2026-11-01'))).toBe('2026-11-01');
  });

  it('starts weeks on Monday', () => {
    expect(weekOf('2026-11-01')).toBe('2026-10-26'); // a Sunday
    expect(weekOf('2026-11-02')).toBe('2026-11-02'); // a Monday
    expect(weekOf('2026-11-04')).toBe('2026-11-02');
  });

  it('formats cached with its share', () => {
    expect(formatShare(63_000_000, 114_500_000)).toBe('63.0M (55%)');
    expect(formatShare(0, 0)).toBe('0');
    expect(formatShare(5, 10)).toBe('5 (50%)');
  });
});

describe('usageByDay', () => {
  it('splits requests by local day, counts each once, and keeps the top sessions with the rest summed', () => {
    const scans = new Map([
      ['s1', [scan(line('r1', at('2026-10-31'), { input_tokens: 10, cache_read_input_tokens: 90 }), line('r2', at('2026-11-01'), { output_tokens: 5 }))]],
      // A fork copied r1.
      ['s2', [scan(line('r1', at('2026-10-31'), { input_tokens: 10, cache_read_input_tokens: 90 }), line('r3', at('2026-11-01'), { input_tokens: 1 }, 'claude-haiku-5-5'))]],
      ['s3', [scan(line('r4', at('2026-11-01'), { input_tokens: 2 }))]],
    ]);
    const titled = new Map([['s4', [scan(JSON.stringify({ type: 'ai-title', aiTitle: 'Claude named it' }), JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' }), line('r9', at('2026-11-01'), { input_tokens: 1 }))]], ['s5', [scan(JSON.stringify({ type: 'ai-title', aiTitle: 'Only AI' }), line('r10', at('2026-11-01'), { input_tokens: 1 }))]]]);
    expect(usageByDay(titled, '', 0, new Map()).get('2026-11-01')!.bySession.map((s) => s.name).sort()).toEqual(['Only AI', 'Renamed']);
    const ledger = [
      JSON.stringify({ at: at('2026-11-01'), ok: true, input: 89, cacheRead: 11, output: 3, model: 'claude-haiku-5-5' }),
      JSON.stringify({ at: at('2026-11-01'), ok: false, input: 1 }),
      'garbage',
    ].join('\n');
    const days = usageByDay(scans, ledger, dayStart('2026-10-31'), new Map([['s1', 'Fix the parser']]), 1);
    expect([...days.keys()]).toEqual(['2026-10-31', '2026-11-01']);
    const oct31 = days.get('2026-10-31')!;
    expect(oct31.sessions).toEqual({ total: 100, cached: 90, requests: 1 });
    expect(oct31.bySession).toEqual([{ sessionId: 's1', name: 'Fix the parser', total: 100, cached: 90, requests: 1 }]);
    const nov1 = days.get('2026-11-01')!;
    expect(nov1.sessions).toEqual({ total: 8, cached: 0, requests: 3 });
    expect(nov1.byModel.map((m) => m.model)).toEqual(['claude-haiku-5-5 (DevDesk)', 'claude-opus-5-5', 'claude-haiku-5-5', 'unknown (DevDesk)']);
    expect(nov1.bySession).toEqual([
      { sessionId: 's1', name: 'Fix the parser', total: 5, cached: 0, requests: 1 },
      { sessionId: OTHER, name: '2 other sessions', total: 3, cached: 0, requests: 2 },
    ]);
    expect(nov1.devdesk).toEqual({ total: 104, cached: 11, requests: 2, failed: 1 });
  });

  it("lists DevDesk's own calls by model too, apart from the sessions' models", () => {
    const scans = new Map([['s1', [scan(line('r1', at('2026-11-01'), { input_tokens: 500 }), line('r2', at('2026-11-01'), { input_tokens: 1 }, 'claude-haiku-5-5'))]]]);
    const ledger = [
      JSON.stringify({ at: at('2026-11-01'), ok: true, input: 89, cacheRead: 11, output: 3, model: 'claude-haiku-5-5' }),
      JSON.stringify({ at: at('2026-11-01'), ok: true, input: 7, model: 'claude-haiku-5-5' }),
      JSON.stringify({ at: at('2026-11-01'), ok: false, input: 1 }),
    ].join('\n');
    const nov1 = usageByDay(scans, ledger, 0, new Map()).get('2026-11-01')!;
    expect(nov1.byModel).toEqual([
      { model: 'claude-opus-5-5', tokens: { total: 500, cached: 0, requests: 1 } },
      { model: 'claude-haiku-5-5 (DevDesk)', tokens: { total: 110, cached: 11, requests: 2 } },
      { model: 'claude-haiku-5-5', tokens: { total: 1, cached: 0, requests: 1 } },
      { model: 'unknown (DevDesk)', tokens: { total: 1, cached: 0, requests: 1 } },
    ]);
    expect(nov1.sessions).toEqual({ total: 501, cached: 0, requests: 2 });
  });

  it('skips what came before since', () => {
    const scans = new Map([['s1', [scan(line('r1', at('2026-10-30'), { input_tokens: 10 }))]]]);
    expect(usageByDay(scans, '', dayStart('2026-10-31'), new Map()).size).toBe(0);
  });
});

describe('history file', () => {
  it('round-trips a day and skips bad lines', () => {
    const d = day('2026-10-31', 100, 90, { devdesk: { total: 5, cached: 1, requests: 2, failed: 1 } });
    expect(decodeDay(encodeDay(d))).toEqual(d);
    const map = decodeHistory(`${encodeDay(d)}\nnot json\n{"day":"bad"}\n`);
    expect([...map.keys()]).toEqual(['2026-10-31']);
  });

  it('drops days older than the limit, then the oldest until it fits', () => {
    const days = ['2026-10-01', '2026-10-20', '2026-10-30', '2026-10-31'].map((k) => day(k, 10));
    const byDays = pruneHistory(days, '2026-11-01', 15, 1e6);
    expect(byDays.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-30', '2026-10-31']);
    const one = Buffer.byteLength(`${encodeDay(days[3])}\n`);
    const bySize = pruneHistory(days, '2026-11-01', 365, one * 2 + 1);
    expect(bySize.days.map((d) => d.day)).toEqual(['2026-10-30', '2026-10-31']);
    expect(bySize.bytes).toBe(Buffer.byteLength(bySize.text));
    expect(bySize.bytes).toBeLessThanOrEqual(one * 2 + 1);
    expect(pruneHistory(days, '2026-11-01', 365, 10).days).toEqual([]);
  });

  it('keeps a line small: a year of busy days fits well under the default 10 MB', () => {
    const sessions = Array.from({ length: 21 }, (_, i) => ({ sessionId: `${i}`.padStart(36, 'a'), name: 'A fairly long session name for a feature', total: 123456789, cached: 98765432, requests: 1234 }));
    const busy = day('2026-10-31', 1e9, 5e8, { bySession: sessions, byModel: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ model, tokens: { total: 1e9, cached: 5e8, requests: 9999 } })) });
    expect(Buffer.byteLength(encodeDay(busy)) * 365).toBeLessThan(2 * 1024 * 1024);
  });

  it("trims the ledger to what's after since", () => {
    const text = [JSON.stringify({ at: 1 }), JSON.stringify({ at: 5 }), 'bad', ''].join('\n');
    expect(trimLedger(text, 3)).toBe(`${JSON.stringify({ at: 5 })}\n`);
  });
});

describe('views', () => {
  it('sums days into a period, merging sessions and the rest', () => {
    const a = day('2026-10-30', 100, 50, { bySession: [{ sessionId: 's1', name: 'Old name', total: 100, cached: 50, requests: 1 }] });
    const b = day('2026-10-31', 300, 0, {
      bySession: [
        { sessionId: 's1', name: 'New name', total: 200, cached: 0, requests: 1 },
        { sessionId: OTHER, name: '3 other sessions', total: 100, cached: 0, requests: 3 },
      ],
    });
    const v = sumDays([a, b], '2026-10-30', 'x', 'x');
    expect(v.sessions).toMatchObject({ total: 400, cached: 50, totalText: '400', cachedText: '50 (13%)' });
    expect(v.top.map((s) => [s.name, s.total])).toEqual([
      ['New name', 300],
      ['Other sessions', 100],
    ]);
  });

  it('lists every period, empty ones included', () => {
    const days = [day('2026-10-20', 10), day('2026-11-01', 20)];
    const weeks = periods(days, 'week', '2026-10-20', '2026-11-01');
    expect(weeks.map((w) => [w.key, w.sessions.total])).toEqual([
      ['2026-10-19', 10],
      ['2026-10-26', 20],
    ]);
    expect(weeks[0].label).toBe('Week of Oct 19');
    const months = periods(days, 'month', '2026-09-15', '2026-11-01');
    expect(months.map((m) => [m.key, m.label, m.sessions.total])).toEqual([
      ['2026-09-01', 'September 2026', 0],
      ['2026-10-01', 'October 2026', 10],
      ['2026-11-01', 'November 2026', 20],
    ]);
    expect(periods(days, 'day', '2026-10-30', '2026-11-01').map((d) => d.sessions.total)).toEqual([0, 0, 20]);
  });

  it('charts back to the oldest usage, at most the span', () => {
    const days = [day('2026-10-20', 10), day('2026-11-01', 20)];
    const page = usagePage(days, '2026-11-01', { days: 1, bytes: 100, maxBytes: 1000, keepDays: 365, oldest: '2026-10-20' });
    expect(page.units.day[0].key).toBe('2026-10-20');
    expect(page.units.day).toHaveLength(13);
    expect(page.units.week).toHaveLength(2); // Nov 1 is a Sunday, in the week of Oct 26
    expect(page.units.month).toHaveLength(2);
    const old = usagePage([day('2025-01-01', 1), ...days], '2026-11-01', page.history);
    expect(old.units.day).toHaveLength(30);
    expect(old.units.week).toHaveLength(26);
    expect(old.units.month).toHaveLength(23); // Jan 2025 to Nov 2026
  });

  it('shows today, this week and the last 30 days in the popover', () => {
    const days = [day('2026-09-01', 1000), day('2026-10-20', 100), day('2026-10-27', 10, 5), day('2026-11-01', 1)];
    const p = usagePopover(days, '2026-11-01');
    expect(p.periods.map((x) => [x.label, x.sessions.total])).toEqual([
      ['Today', 1],
      ['This week', 11],
      ['Last 30 days', 111],
    ]);
    expect(p.periods[1].sessions.cachedText).toBe('5 (45%)');
    expect(p.today.models).toHaveLength(1);
  });
});

describe('usage by place', () => {
  const at = new Date(2026, 10, 1, 12).getTime();
  /** A scan with requests `[id, cwd, total]` from session transcripts; cwd decides the place. */
  const scanOf = (entries: [string, string | undefined, number][], title?: string) => {
    const s = new UsageScan();
    for (const [id, cwd, total] of entries) s.entries.set(id, { at, model: 'opus', total, cached: 0, ...(cwd ? { cwd } : {}) });
    if (title) s.customTitle = title;
    return s;
  };
  const fake = (cwd: string | undefined): Place => (cwd ? { project: cwd.split('/wt/')[0], kind: 'git', worktree: cwd.split('/wt/')[1] ?? 'main' } : { project: UNKNOWN, kind: 'folder', worktree: 'main' });

  it('sums each place’s tokens, models and sessions, and DevDesk’s calls in a place of their own', () => {
    const c = new DayCounter(0, Infinity, fake);
    c.addScan('s1', scanOf([['a', '/r', 10], ['b', '/r/wt/x', 5]], 'One'));
    c.addScan('s2', scanOf([['c', '/r', 1], ['d', undefined, 2]]));
    c.addLedger(`${JSON.stringify({ at, model: 'haiku', input: 7, ok: true })}\n`);
    const day = c.day('2026-11-01', new Map())!;
    const places = day.byPlace as Exclude<DayUsage['byPlace'], 'unknown' | undefined>;
    expect(places.map((p) => [p.project, p.worktree, p.tokens.total])).toEqual([
      ['/r', 'main', 11],
      [DEVDESK, 'main', 7],
      ['/r', 'x', 5],
      [UNKNOWN, 'main', 2],
    ]);
    expect(places[0].bySession.map((s) => [s.name, s.total])).toEqual([['One', 10], ['session s2', 1]]);
    expect(places[1].byModel.map((m) => m.model)).toEqual(['haiku (DevDesk)']);
    expect(places.reduce((n, p) => n + p.tokens.total, 0)).toBe(day.sessions.total + day.devdesk.total);
  });

  it('keeps a day’s top 30 places and top 5 sessions a place, summing the rest', () => {
    const c = new DayCounter(0, Infinity, fake);
    for (let i = 0; i < 32; i++) c.addScan(`p${i}`, scanOf([[`r${i}`, `/p${i}`, 100 - i]]));
    for (let i = 0; i < 7; i++) c.addScan(`s${i}`, scanOf([[`q${i}`, '/p0', 1]]));
    // DevDesk's one small call is kept as its own place (one of the 30), never summed into the other projects.
    c.addLedger(`${JSON.stringify({ at, model: 'haiku', input: 1, ok: true })}\n`);
    const day = c.day('2026-11-01', new Map())!;
    const places = day.byPlace as Exclude<DayUsage['byPlace'], 'unknown' | undefined>;
    expect(places).toHaveLength(31);
    expect(places[30]).toMatchObject({ project: OTHER, tokens: { total: 71 + 70 + 69, requests: 3 } });
    expect(places[30].byModel.map((m) => m.model)).toEqual(['opus']);
    expect(places.filter((p) => p.project === DEVDESK)).toHaveLength(1);
    const others = scopeDays([day], { kind: 'project', project: OTHER })[0];
    expect(others.sessions).toEqual({ total: 210, cached: 0, requests: 3 });
    expect(others.byModel.map((m) => m.model)).toEqual(['opus']);
    expect(places[0].bySession).toHaveLength(6);
    expect(places[0].bySession[5]).toMatchObject({ sessionId: OTHER, requests: 3 });
  });

  it('stores places in the history line and reads them back; old lines have none', () => {
    const c = new DayCounter(0, Infinity, fake);
    c.addScan('s1', scanOf([['a', '/r/wt/x', 10]], 'One'));
    const day = c.day('2026-11-01', new Map())!;
    expect(decodeDay(encodeDay(day))).toEqual(day);
    expect(decodeDay(encodeDay({ ...day, byPlace: 'unknown' }))?.byPlace).toBe('unknown');
    const { byPlace: _, ...old } = day;
    expect(decodeDay(encodeDay(old))).not.toHaveProperty('byPlace');
  });

  const legacy: DayUsage = {
    day: '2026-10-01',
    sessions: { total: 100, cached: 10, requests: 4 },
    byModel: [
      { model: 'opus', tokens: { total: 100, cached: 10, requests: 4 } },
      { model: 'haiku (DevDesk)', tokens: { total: 9, cached: 0, requests: 3 } },
    ],
    bySession: [{ sessionId: 's1', name: 'One', total: 100, cached: 10, requests: 4 }],
    devdesk: { total: 9, cached: 0, requests: 3, failed: 0 },
  };

  it('reads a day stored before places were counted as the Unknown project and DevDesk', () => {
    expect(placesOf(legacy).map((p) => [p.project, p.tokens.total, p.byModel.map((m) => m.model)])).toEqual([
      [UNKNOWN, 100, ['opus']],
      [DEVDESK, 9, ['haiku (DevDesk)']],
    ]);
  });

  it('upgrades an old day with each part the recount found in full, else keeps it as stored', () => {
    expect(upgradeDay(legacy, undefined)).toEqual({ ...legacy, byPlace: 'unknown' });
    const c = new DayCounter(0, Infinity, fake);
    c.addScan('s1', scanOf([['a', '/r', 25], ['b', '/r', 25], ['c', '/r', 25], ['d', '/r', 25]]));
    const recount = { ...c.day('2026-11-01', new Map())!, day: legacy.day };
    // The sessions are all there; the ledger was trimmed, so DevDesk's calls stay as stored.
    const up = upgradeDay(legacy, recount);
    expect(up.sessions).toEqual(recount.sessions);
    expect(up.devdesk).toEqual(legacy.devdesk);
    expect((up.byPlace as { project: string }[]).map((p) => p.project)).toEqual(['/r', DEVDESK]);
    expect(up.byModel.map((m) => m.model)).toEqual(['opus', 'haiku (DevDesk)']);
    // Part of the transcripts is gone: the sessions stay as stored too.
    const partial = { ...recount, sessions: { ...recount.sessions, requests: 2 } };
    expect(upgradeDay(legacy, partial)).toEqual({ ...legacy, byPlace: 'unknown' });
  });

  it('upgrades a day with more places than kept, keeping DevDesk’s stored calls as their own place', () => {
    const c = new DayCounter(0, Infinity, fake);
    for (let i = 0; i < 31; i++) c.addScan(`p${i}`, scanOf([[`r${i}`, `/p${i}`, 100 + i]]));
    c.addLedger(`${JSON.stringify({ at, model: 'haiku', input: 1, ok: true })}\n`);
    const recount = { ...c.day('2026-11-01', new Map())!, day: legacy.day };
    const old: DayUsage = {
      ...legacy,
      sessions: { ...recount.sessions },
      byModel: [{ model: 'haiku (DevDesk)', tokens: { total: 50, cached: 0, requests: 2 } }],
      devdesk: { total: 50, cached: 0, requests: 2, failed: 0 },
    };
    const check = (places: PlaceDay[]) => {
      expect(places).toHaveLength(31);
      expect(places.reduce((n, p) => n + p.tokens.total, 0)).toBe(recount.sessions.total + 50);
      expect(places.reduce((n, p) => n + p.tokens.requests, 0)).toBe(31 + 2);
      expect(places.find((p) => p.project === DEVDESK)).toMatchObject({ tokens: { total: 50, requests: 2 } });
      const other = places[30];
      expect(other).toMatchObject({ project: OTHER, tokens: { total: 100 + 101, requests: 2 } });
      expect(other.byModel.map((m) => [m.model, m.tokens.total])).toEqual([['opus', 201]]);
      expect(other.bySession).toEqual([expect.objectContaining({ sessionId: OTHER, total: 201, requests: 2 })]);
    };
    check(upgradeDay(old, recount).byPlace as PlaceDay[]);
    // A recount with no DevDesk call: adding the stored ones moves the smallest project into the other projects.
    const plain = new DayCounter(0, Infinity, fake);
    for (let i = 0; i < 31; i++) plain.addScan(`p${i}`, scanOf([[`r${i}`, `/p${i}`, 100 + i]]));
    check(upgradeDay(old, { ...plain.day('2026-11-01', new Map())!, day: legacy.day }).byPlace as PlaceDay[]);
  });

  it('reads a day whose places do not add up as one stored before places were counted', () => {
    const c = new DayCounter(0, Infinity, fake);
    c.addScan('s1', scanOf([['a', '/r', 10], ['b', '/q', 5]]));
    const line = JSON.parse(encodeDay(c.day('2026-11-01', new Map())!));
    expect(decodeDay(JSON.stringify({ ...line, p: [['/r', 'zz', 'main', [10, 0, 1], [], []]] }))).not.toHaveProperty('byPlace');
    expect(decodeDay(JSON.stringify({ ...line, p: line.p.slice(1) }))).not.toHaveProperty('byPlace');
    expect(decodeDay(JSON.stringify({ ...line, p: [] }))).not.toHaveProperty('byPlace');
  });
});
