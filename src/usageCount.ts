import { appendFile, readFile } from 'node:fs/promises';
import { writeFileAtomic } from './core/atomicWrite';
import { FileLockBusy, withFileLock } from './core/fileLock';
import { changedTranscripts, type Tokens, type TranscriptFile, type UsageReader, type UsageScan } from './core/usage';
import { addDays, DayCounter, dayKey, dayStart, decodeHistory, type DayUsage, type HistoryInfo, pruneHistory, trimLedger, upgradeDay, usageByDay } from './core/usageHistory';

/*
 * Counting token usage: stores finished days in the history file and counts today live. No `vscode` here: it runs in
 * the usage worker (`usageWorker.ts`), off the extension host's thread, and inline in the unit tests.
 */

/** What a count needs, all resolved by the caller (settings, paths, the board's session names). */
export interface CountRequest {
  /** `<Claude config dir>/projects` */
  projectsDir: string;
  historyPath: string;
  ledgerPath: string;
  keepDays: number;
  maxBytes: number;
  /** Session names the board knows, by session id. */
  names: [string, string][];
  now: number;
  /** Writes the history at most this often while counting (and once at the end). */
  saveEveryMs?: number;
}

export interface CountProgress {
  /** Listing the transcripts, reading the ones not counted yet, then counting today. */
  phase: 'listing' | 'reading' | 'today';
  /** Transcripts found under the projects folder so far. */
  found: number;
  /** Of those, checked for changes since the last stored day (`totalFiles` is 0 until all are). */
  listed: number;
  files: number;
  totalFiles: number;
  /** Bytes read so far, the transcripts being read included. */
  bytes: number;
  totalBytes: number;
  /** Days stored in the history file so far. */
  savedDays: number;
  /** The newest day stored so far. */
  savedThrough?: string;
  /** Since the count started. */
  elapsedMs: number;
  /** About how long the reading has left, from its speed so far (undefined until it can tell). */
  etaMs?: number;
  /** The days stored so far, sent each time more are, so the page can show them before the count ends. */
  stored?: { days: DayUsage[]; history: HistoryInfo };
}

export interface UsageSnapshot {
  /** Stored days, then today counted live, oldest first. */
  days: DayUsage[];
  today: string;
  history: HistoryInfo;
  /** What went wrong without stopping the count (a history file that cannot be written), for the log. */
  warnings: string[];
}

/** DevDesk's ledger is trimmed to the last two days once it is this big (older days are in the history). */
const LEDGER_TRIM_BYTES = 2 * 1024 * 1024;
/** Transcripts read ahead of the one being counted. */
const READ_AHEAD = 4;
const SAVE_EVERY_MS = 2000;
const PROGRESS_EVERY_MS = 250;
/** Reading this long before guessing how long it has left. */
const ETA_AFTER_MS = 3000;

/** About how long reading `totalBytes` takes, having read `bytes` in `readMs`; undefined while too early to tell. */
export function readEta(bytes: number, totalBytes: number, readMs: number): number | undefined {
  if (readMs < ETA_AFTER_MS || bytes <= 0) return undefined;
  return Math.max(0, ((totalBytes - bytes) * readMs) / bytes);
}

/**
 * Counts the days not stored yet and today. Transcripts are read in the order they started, so once the next one
 * started after a day ended, no transcript left can add to that day: each day is stored as soon as that happens. A
 * count that is stopped part way (a window reload) loses only the days not stored yet; the next one goes on from there.
 * `reader` keeps the transcripts changed today, so the next count reads only what was appended.
 */
export async function countUsage(reader: UsageReader, req: CountRequest, onProgress: (p: CountProgress) => void = () => undefined): Promise<UsageSnapshot> {
  const warnings: string[] = [];
  const names = new Map(req.names);
  const today = dayKey(req.now);
  const todayStart = dayStart(today);
  const cutoff = addDays(today, -req.keepDays);
  const saveEvery = req.saveEveryMs ?? SAVE_EVERY_MS;

  const stored = decodeHistory(await readFile(req.historyPath, 'utf8').catch(() => ''));
  const last = [...stored.keys()].filter((k) => k < today).sort().pop();
  /** The first day not stored yet. */
  const fromKey = last && addDays(last, 1) > cutoff ? addDays(last, 1) : cutoff;
  /**
   * Days stored before places were counted: counted once more, from what is left of their transcripts and the ledger
   * (`upgradeDay`), so the read starts at the oldest of them. The first count after the upgrade reads what is left of
   * the transcripts, about a month of them.
   */
  const legacy = new Map([...stored.values()].filter((d) => d.day >= cutoff && d.day < fromKey && d.byPlace === undefined).map((d) => [d.day, d]));
  const oldestLegacy = [...legacy.keys()].sort()[0];
  const since = dayStart(oldestLegacy ?? fromKey);
  const ledger = await readFile(req.ledgerPath, 'utf8').catch(() => '');

  const startedAt = Date.now();
  let progressAt = 0;
  let readStartedAt = 0;
  /** Bytes of the transcripts read to the end; `liveBytes` adds the ones being read. */
  let doneBytes = 0;
  let liveBytes = () => doneBytes;
  const progress: CountProgress = { phase: 'listing', found: 0, listed: 0, files: 0, totalFiles: 0, bytes: 0, totalBytes: 0, savedDays: 0, elapsedMs: 0 };
  const report = (force = false, stored?: CountProgress['stored']) => {
    const t = Date.now();
    if (!force && !stored && t - progressAt < PROGRESS_EVERY_MS) return;
    progressAt = t;
    progress.elapsedMs = t - startedAt;
    if (progress.phase === 'reading') {
      progress.bytes = Math.min(progress.totalBytes, liveBytes());
      progress.etaMs = readEta(progress.bytes, progress.totalBytes, t - readStartedAt);
    } else progress.etaMs = undefined;
    onProgress(stored ? { ...progress, stored } : { ...progress });
  };
  report(true);
  // Also between transcripts: a big one takes a while, and the page shows the time going by.
  const ticker = setInterval(() => report(), PROGRESS_EVERY_MS * 2);
  try {
    return await count();
  } finally {
    clearInterval(ticker);
  }

  async function count(): Promise<UsageSnapshot> {
    const files = await changedTranscripts(
      req.projectsDir,
      since,
      (listed) => {
        progress.listed = listed;
        report();
      },
      (found) => {
        progress.found = found;
        report();
      },
      (path) => reader.firstTimestamp(path),
    );
    files.sort((a, b) => a.startMs - b.startMs);
    progress.totalFiles = files.length;
    // Before any read ahead moves the offsets.
    const sizes = files.map((f) => unread(reader, f));
    progress.totalBytes = sizes.reduce((n, b) => n + b, 0);
    progress.phase = 'reading';
    readStartedAt = Date.now();
    report(true);

    // Days before today; today is counted below from the transcripts kept in `reader`.
    const past = new DayCounter(since, todayStart);
    const dirty = past.addLedger(ledger);
    let savedAt = Date.now();
    /** The days this count has stored: those it read from transcripts, newer than what another window wrote. */
    const counted = new Set<string>();
    let pruned = pruneHistory([...stored.values()].filter((d) => d.day < today), today, req.keepDays, req.maxBytes);

    /**
     * Stores the changed days that ended before `before` (every one when it is Infinity). `when`: `'due'` at most every
     * `saveEvery`, `'now'` at once, `'final'` at once and writing the file even when no day changed.
     */
    const save = async (before: number, when: 'due' | 'now' | 'final') => {
      const force = when === 'final';
      if (when === 'due' && Date.now() - savedAt < saveEvery) return;
      let changed = false;
      for (const key of [...dirty]) {
        if (dayStart(addDays(key, 1)) > before) continue;
        dirty.delete(key);
        const day = past.day(key, names);
        const old = legacy.get(key);
        if (old) stored.set(key, upgradeDay(old, day));
        // Stored with places before this count: never counted again (its transcripts may be gone by now). A day before
        // `fromKey` that was never stored (a gap) is stored now.
        else if (key < fromKey && stored.has(key) && !counted.has(key)) continue;
        else if (day) stored.set(key, day);
        else continue;
        counted.add(key);
        changed = true;
      }
      // The old days that ended with no transcript or ledger line left for them: kept as they are, marked so they are
      // not tried again. Stored as the read passes them, so a count stopped part way does not read them again.
      for (const [key, old] of legacy) {
        if (counted.has(key) || dirty.has(key) || dayStart(addDays(key, 1)) > before) continue;
        stored.set(key, upgradeDay(old, undefined));
        counted.add(key);
        changed = true;
      }
      if (!changed && !force) return;
      savedAt = Date.now();
      try {
        // Another window's count may have stored days since this one read the file: keep them, write the merge.
        await withFileLock(req.historyPath, async () => {
          const onDisk = await readFile(req.historyPath, 'utf8').catch(() => '');
          for (const [key, day] of mergeHistory(stored, decodeHistory(onDisk), counted)) stored.set(key, day);
          pruned = pruneHistory([...stored.values()].filter((d) => d.day < today), today, req.keepDays, req.maxBytes);
          if (pruned.text !== onDisk) await writeFileAtomic(req.historyPath, pruned.text);
        });
      } catch (err) {
        pruned = pruneHistory([...stored.values()].filter((d) => d.day < today), today, req.keepDays, req.maxBytes);
        warnings.push(`cannot write the usage history ${req.historyPath}: ${(err as Error).message}`);
      }
      progress.savedDays = pruned.days.length;
      progress.savedThrough = pruned.days[pruned.days.length - 1]?.day;
      if (changed) report(true, { days: pruned.days, history: historyInfo() });
    };

    const historyInfo = (): HistoryInfo => ({ days: pruned.days.length, bytes: pruned.bytes, maxBytes: req.maxBytes, keepDays: req.keepDays, oldest: pruned.days[0]?.day });

    const reads = new Map<number, Promise<UsageScan>>();
    // Started reads advance the reader's offset for their file as they go.
    liveBytes = () => {
      let n = doneBytes;
      for (const j of reads.keys()) n += Math.max(0, Math.min(sizes[j], sizes[j] - unread(reader, files[j])));
      return n;
    };
    const startRead = (i: number) => {
      if (i >= files.length || reads.has(i)) return;
      const read = reader.read(files[i].path);
      read.catch(() => undefined); // awaited in turn; a count stopped before then must not leave it unhandled
      reads.set(i, read);
    };
    const keep = new Set<string>();
    // The old days that ended before the first transcript started (Claude Code deleted theirs) are done already.
    if (files.length) await save(files[0].startMs, 'now');
    for (let i = 0; i < files.length; i++) {
      for (let j = i; j < i + READ_AHEAD; j++) startRead(j);
      const f = files[i];
      const scan = await reads.get(i)!;
      reads.delete(i);
      for (const key of past.addScan(f.sessionId, scan)) dirty.add(key);
      // Only transcripts written today can change today, or the next count.
      if (f.mtimeMs >= todayStart) keep.add(f.path);
      else reader.forget(f.path);
      progress.files = i + 1;
      doneBytes += sizes[i];
      await save(files[i + 1]?.startMs ?? Infinity, 'due');
      report();
    }
    await save(Infinity, 'final');
    reader.retain(keep);
    progress.phase = 'today';
    report(true);

    const todayScans = new Map<string, UsageScan[]>();
    for (const f of files) {
      if (!keep.has(f.path)) continue;
      const list = todayScans.get(f.sessionId) ?? [];
      list.push(await reader.read(f.path));
      todayScans.set(f.sessionId, list);
    }
    const todayUsage = usageByDay(todayScans, ledger, todayStart, names).get(today);

    if (ledger.length > LEDGER_TRIM_BYTES) {
      const warning = await trimLedgerFile(req.ledgerPath, dayStart(addDays(today, -1)));
      if (warning) warnings.push(warning);
    }
    report(true);

    return {
      days: todayUsage ? [...pruned.days, todayUsage] : pruned.days,
      today,
      history: historyInfo(),
      warnings,
    };
  }
}

/** Bytes of a transcript not read yet. */
function unread(reader: UsageReader, f: TranscriptFile): number {
  const offset = reader.offset(f.path);
  return offset > f.size ? f.size : f.size - offset;
}

/**
 * The stored days after reading the history file again (`onDisk`): the days this count stored (`counted`) as it
 * counted them, every other one as the file has it, so a day another window stored meanwhile is kept. A window still
 * on a build from before places were counted rewrites the file without them: a day the file has with the same totals
 * but no places keeps the places this window has for it.
 */
export function mergeHistory(stored: ReadonlyMap<string, DayUsage>, onDisk: ReadonlyMap<string, DayUsage>, counted: ReadonlySet<string>): Map<string, DayUsage> {
  const merged = new Map(stored);
  for (const [key, day] of onDisk) {
    if (counted.has(key)) continue;
    const mine = stored.get(key);
    merged.set(key, day.byPlace === undefined && mine?.byPlace !== undefined && sameTotals(day, mine) ? { ...day, byPlace: mine.byPlace } : day);
  }
  return merged;
}

const sameTokens = (a: Tokens, b: Tokens) => a.total === b.total && a.cached === b.cached && a.requests === b.requests;
const sameTotals = (a: DayUsage, b: DayUsage) => sameTokens(a.sessions, b.sessions) && sameTokens(a.devdesk, b.devdesk);

/**
 * Days before `since` are in the history: drops them from the ledger. Under the ledger's lock, which the insight
 * calls appending to it take too (`appendLedgerLine`), so a line appended meanwhile is never lost.
 */
export async function trimLedgerFile(path: string, since: number): Promise<string | undefined> {
  try {
    await withFileLock(path, async () => {
      const text = await readFile(path, 'utf8');
      const trimmed = trimLedger(text, since);
      if (trimmed !== text) await writeFileAtomic(path, trimmed);
    });
    return undefined;
  } catch (err) {
    return `cannot trim the usage ledger ${path}: ${(err as Error).message}`;
  }
}

/** Appends `line` to DevDesk's usage ledger, under the lock its trim takes (`trimLedgerFile`). */
export async function appendLedgerLine(path: string, line: string): Promise<void> {
  try {
    await withFileLock(path, () => appendFile(path, line));
  } catch (err) {
    // A lock held too long (a hung window): appending anyway beats losing the line, the trim only risks it.
    if (err instanceof FileLockBusy) await appendFile(path, line);
    else throw err;
  }
}
