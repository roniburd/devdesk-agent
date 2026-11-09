import type { Dirent } from 'node:fs';
import { type FileHandle, open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { GrowingFiles, isFiniteNumber, LineScan, parseObject, positiveNumber } from './json';
import { mapLimit } from './limit';

/**
 * Token usage for the board's stats: what Claude sessions used (from their transcripts, subagents included) and what
 * DevDesk's own Haiku calls used (from `<state dir>/usage.jsonl`). Tokens only, as total (input, cache writes, cache
 * reads and output) and cached (cache reads), so the difference shows.
 */
export interface Tokens {
  total: number;
  cached: number;
  requests: number;
}

export interface UsageEntry {
  at: number;
  model: string;
  total: number;
  cached: number;
  /** The folder the session ran in when it made the request (from its transcript line, else the line before). */
  cwd?: string;
}

/** An assistant line's usage, by request (one response is split into a line per content block, each repeating it). */
export function parseUsageLine(line: string): [string, UsageEntry] | undefined {
  if (!line.includes('"usage"')) return undefined;
  const o = parseObject(line);
  if (o?.type !== 'assistant') return undefined;
  const message = (o.message ?? {}) as Record<string, unknown>;
  const u = message.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return undefined;
  const id = typeof o.requestId === 'string' && o.requestId ? o.requestId : typeof message.id === 'string' && message.id ? message.id : undefined;
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!id || !Number.isFinite(at)) return undefined;
  const cached = positiveNumber(u.cache_read_input_tokens);
  const total = positiveNumber(u.input_tokens) + positiveNumber(u.cache_creation_input_tokens) + cached + positiveNumber(u.output_tokens);
  if (!total) return undefined;
  const model = typeof message.model === 'string' && message.model && message.model !== '<synthetic>' ? message.model : 'unknown';
  const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : undefined;
  return [id, cwd ? { at, model, total, cached, cwd } : { at, model, total, cached }];
}

const CWD_VALUE = /"cwd":("(?:[^"\\]|\\.)*")/y;

/**
 * A transcript line's top-level `cwd`, read without parsing the line: the `"cwd"` key at the outer object's depth,
 * skipping strings (where a quoted `"cwd"` is escaped) and nested objects (a `user` line's content can hold its own).
 */
export function cwdOf(line: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (depth === 1 && line.startsWith('"cwd":', i)) {
        CWD_VALUE.lastIndex = i;
        const m = CWD_VALUE.exec(line);
        if (!m) return undefined;
        try {
          const v: unknown = JSON.parse(m[1]);
          return typeof v === 'string' && v ? v : undefined;
        } catch {
          return undefined;
        }
      }
      // Skip the string, escapes included.
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === '\\') i++;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return undefined;
}

/** One transcript's usage, read incrementally (transcripts only grow). */
export class UsageScan extends LineScan {
  readonly entries = new Map<string, UsageEntry>();
  /** The session's title: its `/rename` (`custom-title`), else Claude Code's own (`ai-title`), the last one written. */
  customTitle: string | undefined;
  aiTitle: string | undefined;

  get title(): string | undefined {
    return this.customTitle ?? this.aiTitle;
  }

  private readTitle(line: string): void {
    const o = parseObject(line);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    if (o?.type === 'custom-title') this.customTitle = str(o.customTitle) ?? this.customTitle;
    else if (o?.type === 'ai-title') this.aiTitle = str(o.aiTitle) ?? this.aiTitle;
  }

  /** The `cwd` the transcript recorded last, for a request whose line has none. */
  private cwd: string | undefined;

  protected line(line: string): void {
    if (line.includes('-title"')) this.readTitle(line);
    const hit = parseUsageLine(line);
    if (hit) {
      const e = hit[1];
      if (e.cwd && e.cwd !== this.cwd) this.cwd = e.cwd;
      // One string for all the transcript's requests in a folder.
      if (this.cwd) e.cwd = this.cwd;
      this.entries.set(hit[0], e);
    } else if (line.includes('"cwd":')) {
      this.cwd = cwdOf(line) ?? this.cwd;
    }
  }
}

/** One call DevDesk made, from a line of its ledger (`usage.jsonl`, written by `ledgerLine` in insights.ts). */
export function parseLedgerLine(line: string): { at: number; model: string; total: number; cached: number; ok: boolean } | undefined {
  const o = parseObject(line);
  if (!o || !isFiniteNumber(o.at)) return undefined;
  const cached = positiveNumber(o.cacheRead);
  const model = typeof o.model === 'string' && o.model ? o.model : 'unknown';
  return { at: o.at, model, total: positiveNumber(o.input) + positiveNumber(o.cacheWrite) + cached + positiveNumber(o.output), cached, ok: o.ok === true };
}

/** `950`, `12.3k`, `4.56M`, `1.22B`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`;
  return `${(count / 1_000_000_000).toFixed(count < 10_000_000_000 ? 2 : 1)}B`;
}

/** A transcript to count: the session it belongs to, its size, when it was last written, and when it started. */
export interface TranscriptFile {
  path: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
  /**
   * About when its first line was written: the first `timestamp` near its start, else when the file was created (or
   * last written, whichever is earlier). Lines in a transcript are in time order, so it has nothing much older.
   */
  startMs: number;
}

/** How far into a transcript to look for its first timestamp (a subagent's first line holds its whole prompt). */
const HEAD_BYTES = 256 * 1024;
/** How many folders `changedTranscripts` lists at a time. */
const LIST_CONCURRENCY = 8;
const HEAD_CHUNK = 16 * 1024;
const TIMESTAMP = /"timestamp":"([^"]+)"/;

/** The first `"timestamp"` in a file's first {@link HEAD_BYTES}, in ms; undefined when there is none. */
export async function firstTimestamp(path: string): Promise<number | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'r');
    let text = '';
    for (let offset = 0; offset < HEAD_BYTES; offset += HEAD_CHUNK) {
      const buffer = Buffer.alloc(HEAD_CHUNK);
      const { bytesRead } = await file.read(buffer, 0, HEAD_CHUNK, offset);
      if (!bytesRead) break;
      // Keep the end of the last chunk, in case the timestamp was cut there.
      text = text.slice(-64) + buffer.subarray(0, bytesRead).toString('utf8');
      const m = TIMESTAMP.exec(text);
      if (m) {
        const at = Date.parse(m[1]);
        return Number.isFinite(at) ? at : undefined;
      }
      if (bytesRead < HEAD_CHUNK) break;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/**
 * Transcripts under `<Claude config dir>/projects` changed since a time: `<project>/<session>.jsonl` and
 * `<project>/<session>/subagents/*.jsonl`, each with the session it belongs to. `onFound` is told how many transcripts
 * the folders hold as they are found, then `onListed` how many of them were checked for changes.
 */
export async function changedTranscripts(
  projectsDir: string,
  since: number,
  onListed?: (count: number) => void,
  onFound?: (count: number) => void,
  startOf: (path: string) => Promise<number | undefined> = firstTimestamp,
): Promise<TranscriptFile[]> {
  const list = async (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  const projects = (await list(projectsDir)).filter((p) => p.isDirectory()).map((p) => join(projectsDir, p.name));
  let foundCount = 0;
  // Listed a few folders at a time; the transcripts kept in the folders' order.
  const perProject = await mapLimit(projects, LIST_CONCURRENCY, async (pdir) => {
    const entries = await list(pdir);
    const subagents = await mapLimit(entries, LIST_CONCURRENCY, (e) => (e.isDirectory() ? list(join(pdir, e.name, 'subagents')) : Promise.resolve([])));
    const files: { path: string; sessionId: string }[] = [];
    entries.forEach((e, k) => {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ path: join(pdir, e.name), sessionId: basename(e.name, '.jsonl') });
      const sub = join(pdir, e.name, 'subagents');
      for (const a of subagents[k]) if (a.isFile() && a.name.endsWith('.jsonl')) files.push({ path: join(sub, a.name), sessionId: e.name });
    });
    foundCount += files.length;
    onFound?.(foundCount);
    return files;
  });
  const found = perProject.flat();
  let listed = 0;
  const files = await mapLimit(found, 16, async (f): Promise<TranscriptFile | undefined> => {
    const s = await stat(f.path).catch(() => undefined);
    if (!s || s.mtimeMs < since) {
      onListed?.(++listed);
      return undefined;
    }
    const created = s.birthtimeMs > 0 ? Math.min(s.birthtimeMs, s.mtimeMs) : s.mtimeMs;
    const first = await startOf(f.path);
    onListed?.(++listed);
    return { ...f, size: s.size, mtimeMs: s.mtimeMs, startMs: first ?? created };
  });
  return files.filter((f): f is TranscriptFile => !!f);
}

/** Transcripts' usage, kept across reads so each file reads only what was appended. */
export class UsageReader {
  private readonly files = new GrowingFiles(() => new UsageScan());
  /** Each transcript's first timestamp, which never changes once there is one. */
  private readonly starts = new Map<string, number>();

  async read(path: string): Promise<UsageScan> {
    return (await this.files.read(path)) ?? new UsageScan();
  }

  /** How much of a file was read already (0 when it was not, or was forgotten). */
  offset(path: string): number {
    return this.files.peek(path)?.offset ?? 0;
  }

  /** A transcript's first timestamp ({@link firstTimestamp}), read once. */
  async firstTimestamp(path: string): Promise<number | undefined> {
    const known = this.starts.get(path);
    if (known !== undefined) return known;
    const at = await firstTimestamp(path);
    if (at !== undefined) this.starts.set(path, at);
    return at;
  }

  /** Forgets a file: one that will not be read again. */
  forget(path: string): void {
    this.files.forget(path);
    this.starts.delete(path);
  }

  /** Forgets every file not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    this.files.retain(keep);
    for (const path of this.starts.keys()) if (!keep.has(path)) this.starts.delete(path);
  }

  /**
   * The transcripts changed since `since`, read up to now, by session id. Forgets the transcripts it no longer lists, so
   * reading from a later time keeps only what that needs.
   */
  async scans(projectsDir: string, since: number): Promise<Map<string, UsageScan[]>> {
    const files = await changedTranscripts(projectsDir, since);
    const byId = new Map<string, UsageScan[]>();
    for (const f of files) {
      const scan = await this.read(f.path);
      const list = byId.get(f.sessionId);
      if (list) list.push(scan);
      else byId.set(f.sessionId, [scan]);
    }
    this.files.retain(new Set(files.map((f) => f.path)));
    return byId;
  }
}
