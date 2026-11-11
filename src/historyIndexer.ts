import { mkdir, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomic } from './core/atomicWrite';
import { FileLockBusy, withFileLock } from './core/fileLock';
import {
  emptyHistoryFile,
  encodeProjectDir,
  entryInScope,
  type HistoryEntry,
  type HistoryFile,
  HistoryScan,
  type IndexedTranscript,
  parseHistoryFile,
  projectDirsInScope,
  stubOf,
} from './core/historyIndex';
import { mapLimit } from './core/limit';
import { trimSlashes } from './core/paths';

const CHUNK = 1024 * 1024;
const MARK_BYTES = 64;
const CONCURRENCY = 2;
const STAT_CONCURRENCY = 32;
const DAY = 86_400_000;
/** A lock not refreshed for this long is another window's that went away: it is taken over. */
const LOCK_STALE_MS = 120_000;
/**
 * An index file no window has written for this long is removed (one is kept per workspace folder ever opened and per
 * `historyDays`, each up to about 100 MB). A window still using one only reads its transcripts again.
 */
export const UNUSED_INDEX_MS = 30 * DAY;
/** Left-over temporary files and locks (their writer crashed) older than this are removed. */
const LEFTOVER_MS = DAY;
/** How often a window looks for unused index files. */
const CLEANUP_INTERVAL_MS = DAY;
/** A run that read this much saves the index at once, whatever `saveIntervalMs` says: another window would read it all again. */
const SAVE_NOW_BYTES = 32 * 1024 * 1024;

export interface HistoryIndexerOptions {
  enabled: () => boolean;
  scope: () => 'workspace' | 'all';
  days: () => number;
  /** At most this many transcripts, the most recently changed, are indexed. */
  maxSessions?: () => number;
  root: () => string | undefined;
  /** Where Claude keeps its transcripts: one directory, or one per Claude account. */
  projectsDir: () => string | readonly string[];
  stateDir: () => string;
  now?: () => number;
  minIntervalMs?: number;
  /**
   * How long what a run read may stay only in memory before the index file is written (default 0: every run that read
   * something). It is written sooner when transcripts were dropped, when a run read a lot, and on `release` and `dispose`.
   */
  saveIntervalMs?: () => number;
  warn?: (message: string) => void;
  /** Where each run says what it read, how long it took and what it did to the heap (for debugging a slow or big index). */
  info?: (message: string) => void;
  /** Registers the run as an operation in flight (named in heap and event-loop warnings); returns the function that ends it. */
  track?: (label: string) => () => void;
}

export interface IndexStatus {
  indexed: number;
  total: number;
  building: boolean;
}

/** The settings a run reads, taken once at its start. */
interface RunSettings {
  enabled: boolean;
  scope: 'workspace' | 'all';
  days: number;
  maxSessions: number;
  root: string | undefined;
  projectsDirs: readonly string[];
  stateDir: string;
}

interface Listed {
  path: string;
  size: number;
  mtimeMs: number;
}

const isCurrent = (t: { size: number; mtimeMs: number }, saved: IndexedTranscript | undefined): boolean => !!saved && saved.size === t.size && saved.mtimeMs === t.mtimeMs;

const MBs = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The index file. The all-folders one is shared by every window, whose `historyDays` may differ (it is window-scoped):
 * one file per days value, so a window that keeps fewer days does not drop another's older transcripts.
 */
export function historyFilePath(stateDir: string, root: string | undefined, scope: 'workspace' | 'all', days: number): string {
  return join(stateDir, 'history', scope === 'all' || !root ? `all-${days}d.json` : `${encodeProjectDir(trimSlashes(root))}.json`);
}

/**
 * The files in the history directory (`files`, with their modification times) to remove at `now`: index files other
 * than `inUse` not written for `UNUSED_INDEX_MS`, and temporary files and locks left for a day.
 */
export function unusedHistoryFiles(files: readonly { name: string; mtimeMs: number }[], inUse: string, now: number): string[] {
  return files
    .filter(({ name, mtimeMs }) => {
      const age = now - mtimeMs;
      if (name.endsWith('.json')) return name !== inUse && age >= UNUSED_INDEX_MS;
      if (name.endsWith('.tmp') || name.endsWith('.lock')) return name !== `${inUse}.lock` && age >= LEFTOVER_MS;
      return false;
    })
    .map((f) => f.name);
}

/**
 * Keeps the board's history index current: reads this workspace's Claude transcripts (only what was appended since
 * last time, in chunks, two at a time) into `<state dir>/history/<root>.json`. One window indexes at a time (a lock
 * next to the file); the others read what it wrote. What a run reads is used at once, but saved at most every
 * `saveIntervalMs`: another window sees it (or reads it again itself) only once it is saved.
 */
export class HistoryIndexer {
  private file: HistoryFile = emptyHistoryFile();
  private loadedMtime = -1;
  private loadedPath = '';
  private running: Promise<void> | undefined;
  private lastStart = -Infinity;
  private lastCleanup = -Infinity;
  /** When this window last wrote the index file (the run's clock). */
  private lastSave = -Infinity;
  /** The index in memory has transcripts read since it was saved to `loadedPath`. */
  private unsaved = false;
  private current: IndexStatus = { indexed: 0, total: 0, building: false };
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  /** Bumped by `release()`: a run started before it saves what it read but does not keep it. */
  private generation = 0;
  /** The root with symlinks resolved, when that differs (Claude records that path); set by each run. */
  realRoot: string | undefined;
  /** Bumped each time the index (what `entries()` returns) is replaced: what was built from it is stale then. */
  revision = 0;

  constructor(private readonly o: HistoryIndexerOptions) {}

  entries(): HistoryEntry[] {
    return this.transcripts().map((t) => t.entry);
  }

  /** The workspace's transcripts read, by path, with what they contribute. */
  transcripts(): { path: string; entry: HistoryEntry }[] {
    return Object.entries(this.file.transcripts)
      .filter(([, t]) => !t.outOfScope)
      .map(([path, t]) => ({ path, entry: t.entry }));
  }

  status(): IndexStatus {
    return { ...this.current };
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.saveUnsaved();
    this.disposed = true;
    this.listeners.clear();
  }

  /** Lets go of the index (the board closed: it can be about 100 MB); the next refresh loads it again. */
  release(): void {
    this.saveUnsaved();
    this.generation++;
    this.setFile(emptyHistoryFile());
    this.loadedPath = '';
    this.loadedMtime = -1;
    this.lastStart = -Infinity;
  }

  refresh(force = false): Promise<void> {
    if (this.running) return this.running;
    const now = (this.o.now ?? Date.now)();
    if (!force && now - this.lastStart < (this.o.minIntervalMs ?? 60_000)) return Promise.resolve();
    this.lastStart = now;
    this.running = this.runUntilCurrent(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private settings(): RunSettings {
    const o = this.o;
    return { enabled: o.enabled(), scope: o.scope(), days: o.days(), maxSessions: o.maxSessions?.() ?? Infinity, root: o.root(), projectsDirs: [o.projectsDir()].flat(), stateDir: o.stateDir() };
  }

  /** Runs, and again while the settings changed during the run (a scope, root or days change would wait a minute otherwise). */
  private async runUntilCurrent(now: number): Promise<void> {
    let s = this.settings();
    await this.run(now, s);
    const same = (a: RunSettings, b: RunSettings) => JSON.stringify(a) === JSON.stringify(b);
    while (!this.disposed && !same(this.settings(), s)) {
      s = this.settings();
      await this.run((this.o.now ?? Date.now)(), s);
    }
  }

  private setFile(file: HistoryFile): void {
    this.file = file;
    this.revision++;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private async run(now: number, s: RunSettings): Promise<void> {
    if (!s.enabled || (s.scope === 'workspace' && !s.root)) {
      this.saveUnsaved();
      this.current = { indexed: 0, total: 0, building: false };
      if (!this.loadedPath && !Object.keys(this.file.transcripts).length) return;
      this.setFile(emptyHistoryFile());
      this.loadedPath = '';
      this.loadedMtime = -1;
      return this.emit();
    }
    const path = historyFilePath(s.stateDir, s.root, s.scope, s.days);
    const generation = this.generation;
    const real = s.root ? await realpath(s.root).catch(() => undefined) : undefined;
    this.realRoot = real && real !== s.root ? real : undefined;
    // Another index now (the scope, root or days changed): the one in memory is saved before it is replaced.
    if (this.loadedPath !== path) this.saveUnsaved();
    await this.load(path);
    // The index holds prompts and replies: only the user reads it.
    await mkdir(dirname(dirname(path)), { recursive: true });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      // Another window holding a fresh lock is indexing: this one only reads what it saves.
      await withFileLock(path, () => this.indexLocked(now, s, path, generation), { waitMs: 0, staleMs: LOCK_STALE_MS });
    } catch (err) {
      if (err instanceof FileLockBusy) return;
      throw err;
    }
    await this.cleanup(now, path);
  }

  /** `run`'s indexing, while holding the index file's lock. */
  private async indexLocked(now: number, s: RunSettings, path: string, generation: number): Promise<void> {
    const started = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let untrack = () => {};
    let read = 0;
    let readBytes = 0;
    try {
      const { listed, older, overCap } = await this.list(now, s);
      const fresh = listed.filter((t) => !isCurrent(t, this.file.transcripts[t.path]));
      const where = s.scope === 'all' ? 'every folder' : s.root;
      // Once a minute: said only when there is something to read.
      if (fresh.length) this.o.info?.(
        `history: ${listed.length} transcripts for ${where} (${MBs(listed.reduce((n, t) => n + t.size, 0))}), ${fresh.length} new or changed (${MBs(fresh.reduce((n, t) => n + t.size, 0))}) to read` +
          `${overCap ? `; ${overCap} older ones left out (devdesk.boardSearch.historyMaxSessions ${s.maxSessions})` : ''}${older ? `; ${older} not changed for ${s.days} days skipped` : ''}`,
      );
      untrack = this.o.track?.(`history index (${fresh.length} to read)`) ?? untrack;
      this.current = { indexed: 0, total: listed.length, building: true };
      this.emit();
      const next: Record<string, IndexedTranscript> = {};
      const before = this.file.transcripts;
      let changed = this.loadedMtime < 0;
      // One read buffer per worker.
      const buffers: Buffer[] = [];
      await mapLimit(listed, CONCURRENCY, async (t) => {
        if (this.disposed) return;
        const buffer = buffers.pop() ?? Buffer.alloc(CHUNK);
        try {
          let got = await this.index(t.path, t.size, t.mtimeMs, before[t.path], buffer);
          if (got !== before[t.path]) {
            read++;
            const was = before[t.path];
            readBytes += t.size - (was && t.size >= was.offset ? was.offset : 0);
          }
          // A sibling folder's (a shared prefix) or one with no cwd yet: its size and time only, no text.
          if (got !== before[t.path] && !entryInScope(got.entry, s.root, s.scope, this.realRoot)) got = stubOf(got);
          next[t.path] = got;
          if (got !== before[t.path]) changed = true;
        } catch (err) {
          // Gone since it was listed: drop it. Unreadable for a moment (EACCES, EMFILE): keep what was read before.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && before[t.path]) next[t.path] = before[t.path];
          else changed = true;
          this.o.warn?.(`history: cannot read ${t.path}: ${(err as Error).message}`);
        } finally {
          buffers.push(buffer);
        }
        this.current.indexed++;
        if (this.current.indexed % 10 === 0) this.emit();
      });
      if (this.disposed) return;
      const kept = Object.values(next).filter((t) => !t.outOfScope).length;
      this.current = { indexed: kept, total: kept, building: true };
      const keys = Object.keys(next);
      const removed = Object.keys(before).some((k) => !(k in next));
      if (removed || keys.some((k) => !(k in before))) changed = true;
      if (!changed && !this.unsaved) return;
      const file: HistoryFile = changed ? { ...emptyHistoryFile(), transcripts: next } : this.file;
      // Saved now: no index file yet, transcripts dropped (another window would keep listing them), much read, released
      // meanwhile (not kept in memory), or the last save was long enough ago. Else this window uses it unsaved.
      const due =
        this.loadedMtime < 0 || removed || readBytes >= SAVE_NOW_BYTES || generation !== this.generation || now - this.lastSave >= (this.o.saveIntervalMs?.() ?? 0);
      if (!due) {
        // Nothing new since the unsaved one: the same index, so its revision stays (the board keeps its docs).
        if (changed) this.setFile(file);
        this.unsaved = true;
        return;
      }
      const text = JSON.stringify(file);
      await writeFileAtomic(path, text, false, 0o600);
      this.lastSave = now;
      this.o.info?.(`history: saved ${kept} sessions to ${path} (${MBs(Buffer.byteLength(text))}; ${this.summary(started, heapBefore, read, readBytes)})`);
      // Released meanwhile (the board closed): the next refresh loads the file again.
      if (generation !== this.generation) return;
      if (changed) this.setFile(file);
      this.unsaved = false;
      this.loadedMtime = (await stat(path)).mtimeMs;
    } catch (err) {
      this.o.warn?.(`history: indexing failed (${this.summary(started, heapBefore, read, readBytes)}): ${(err as Error).message}`);
      throw err;
    } finally {
      untrack();
      const flipped = this.current.building;
      this.current.building = false;
      if (flipped) this.emit();
    }
  }

  private summary(started: number, heapBefore: number, read: number, readBytes: number): string {
    return `read ${read} transcripts, ${MBs(readBytes)}, in ${((Date.now() - started) / 1000).toFixed(1)}s; heap ${MBs(heapBefore)} → ${MBs(process.memoryUsage().heapUsed)}`;
  }

  /**
   * Writes an index that has unsaved transcripts to its file, in the background, unless another window is indexing it
   * (that one saves its own). Called before the index in memory is let go or replaced.
   */
  private saveUnsaved(): void {
    if (!this.unsaved || !this.loadedPath) return;
    const path = this.loadedPath;
    const file = this.file;
    this.unsaved = false;
    void withFileLock(path, () => writeFileAtomic(path, JSON.stringify(file), false, 0o600), { waitMs: 0, staleMs: LOCK_STALE_MS })
      .then(() => this.o.info?.(`history: saved ${path} before letting go of it`))
      .catch((err) => {
        if (!(err instanceof FileLockBusy)) this.o.warn?.(`history: cannot save ${path}: ${(err as Error).message}`);
      });
  }

  private async load(path: string): Promise<void> {
    const info = await stat(path).catch(() => undefined);
    if (!info) {
      if (this.loadedPath !== path) {
        this.setFile(emptyHistoryFile());
        this.unsaved = false;
      }
      this.loadedPath = path;
      return;
    }
    if (this.loadedPath === path && info.mtimeMs === this.loadedMtime) return;
    // Another window saved the index (or this is another index): what was read here unsaved is in it or read again.
    this.unsaved = false;
    const started = Date.now();
    this.setFile(parseHistoryFile(await readFile(path, 'utf8').catch(() => '')));
    this.o.info?.(`history: loaded ${Object.keys(this.file.transcripts).length} transcripts from ${path} (${MBs(info.size)}) in ${Date.now() - started}ms`);
    this.loadedPath = path;
    this.loadedMtime = info.mtimeMs;
    this.emit();
  }

  /**
   * Removes, once a day, index files no window has written for `UNUSED_INDEX_MS` (never `inUse`, this window's), and
   * left-over temporary files and locks. An index another window is writing (its lock is held) is left alone.
   */
  private async cleanup(now: number, inUse: string): Promise<void> {
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    const dir = dirname(inUse);
    try {
      const names = await readdir(dir);
      const infos = await Promise.all(names.map((name) => stat(join(dir, name)).then((i) => ({ name, mtimeMs: i.mtimeMs }), () => undefined)));
      for (const name of unusedHistoryFiles(infos.filter((i) => !!i), basename(inUse), now)) {
        const path = join(dir, name);
        if (!name.endsWith('.json')) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        await withFileLock(
          path,
          async () => {
            // Written meanwhile by a window that just took the lock and let it go.
            const info = await stat(path).catch(() => undefined);
            if (!info || now - info.mtimeMs < UNUSED_INDEX_MS) return;
            await unlink(path);
            this.o.info?.(`history: removed ${path}, not used for ${Math.round(UNUSED_INDEX_MS / DAY)} days`);
          },
          { waitMs: 0, staleMs: LOCK_STALE_MS },
        ).catch((err) => {
          if (!(err instanceof FileLockBusy)) this.o.warn?.(`history: cannot remove ${path}: ${(err as Error).message}`);
        });
      }
    } catch (err) {
      this.o.warn?.(`history: cannot clean up ${dir}: ${(err as Error).message}`);
    }
  }

  /** The transcripts to index (changed within `days`, the newest `maxSessions`), and how many were left out. */
  private async list(now: number, s: RunSettings): Promise<{ listed: Listed[]; older: number; overCap: number }> {
    const since = now - s.days * DAY;
    // Every Claude account's projects, in the order of `projectsDirs`.
    const dirs = (
      await Promise.all(
        s.projectsDirs.map(async (projects) => {
          const names = (await readdir(projects, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name);
          return projectDirsInScope(names, s.root, s.scope, this.realRoot).map((name) => join(projects, name));
        }),
      )
    ).flat();
    const listings = await mapLimit(dirs, STAT_CONCURRENCY, (dir) => readdir(dir, { withFileTypes: true }).catch(() => []));
    const paths = dirs.flatMap((dir, k) => listings[k].filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map((f) => join(dir, f.name)));
    const infos = await mapLimit(paths, STAT_CONCURRENCY, (path) => stat(path).catch(() => undefined));
    const recent = paths.flatMap((path, k) => {
      const info = infos[k];
      return info && info.mtimeMs >= since ? [{ path, size: info.size, mtimeMs: info.mtimeMs }] : [];
    });
    const older = infos.filter((i) => i && i.mtimeMs < since).length;
    if (recent.length <= s.maxSessions) return { listed: recent, older, overCap: 0 };
    const listed = recent.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, s.maxSessions);
    return { listed, older, overCap: recent.length - listed.length };
  }

  private async index(path: string, size: number, mtimeMs: number, saved: IndexedTranscript | undefined, buffer: Buffer): Promise<IndexedTranscript> {
    if (isCurrent({ size, mtimeMs }, saved)) return saved!;
    const file = await open(path, 'r');
    // The bytes just before `end`, to tell a grown transcript from one rewritten in place.
    const markAt = async (end: number) => {
      const n = Math.min(MARK_BYTES, end);
      const b = Buffer.alloc(n);
      await file.read(b, 0, n, end - n);
      return b.toString('hex');
    };
    try {
      const grown = !!saved && size >= saved.offset && (await markAt(saved.offset)) === saved.mark;
      const dir = basename(dirname(path));
      const scan = grown ? HistoryScan.resume(saved!, dir) : new HistoryScan(undefined, 0, dir);
      while (scan.offset < size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - scan.offset), scan.offset);
        if (!bytesRead) break;
        scan.feed(buffer.subarray(0, bytesRead));
        await new Promise((r) => setImmediate(r));
      }
      return { size, mtimeMs, offset: scan.settled, mark: await markAt(scan.settled), entry: scan.entry };
    } finally {
      await file.close();
    }
  }
}
