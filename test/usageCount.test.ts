import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageReader, type UsageScan } from '../src/core/usage';
import { type DayUsage, decodeHistory, encodeDay } from '../src/core/usageHistory';
import { appendLedgerLine, type CountProgress, type CountRequest, countUsage, mergeHistory, readEta, trimLedgerFile } from '../src/usageCount';

const noon = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(12, 0, 0, 0);
  return d;
};
const key = (daysAgo: number) => {
  const d = noon(daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const line = (id: string, daysAgo: number, input: number) =>
  JSON.stringify({ type: 'assistant', requestId: id, timestamp: noon(daysAgo).toISOString(), message: { id: `m-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: input } } });

describe('countUsage', () => {
  let dir: string;
  let project: string;
  let req: CountRequest;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-usagecount-'));
    project = join(dir, 'projects', '-w-x');
    await mkdir(project, { recursive: true });
    req = {
      projectsDir: join(dir, 'projects'),
      historyPath: join(dir, 'state', 'usage-history.jsonl'),
      ledgerPath: join(dir, 'state', 'usage.jsonl'),
      keepDays: 365,
      maxBytes: 10 * 1024 * 1024,
      names: [],
      now: Date.now(),
      saveEveryMs: 0,
    };
    // Sessions over four days; s4 is a fork of s1, with s1's first request copied in.
    const write = async (name: string, lines: string[], lastWritten: Date) => {
      const path = join(project, name);
      await writeFile(path, `${lines.join('\n')}\n`);
      await utimes(path, lastWritten, lastWritten);
    };
    await write('s1.jsonl', [line('a', 3, 100), line('b', 2, 10)], noon(2));
    await write('s2.jsonl', [line('c', 2, 1000), line('d', 1, 5)], noon(1));
    await write('s3.jsonl', [line('e', 1, 7), line('f', 0, 3)], new Date());
    await write('s4.jsonl', [line('a', 3, 100), line('g', 0, 11)], new Date());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const totals = (days: { day: string; sessions: { total: number } }[]) => Object.fromEntries(days.map((d) => [d.day, d.sessions.total]));
  const expected = () => ({ [key(3)]: 100, [key(2)]: 1010, [key(1)]: 12, [key(0)]: 14 });

  it('stores the days that ended and counts today live, each request once', async () => {
    const snapshot = await countUsage(new UsageReader(), req);
    expect(totals(snapshot.days)).toEqual(expected());
    expect(snapshot.today).toBe(key(0));
    expect(snapshot.history.days).toBe(3);
    const stored = decodeHistory(await readFile(req.historyPath, 'utf8'));
    expect([...stored.keys()]).toEqual([key(3), key(2), key(1)]);
  });

  it('keeps the days counted before it was stopped, and the next count goes on from there', async () => {
    // Stops at the last transcript to start (s3, yesterday): the days before yesterday are done by then.
    class Stopping extends UsageReader {
      override read(path: string): Promise<UsageScan> {
        if (path.endsWith('s3.jsonl')) return Promise.reject(new Error('window reloaded'));
        return super.read(path);
      }
    }
    await expect(countUsage(new Stopping(), req)).rejects.toThrow('window reloaded');
    const stored = decodeHistory(await readFile(req.historyPath, 'utf8'));
    expect(totals([...stored.values()])).toEqual({ [key(3)]: 100, [key(2)]: 1010 });

    const progress: CountProgress[] = [];
    const snapshot = await countUsage(new UsageReader(), req, (p) => progress.push(p));
    expect(totals(snapshot.days)).toEqual(expected());
    expect(progress.at(-1)!.totalFiles, 's1 is not read again: it was last written before yesterday').toBe(3);
  });

  it('reports its progress, and the next count reads only what was appended', async () => {
    const reader = new UsageReader();
    let progress: CountProgress[] = [];
    await countUsage(reader, req, (p) => progress.push(p));
    const last = progress.at(-1)!;
    expect(last.files).toBe(4);
    expect(last.totalFiles).toBe(4);
    expect(last.bytes).toBe(last.totalBytes);
    expect(last.totalBytes).toBeGreaterThan(0);
    expect(last.savedDays).toBe(3);

    const more = `${line('h', 0, 2)}\n`;
    await appendFile(join(project, 's3.jsonl'), more);
    progress = [];
    const snapshot = await countUsage(reader, { ...req, now: Date.now() }, (p) => progress.push(p));
    expect(progress.at(-1)!.totalBytes).toBe(Buffer.byteLength(more));
    expect(totals(snapshot.days)[key(0)]).toBe(16);
  });

  it('reports listing, then reading, then today, with the days stored so far as it stores them', async () => {
    const progress: CountProgress[] = [];
    await countUsage(new UsageReader(), req, (p) => progress.push(p));
    const phases = progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(['listing', 'reading', 'today']);
    expect(progress.find((p) => p.phase === 'reading')!.found).toBe(4);
    expect(progress.find((p) => p.phase === 'reading')!.listed).toBe(4);
    const stored = progress.filter((p) => p.stored);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.at(-1)!.stored!.days.map((d) => d.day)).toEqual([key(3), key(2), key(1)]);
    expect(stored.at(-1)!.savedThrough).toBe(key(1));
    const last = progress.at(-1)!;
    expect(last.bytes).toBe(last.totalBytes);
    expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  const cwdLine = (id: string, daysAgo: number, input: number, cwd: string) =>
    JSON.stringify({ type: 'assistant', requestId: id, cwd, timestamp: noon(daysAgo).toISOString(), message: { id: `m-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: input } } });
  const legacyLine = (daysAgo: number, total: number, requests: number) => JSON.stringify({ day: key(daysAgo), s: [total, 0, requests], m: [], x: [], d: [0, 0, 0, 0] });

  it('counts a day stored before places once more, when its transcripts are all there', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    // Stored by an older version: day 2 (1010 tokens in 2 requests), and a day 40 days ago whose transcripts are gone.
    await writeFile(req.historyPath, `${legacyLine(40, 77, 1)}\n${legacyLine(2, 1010, 2)}\n${legacyLine(1, 12, 2)}\n`);
    await writeFile(join(project, 's1.jsonl'), `${cwdLine('a', 3, 100, dir)}\n${cwdLine('b', 2, 10, dir)}\n`);
    await utimes(join(project, 's1.jsonl'), noon(2), noon(2));
    const first = await countUsage(new UsageReader(), req);
    const byDay = new Map(first.days.map((d) => [d.day, d]));
    expect(Array.isArray(byDay.get(key(2))!.byPlace)).toBe(true);
    expect(byDay.get(key(2))!.sessions.total).toBe(1010);
    expect(byDay.get(key(40))!.byPlace).toBe('unknown');
    expect(byDay.get(key(40))!.sessions.total).toBe(77);
    // Every stored day is checked now: the next count reads only what changed.
    const stored = decodeHistory(await readFile(req.historyPath, 'utf8'));
    expect([...stored.values()].every((d) => d.byPlace !== undefined)).toBe(true);
  });

  it('keeps a day stored before places as it was when part of its transcripts is gone', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(req.historyPath, `${legacyLine(2, 5000, 9)}\n${legacyLine(1, 12, 2)}\n`);
    const snapshot = await countUsage(new UsageReader(), req);
    const day2 = snapshot.days.find((d) => d.day === key(2))!;
    expect(day2.sessions).toEqual({ total: 5000, cached: 0, requests: 9 });
    expect(day2.byPlace).toBe('unknown');
  });

  it('never counts again a day already stored with places', async () => {
    await countUsage(new UsageReader(), req);
    const before = await readFile(req.historyPath, 'utf8');
    // Its transcript is gone: a recount would find less.
    await rm(join(project, 's2.jsonl'));
    await countUsage(new UsageReader(), { ...req, now: Date.now() });
    expect(await readFile(req.historyPath, 'utf8')).toBe(before);
  });

  it('counts again only the old days not upgraded yet, as a count stopped part way leaves them', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    // Day 3 was upgraded before the stop (its places stored); days 2 and 1 were not reached. Its place is one a
    // recount would not find (the transcripts have no `cwd`), so a recount would show.
    const tokens = { total: 100, cached: 0, requests: 1 };
    const place = { project: '/w/p', kind: 'folder' as const, worktree: 'main', tokens, byModel: [], bySession: [] };
    const upgraded = encodeDay({ day: key(3), sessions: tokens, byModel: [], bySession: [], devdesk: { total: 0, cached: 0, requests: 0, failed: 0 }, byPlace: [place] });
    await writeFile(req.historyPath, `${upgraded}\n${legacyLine(2, 1010, 2)}\n${legacyLine(1, 12, 2)}\n`);
    const done = await countUsage(new UsageReader(), req);
    expect(totals(done.days)).toEqual(expected());
    expect(done.days.find((d) => d.day === key(3))!.byPlace).toEqual([place]);
    expect(done.days.every((d) => d.byPlace !== undefined)).toBe(true);
  });

  it('a recount of old days stopped part way keeps the ones it did not reach as they were, and the next count goes on from there', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    // Stored before places: a day 40 days ago whose transcripts are gone, and days 2 and 1.
    await writeFile(req.historyPath, `${legacyLine(40, 77, 1)}\n${legacyLine(2, 1010, 2)}\n${legacyLine(1, 12, 2)}\n`);
    class Stopping extends UsageReader {
      override read(path: string): Promise<UsageScan> {
        if (path.endsWith('s3.jsonl')) return Promise.reject(new Error('window reloaded'));
        return super.read(path);
      }
    }
    await expect(countUsage(new Stopping(), req)).rejects.toThrow('window reloaded');
    const text = await readFile(req.historyPath, 'utf8');
    const stopped = decodeHistory(text);
    // Day 40 had nothing left to read, and day 2 ended before s3 started: both done. Day 1 was not reached.
    expect(stopped.get(key(40))!.byPlace).toBe('unknown');
    expect(stopped.get(key(40))!.sessions.total).toBe(77);
    expect(Array.isArray(stopped.get(key(2))!.byPlace)).toBe(true);
    expect(stopped.get(key(1))!.byPlace).toBeUndefined();
    expect(stopped.get(key(1))!.sessions).toEqual({ total: 12, cached: 0, requests: 2 });
    expect(text.split('\n').find((l) => l.includes(`"${key(1)}"`))).not.toContain('"p"');

    const progress: CountProgress[] = [];
    const done = await countUsage(new UsageReader(), req, (p) => progress.push(p));
    expect(progress.at(-1)!.totalFiles, 'the read starts at day 1, not day 40: s1 is not read again').toBe(3);
    expect(totals(done.days)).toEqual({ [key(40)]: 77, ...expected() });
    expect(done.days.every((d) => d.byPlace !== undefined)).toBe(true);
  });

  it('never counts again a day stored with places that sits between old days, though the read starts before it', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    // Day 5 (stored before places, no transcripts left) makes the read start before the upgraded day 3. A recount of
    // day 3 would put its request under '(unknown)', since the transcripts have no `cwd`.
    const tokens = { total: 100, cached: 0, requests: 1 };
    const place = { project: '/w/p', kind: 'folder' as const, worktree: 'main', tokens, byModel: [], bySession: [] };
    const upgraded = encodeDay({ day: key(3), sessions: tokens, byModel: [], bySession: [], devdesk: { total: 0, cached: 0, requests: 0, failed: 0 }, byPlace: [place] });
    await writeFile(req.historyPath, `${legacyLine(5, 50, 1)}\n${upgraded}\n${legacyLine(2, 1010, 2)}\n${legacyLine(1, 12, 2)}\n`);
    const done = await countUsage(new UsageReader(), req);
    expect(totals(done.days)).toEqual({ [key(5)]: 50, ...expected() });
    const byDay = new Map(done.days.map((d) => [d.day, d]));
    expect(byDay.get(key(3))!.byPlace).toEqual([place]);
    expect(byDay.get(key(5))!.byPlace).toBe('unknown');
    expect(done.days.every((d) => d.byPlace !== undefined)).toBe(true);
  });
});

const zero = { total: 0, cached: 0, requests: 0 };
const dayOf = (day: string, total: number): DayUsage =>
  decodeHistory(encodeDay({ day, sessions: { ...zero, total }, byModel: [], bySession: [], devdesk: { ...zero, failed: 0 } }).concat('\n')).get(day)!;

describe('usage history shared by several windows', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-usageshare-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges the file read again: the days this count stored win, every other one is the file\'s', () => {
    const stored = new Map([
      ['2026-01-01', dayOf('2026-01-01', 1)],
      ['2026-01-02', dayOf('2026-01-02', 2)],
    ]);
    const onDisk = new Map([
      ['2026-01-02', dayOf('2026-01-02', 20)],
      ['2025-12-31', dayOf('2025-12-31', 31)],
      ['2026-01-01', dayOf('2026-01-01', 10)],
    ]);
    const merged = mergeHistory(stored, onDisk, new Set(['2026-01-02']));
    expect(Object.fromEntries([...merged].map(([k, d]) => [k, d.sessions.total]))).toEqual({ '2025-12-31': 31, '2026-01-01': 10, '2026-01-02': 2 });
  });

  it("keeps a day's places when a window on an older build wrote it again without them", () => {
    const place = { project: '/r', kind: 'folder' as const, worktree: 'main', tokens: { total: 5, cached: 0, requests: 0 }, byModel: [], bySession: [] };
    const counted: DayUsage = { ...dayOf('2026-01-01', 5), byPlace: [place] };
    const stored = new Map([['2026-01-01', counted]]);
    expect(mergeHistory(stored, new Map([['2026-01-01', dayOf('2026-01-01', 5)]]), new Set()).get('2026-01-01')?.byPlace).toEqual([place]);
    // Other totals: the other window counted the day again, so its line wins as it is.
    expect(mergeHistory(stored, new Map([['2026-01-01', dayOf('2026-01-01', 6)]]), new Set()).get('2026-01-01')).not.toHaveProperty('byPlace');
  });

  it('keeps a day another window stored while this count ran', async () => {
    const project = join(dir, 'projects', '-w-x');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 's1.jsonl'), `${line('a', 3, 100)}\n${line('b', 2, 10)}\n`);
    await utimes(join(project, 's1.jsonl'), noon(2), noon(2));
    const historyPath = join(dir, 'state', 'usage-history.jsonl');
    const other = dayOf(key(30), 999);
    class OtherWindow extends UsageReader {
      override async read(path: string): Promise<UsageScan> {
        await mkdir(join(dir, 'state'), { recursive: true });
        await appendFile(historyPath, `${encodeDay(other)}\n`);
        return super.read(path);
      }
    }
    const req: CountRequest = { projectsDir: join(dir, 'projects'), historyPath, ledgerPath: join(dir, 'state', 'usage.jsonl'), keepDays: 365, maxBytes: 1e7, names: [], now: Date.now(), saveEveryMs: 0 };
    await countUsage(new OtherWindow(), req);
    const stored = decodeHistory(await readFile(historyPath, 'utf8'));
    expect([...stored.keys()]).toEqual([key(30), key(3), key(2)]);
    expect(stored.get(key(30))!.sessions.total).toBe(999);
  });

  it('trims the ledger without losing lines appended at the same time', async () => {
    const path = join(dir, 'usage.jsonl');
    const at = (ms: number, n: number) => `${JSON.stringify({ at: ms, n })}\n`;
    const since = Date.now() - 1000;
    await writeFile(path, Array.from({ length: 2000 }, (_, i) => at(since - 10_000, i)).join('') + at(since + 1, -1));
    const appended = Array.from({ length: 20 }, (_, i) => at(since + 10, i));
    const results = await Promise.all([trimLedgerFile(path, since), ...appended.map((l) => appendLedgerLine(path, l))]);
    expect(results[0]).toBeUndefined();
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    expect(lines.length).toBe(21);
    for (const l of appended) expect(lines).toContain(l.trim());
  });
});

describe('readEta', () => {
  it('waits a few seconds of reading, then extrapolates the speed so far', () => {
    expect(readEta(100, 1000, 1000)).toBeUndefined();
    expect(readEta(0, 1000, 10_000)).toBeUndefined();
    expect(readEta(250, 1000, 5000)).toBe(15_000);
    expect(readEta(1000, 1000, 5000)).toBe(0);
  });
});
