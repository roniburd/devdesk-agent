// The Claude Board's history: what one Claude transcript contributes to the search (prompts, replies, files touched,
// titles), the index file that keeps it between runs, and which transcripts belong to the workspace.
import { isFiniteNumber, LineScan, parseObject } from './json';
import { promptText } from './insights';
import { isWithin, trimSlashes } from './paths';
import { truncate } from './sessionsView';

export const ENTRY_TEXT_MAX = 64 * 1024;
export const HEAD_TEXT_MAX = 16 * 1024;
const TURN_TEXT_MAX = 16 * 1024;
const FILES_MAX = 50;
const TOOLS_MAX = 30;
/** Lines longer than this many bytes (a huge tool result) are skipped without parsing (`HistoryScan`'s `maxLine`). */
export const LINE_MAX = 2 * 1024 * 1024;
const TITLE_MAX = 80;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface HistoryTurn {
  role: 'user' | 'claude';
  text: string;
}

/** One transcript (one session) as the search reads it. */
export interface HistoryEntry {
  sessionId?: string;
  /** The last working directory recorded (the Bash tool's `cd`s move it). */
  cwd?: string;
  /** The folder the session was launched in: the cwd recorded that its `projects/` folder is named after, else the first. */
  startCwd?: string;
  firstAt?: number;
  lastAt?: number;
  customTitle?: string;
  aiTitle?: string;
  /** Claude's latest recap (`away_summary`). */
  recap?: string;
  /** The prompts and text replies kept: the first `head` turns, then the latest ones. */
  turns: HistoryTurn[];
  head: number;
  headChars: number;
  chars: number;
  /** Files Claude edited or wrote, the latest last. */
  files: string[];
  /** Tools Claude used, by name, the latest last. */
  tools: string[];
}

export const emptyEntry = (): HistoryEntry => ({ turns: [], head: 0, headChars: 0, chars: 0, files: [], tools: [] });

/** Moves `item` to the end of `list` (once), keeping at most `max`, the latest. */
function keepLatest(list: string[], item: string, max: number): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * `raw` trimmed and cut to `max`, as a string of its own. V8 makes a slice of a long string a view into it, so a 16 KB
 * piece of a 500 KB prompt would keep all 500 KB alive for as long as the index does (thousands of review agents'
 * prompts filled a 4 GB heap that way).
 */
function ownText(raw: string, max = TURN_TEXT_MAX): string {
  const text = raw.trim().slice(0, max);
  return text.length < 13 ? text : Buffer.from(text, 'utf8').toString('utf8');
}

function pushTurn(e: HistoryEntry, role: HistoryTurn['role'], raw: string): void {
  const text = ownText(raw);
  if (!text) return;
  e.turns.push({ role, text });
  e.chars += text.length;
  if (e.head === e.turns.length - 1 && e.headChars + text.length <= HEAD_TEXT_MAX) {
    e.head++;
    e.headChars += text.length;
  }
  // Over the cap: drop the oldest turns after the head, never the newest one.
  while (e.chars > ENTRY_TEXT_MAX && e.turns.length > e.head + 1) {
    const [gone] = e.turns.splice(e.head, 1);
    e.chars -= gone.text.length;
  }
}

type Rec = { type?: unknown; subtype?: unknown; isMeta?: unknown; isSidechain?: unknown; sessionId?: unknown; cwd?: unknown; timestamp?: unknown; customTitle?: unknown; aiTitle?: unknown; content?: unknown; message?: { content?: unknown } };

/** What one transcript line adds to the entry; `projectDir`: the name of the `projects/` folder it is in. */
export function applyLine(e: HistoryEntry, line: string, projectDir?: string): void {
  const o = parseObject(line) as Rec | undefined;
  if (!o || o.isSidechain === true) return;
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(t)) {
    e.firstAt = e.firstAt === undefined ? t : Math.min(e.firstAt, t);
    e.lastAt = e.lastAt === undefined ? t : Math.max(e.lastAt, t);
  }
  if (typeof o.sessionId === 'string' && o.sessionId && !e.sessionId) e.sessionId = o.sessionId;
  if (typeof o.cwd === 'string' && o.cwd) {
    e.cwd = o.cwd;
    if (!e.startCwd || (projectDir && encodeProjectDir(e.startCwd) !== projectDir && encodeProjectDir(o.cwd) === projectDir)) e.startCwd = o.cwd;
  }
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') e.customTitle = ownText(o.customTitle, TITLE_MAX * 4) || undefined;
  else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') e.aiTitle = ownText(o.aiTitle, TITLE_MAX * 4) || undefined;
  else if (o.type === 'system' && o.subtype === 'away_summary' && typeof o.content === 'string' && o.content.trim()) e.recap = ownText(o.content);
  else if (o.type === 'user' && o.isMeta !== true) pushTurn(e, 'user', promptText(o.message?.content));
  else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    const texts: string[] = [];
    for (const b of o.message.content as unknown[]) {
      if (!b || typeof b !== 'object') continue;
      const block = b as { type?: unknown; text?: unknown; name?: unknown; input?: Record<string, unknown> };
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
        keepLatest(e.tools, block.name, TOOLS_MAX);
        const path = block.input?.file_path ?? block.input?.notebook_path;
        if (FILE_TOOLS.has(block.name) && typeof path === 'string' && path) keepLatest(e.files, path, FILES_MAX);
      }
    }
    if (texts.length) pushTurn(e, 'claude', texts.join('\n'));
  }
}

/** A transcript fed incrementally: from the start, or from a saved entry and offset. `projectDir`: as for `applyLine`. */
export class HistoryScan extends LineScan {
  protected override maxLine = LINE_MAX;

  constructor(
    readonly entry: HistoryEntry = emptyEntry(),
    offset = 0,
    private readonly projectDir?: string,
  ) {
    super();
    this.offset = offset;
  }

  /** Goes on from where `saved` was read to, on a copy of its entry (the saved one stays as it was, for docs built from it). */
  static resume(saved: IndexedTranscript, projectDir?: string): HistoryScan {
    const e = saved.entry;
    return new HistoryScan({ ...e, turns: [...e.turns], files: [...e.files], tools: [...e.tools] }, saved.offset, projectDir);
  }

  protected line(line: string): void {
    applyLine(this.entry, line, this.projectDir);
  }
}

/** Where a past session resumes: its launch folder (an index saved before `startCwd` has only `cwd`). */
export const launchCwd = (e: HistoryEntry): string | undefined => e.startCwd ?? e.cwd;

/** What the lane calls the session: a /rename, Claude's title, else its first prompt. */
export function entryTitle(e: HistoryEntry): string {
  const first = e.turns.find((t) => t.role === 'user')?.text.replace(/\s+/g, ' ').trim();
  const title = e.customTitle || e.aiTitle || first;
  return title ? truncate(title, TITLE_MAX) : '(untitled session)';
}

/** Claude's name for a folder under `projects/`: every character but letters and digits becomes `-`. */
export const encodeProjectDir = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-');

/** `root` without a trailing slash, and its resolved path when it is a symlink: Claude records the resolved one. */
const rootsOf = (root: string, realRoot?: string): string[] => [...new Set([root, realRoot].filter((r): r is string => !!r).map(trimSlashes))];

/** The `projects/` folders to read: the workspace's (its root and the folders below it), or all of them. */
export function projectDirsInScope(names: readonly string[], root: string | undefined, scope: 'workspace' | 'all', realRoot?: string): string[] {
  if (scope === 'all') return [...names];
  if (!root) return [];
  const encs = rootsOf(root, realRoot).map(encodeProjectDir);
  return names.filter((n) => encs.some((enc) => n === enc || n.startsWith(`${enc}-`)));
}

/** Folder names only share a prefix: an entry belongs to the workspace when its launch folder or last cwd is the root or below. */
export function entryInScope(e: HistoryEntry, root: string | undefined, scope: 'workspace' | 'all', realRoot?: string): boolean {
  if (scope === 'all') return true;
  if (!root) return false;
  const bases = rootsOf(root, realRoot);
  return [e.startCwd, e.cwd].some((cwd) => !!cwd && bases.some((base) => isWithin(cwd, base)));
}

export interface IndexedTranscript {
  size: number;
  mtimeMs: number;
  /** Bytes read, up to the end of the last complete line. */
  offset: number;
  /** The 64 bytes before `offset` (hex), to notice a transcript rewritten in place (every line starts alike, so the file's first bytes would not tell). */
  mark: string;
  entry: HistoryEntry;
  /** Read, but not the workspace's (its cwd is outside the root): kept without its text, read again in full when it changes. */
  outOfScope?: true;
}

/** What is kept of a transcript read but outside the workspace: its size and time only, no text. */
export const stubOf = (t: IndexedTranscript): IndexedTranscript => ({ size: t.size, mtimeMs: t.mtimeMs, offset: 0, mark: '', entry: emptyEntry(), outOfScope: true });

const HISTORY_FILE_VERSION = 1;

export interface HistoryFile {
  version: 1;
  /** By transcript path. */
  transcripts: Record<string, IndexedTranscript>;
}

export const emptyHistoryFile = (): HistoryFile => ({ version: HISTORY_FILE_VERSION, transcripts: {} });

const isTurn = (t: unknown): t is HistoryTurn =>
  !!t && typeof t === 'object' && ((t as HistoryTurn).role === 'user' || (t as HistoryTurn).role === 'claude') && typeof (t as HistoryTurn).text === 'string';
const isString = (v: unknown): v is string => typeof v === 'string';

/** A saved entry with only what has the right type (the file may be hand-edited); its counts follow the turns kept. */
function savedEntry(v: unknown): HistoryEntry | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.turns) || !Array.isArray(o.files) || !Array.isArray(o.tools) || !isFiniteNumber(o.head)) return undefined;
  const turns = o.turns.filter(isTurn).map((t) => ({ role: t.role, text: t.text }));
  const head = Math.max(0, Math.min(Math.floor(o.head), turns.length));
  const e: HistoryEntry = {
    turns,
    head,
    headChars: turns.slice(0, head).reduce((n, t) => n + t.text.length, 0),
    chars: turns.reduce((n, t) => n + t.text.length, 0),
    files: o.files.filter(isString),
    tools: o.tools.filter(isString),
  };
  for (const k of ['sessionId', 'cwd', 'startCwd', 'customTitle', 'aiTitle', 'recap'] as const) if (isString(o[k])) e[k] = o[k];
  for (const k of ['firstAt', 'lastAt'] as const) if (isFiniteNumber(o[k])) e[k] = o[k];
  return e;
}

function indexed(v: unknown): IndexedTranscript | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!isFiniteNumber(o.size) || !isFiniteNumber(o.mtimeMs) || !isFiniteNumber(o.offset) || typeof o.mark !== 'string') return undefined;
  const entry = savedEntry(o.entry);
  return entry && { size: o.size, mtimeMs: o.mtimeMs, offset: o.offset, mark: o.mark, entry, ...(o.outOfScope === true ? { outOfScope: true as const } : {}) };
}

/** The saved index; empty when missing, damaged or of another version (it is rebuilt then). */
export function parseHistoryFile(text: string): HistoryFile {
  const o = parseObject(text);
  if (!o || o.version !== HISTORY_FILE_VERSION || !o.transcripts || typeof o.transcripts !== 'object') return emptyHistoryFile();
  const transcripts: Record<string, IndexedTranscript> = {};
  for (const [path, v] of Object.entries(o.transcripts as Record<string, unknown>)) {
    const t = indexed(v);
    if (t) transcripts[path] = t;
  }
  return { version: HISTORY_FILE_VERSION, transcripts };
}
