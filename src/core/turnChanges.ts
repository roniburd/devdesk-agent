import { isInjectedPrompt } from './sessions';
import { oneLine } from './text';

/**
 * What Claude changed in each turn of a session, read from its transcript (not from git): the Edit, MultiEdit, Write
 * and NotebookEdit tool calls whose results say they succeeded, and the edits of the subagents the turn started.
 *
 * A turn starts at each prompt: a line the user typed (or a slash command, or a background task's notification Claude
 * answers), never a tool result, a `!` command, a local command's output or a subagent's own prompt.
 *
 * Each file's text before and after the turn, best source first:
 * 1. `transcript`: the tool results Claude Code writes carry the whole file as it was before each edit
 *    (`toolUseResult.originalFile`), and a Write that created the file starts from nothing. From the first such state
 *    the turn's edits are applied in order.
 * 2. `disk`: when the transcript has no whole file before the turn, the file as it is now is taken as the state after
 *    the transcript's last edit to it, and the edits are undone backwards (each `new_string` back to its `old_string`).
 *    This assumes nothing else changed the file since; an edit whose new text is missing or appears more than once
 *    (without `replace_all`) cannot be undone, and then:
 * 3. `snippets`: only the edited parts: the hunks the tool result has (`structuredPatch`, the changed lines with a few
 *    lines of context), else each old string against its new one.
 * A Write over a file whose earlier text is unknown shows an empty "before".
 */

export interface TextEdit {
  old: string;
  new: string;
  all: boolean;
}

interface OpBase {
  path: string;
  /** When the result was written (ms), to order a subagent's edits among the turn's. */
  at?: number;
  /** The whole file before this edit, when the tool result has it. */
  original?: string;
  /** Made by a subagent. */
  agent?: boolean;
  /** The edit's hunks, with a few lines of context, as the tool result has them (`structuredPatch`). */
  hunks?: Hunk[];
}

/** One hunk of a unified diff: its first line in the old and new file, and its lines (prefixed ` `, `-` or `+`). */
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}
export type FileOp =
  | (OpBase & { kind: 'edit'; edits: TextEdit[] })
  | (OpBase & { kind: 'write'; content: string; created?: boolean })
  | (OpBase & { kind: 'notebook'; source: string; mode: string; cell?: string });

export interface Turn {
  /** The prompt as typed, on one line; empty for edits read before any prompt (the turn started before the part read). */
  prompt: string;
  at?: number;
  ops: FileOp[];
  /** The subagents the turn started (their ids name their transcripts). */
  agents: string[];
  /** Not all of it was read: it started before the part of the transcript read, or a line too long to read was skipped. */
  partial: boolean;
}

/** Edit tools whose calls change files, by the name Claude Code gives them. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
/** User lines that are not prompts to Claude: `!` commands and their output, local command output, interruptions. */
const NOT_PROMPT = /^\s*(<bash-input>|<bash-stdout>|<bash-stderr>|<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|\[Request interrupted)/;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A cheap test that a transcript line may matter (a user line or a tool call), before parsing it. */
export function mayMatter(line: string): boolean {
  return line.includes('"user"') || line.includes('"tool_use"');
}

/** The prompt a transcript line holds, on one line; undefined when it holds none (see `Turn`). */
export function promptOf(o: Record<string, unknown>): string | undefined {
  if (o.type !== 'user' || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true) return undefined;
  const content = (o.message as { content?: unknown } | undefined)?.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c) => c?.type === 'tool_result')) return undefined;
    const texts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);
    if (!texts.length) return content.some((c) => c?.type === 'image') ? '[image]' : undefined;
    text = texts.join(' ');
  } else return undefined;
  if (NOT_PROMPT.test(text)) return undefined;
  if (isInjectedPrompt(text)) return '(a background task finished)';
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '';
    return oneLine(`${command[1]} ${args}`);
  }
  return oneLine(text);
}

/** The edit tool call's change of a file, from its input and its result (`toolUseResult`, which wins where it has a value). */
function opOf(name: string, input: Record<string, unknown>, result: Record<string, unknown>, at: number | undefined, agent: boolean): FileOp | undefined {
  const original = str(result.originalFile) ?? str(result.originalFileContents);
  const hunks = hunksOf(result.structuredPatch);
  const base = { at, agent: agent || undefined, ...(original !== undefined ? { original } : {}), ...(hunks ? { hunks } : {}) };
  if (name === 'NotebookEdit') {
    const path = str(result.notebook_path) ?? str(input.notebook_path);
    const source = str(input.new_source) ?? str(result.new_source) ?? '';
    if (!path) return undefined;
    return { kind: 'notebook', path, source, mode: str(input.edit_mode) ?? 'replace', cell: str(input.cell_id), at, agent: agent || undefined };
  }
  const path = str(result.filePath) ?? str(input.file_path);
  if (!path) return undefined;
  if (name === 'Write') {
    const content = str(result.content) ?? str(input.content);
    if (content === undefined) return undefined;
    const created = result.type === 'create' ? true : result.type === 'update' ? false : undefined;
    return { kind: 'write', path, content, ...(created !== undefined ? { created } : {}), ...base };
  }
  const list = name === 'MultiEdit' ? (Array.isArray(result.edits) ? result.edits : input.edits) : [undefined];
  if (!Array.isArray(list)) return undefined;
  const edits: TextEdit[] = [];
  for (const e of list as unknown[]) {
    // An Edit's result names its strings itself (as applied, after a change in the permission prompt); a MultiEdit's lists them.
    const src = (e && typeof e === 'object' ? e : name === 'Edit' ? { ...input, ...renamed(result) } : {}) as Record<string, unknown>;
    const old = str(src.old_string);
    const neu = str(src.new_string);
    if (old === undefined || neu === undefined) return undefined;
    edits.push({ old, new: neu, all: src.replace_all === true });
  }
  return { kind: 'edit', path, edits, ...base };
}

/** A tool result's `structuredPatch`, when it is a list of well-formed hunks. */
function hunksOf(v: unknown): Hunk[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const hunks: Hunk[] = [];
  for (const h of v as Record<string, unknown>[]) {
    if (!h || typeof h.oldStart !== 'number' || typeof h.newStart !== 'number' || !Array.isArray(h.lines)) return undefined;
    if (!h.lines.every((l) => typeof l === 'string')) return undefined;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines as string[] });
  }
  return hunks;
}

/** An Edit result's `oldString`/`newString`/`replaceAll` under the input's names. */
function renamed(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof r.oldString === 'string') out.old_string = r.oldString;
  if (typeof r.newString === 'string') out.new_string = r.newString;
  if (typeof r.replaceAll === 'boolean') out.replace_all = r.replaceAll;
  return out;
}

interface Pending {
  name: string;
  input: Record<string, unknown>;
  turn: Turn;
  agent: boolean;
}

/**
 * Splits a transcript's lines (fed in order, parsed) into turns. With `subagent`, the transcript is a subagent's: it is
 * one turn, its prompts are the tasks it was given, and every edit counts as a subagent's.
 */
export class TurnParser {
  readonly turns: Turn[] = [];
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly subagent = false) {}

  /** A line that could not be read (too long): the turn it falls in may miss an edit. */
  skipped(): void {
    this.current().partial = true;
  }

  object(o: Record<string, unknown>): void {
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : undefined;
    const time = Number.isFinite(at) ? at : undefined;
    if (!this.subagent) {
      const prompt = promptOf(o);
      if (prompt !== undefined) {
        this.turns.push({ prompt, at: time, ops: [], agents: [], partial: false });
        return;
      }
    }
    const content = (o.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    if (o.type === 'assistant') {
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.id !== 'string' || typeof c.name !== 'string') continue;
        if (!EDIT_TOOLS.has(c.name) && !AGENT_TOOLS.has(c.name)) continue;
        const input = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>;
        this.pending.set(c.id, { name: c.name, input, turn: this.current(), agent: this.subagent || o.isSidechain === true });
      }
      return;
    }
    if (o.type !== 'user') return;
    const results = content.filter((c) => c?.type === 'tool_result' && typeof c.tool_use_id === 'string');
    for (const c of results) {
      const p = this.pending.get(c.tool_use_id as string);
      if (!p) continue;
      this.pending.delete(c.tool_use_id as string);
      const raw = results.length === 1 ? o.toolUseResult : undefined;
      // A failed call changed nothing: an error result, or a result that is only the error's text.
      if (c.is_error === true || (typeof raw === 'string' && /^\s*(Error|<tool_use_error>)/.test(raw))) continue;
      const result = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (AGENT_TOOLS.has(p.name)) {
        const id = str(result.agentId);
        if (id && !p.turn.agents.includes(id)) p.turn.agents.push(id);
        continue;
      }
      const op = opOf(p.name, p.input, result, time, p.agent);
      if (op) p.turn.ops.push(op);
    }
  }

  /** The turn being read; a partial one when edits come before any prompt (the read started mid-turn). */
  private current(): Turn {
    let turn = this.turns[this.turns.length - 1];
    if (!turn) {
      turn = { prompt: '', ops: [], agents: [], partial: !this.subagent };
      this.turns.push(turn);
    }
    return turn;
  }
}

/** Adds a subagent's edits to the turn that started it, among the turn's own by time (those without a time stay in order). */
export function addAgentOps(turn: Turn, ops: readonly FileOp[], partial = false): void {
  if (partial) turn.partial = true;
  if (!ops.length) return;
  const all = [...turn.ops, ...ops];
  const indexed = all.map((op, i) => ({ op, i }));
  indexed.sort((a, b) => (a.op.at !== undefined && b.op.at !== undefined && a.op.at !== b.op.at ? a.op.at - b.op.at : a.i - b.i));
  turn.ops = indexed.map((x) => x.op);
}

/** The files a turn changed, in the order it first changed them. */
export function turnPaths(turn: Turn): string[] {
  return [...new Set(turn.ops.map((o) => o.path))];
}

/** `text` with each edit applied in order; undefined when an old string is not in it. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string | undefined {
  let s = text;
  for (const e of edits) {
    if (e.old === '') {
      // An Edit with an empty old string writes a new (or empty) file.
      if (s !== '') return undefined;
      s = e.new;
      continue;
    }
    const at = s.indexOf(e.old);
    if (at < 0) return undefined;
    s = e.all ? s.split(e.old).join(e.new) : s.slice(0, at) + e.new + s.slice(at + e.old.length);
  }
  return s;
}

/**
 * `text` with each edit undone, last first; undefined when one cannot be undone for sure: its new string is not in the
 * text, or (without `replace_all`) is in it more than once, or is empty.
 */
export function undoEdits(text: string, edits: readonly TextEdit[]): string | undefined {
  let s = text;
  for (const e of [...edits].reverse()) {
    if (e.old === '') {
      if (s !== e.new) return undefined;
      s = '';
      continue;
    }
    if (e.new === '') return undefined;
    const at = s.indexOf(e.new);
    if (at < 0) return undefined;
    if (e.all) s = s.split(e.new).join(e.old);
    else {
      if (s.indexOf(e.new, at + 1) >= 0) return undefined;
      s = s.slice(0, at) + e.old + s.slice(at + e.new.length);
    }
  }
  return s;
}

/** The file after the op, from the file before it (or the op's own record of it); undefined when unknown. */
function forward(op: FileOp, before: string | undefined): string | undefined {
  const start = op.original ?? before ?? (op.kind === 'write' && op.created ? '' : undefined);
  if (op.kind === 'write') return op.content;
  if (start === undefined || op.kind === 'notebook') return undefined;
  return applyEdits(start, op.edits);
}

/** The file before the op, from the file after it; undefined when unknown. */
function backward(op: FileOp, after: string | undefined): string | undefined {
  if (op.original !== undefined) return op.original;
  if (op.kind === 'write') return op.created ? '' : undefined;
  if (after === undefined || op.kind === 'notebook') return undefined;
  return undoEdits(after, op.edits);
}

export type ChangeSource = 'transcript' | 'disk' | 'snippets';

export interface TurnFile {
  path: string;
  before: string;
  after: string;
  source: ChangeSource;
  /** What the diff cannot show, when it is approximate. */
  note?: string;
  /** A subagent made (some of) the changes. */
  byAgent: boolean;
}

/** Separates the edited parts when only they are shown. */
export const SNIPPET_SEPARATOR = '\n⋯\n';

/**
 * Each file `turns[index]` changed, with its text before and after the turn (see the top of this file for how). `disk`
 * gives a file's content now (undefined when unreadable), for files the transcript has no whole copy of.
 */
export function turnFiles(turns: readonly Turn[], index: number, disk: (path: string) => string | undefined): TurnFile[] {
  const turn = turns[index];
  if (!turn) return [];
  return turnPaths(turn).map((path) => {
    const ops = turn.ops.filter((o) => o.path === path);
    const byAgent = ops.some((o) => o.agent);
    const earlier = turns.slice(0, index).flatMap((t) => t.ops.filter((o) => o.path === path));
    const later = turns.slice(index + 1).flatMap((t) => t.ops.filter((o) => o.path === path));

    // 1. Forward from what the transcript knows of the file before the turn.
    let known: string | undefined;
    for (const op of earlier) known = forward(op, known);
    const before = ops[0].original ?? known ?? (ops[0].kind === 'write' && ops[0].created ? '' : undefined);
    let state = before;
    for (const op of ops) state = forward(op, state);
    if (before !== undefined && state !== undefined) return { path, before, after: state, source: 'transcript', byAgent };

    // 2. Backward from the file on disk, through the later turns' edits to it, then this turn's.
    let after: string | undefined = disk(path);
    for (const op of [...later].reverse()) after = backward(op, after);
    let back = after;
    for (const op of [...ops].reverse()) back = backward(op, back);
    if (after !== undefined && back !== undefined) {
      return { path, before: back, after, source: 'disk', note: 'rebuilt from the file as it is now, assuming nothing else changed it since', byAgent };
    }

    // 3. The edited parts only.
    return snippets(path, ops, byAgent);
  });
}

function snippets(path: string, ops: readonly FileOp[], byAgent: boolean): TurnFile {
  const befores: string[] = [];
  const afters: string[] = [];
  let note = 'only the edited parts: the whole file before the turn is not in the transcript';
  for (const op of ops) {
    if (op.hunks && !(op.kind === 'write' && op.original === undefined)) {
      // The hunks show the edited lines with their context, under a header naming where they are.
      for (const h of op.hunks) {
        const header = `⋯ line ${h.newStart}`;
        befores.push([header, ...h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1))].join('\n'));
        afters.push([header, ...h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1))].join('\n'));
      }
    } else if (op.kind === 'edit') {
      for (const e of op.edits) {
        befores.push(e.old);
        afters.push(e.new);
      }
    } else if (op.kind === 'write') {
      befores.push(op.original ?? '');
      afters.push(op.content);
      if (op.original === undefined) note = 'the file was written whole, and its text before the turn is not in the transcript';
    } else {
      befores.push('');
      afters.push(op.source);
      note = `notebook cell ${op.cell ?? '(new)'} (${op.mode}): only the new cell source is shown`;
    }
  }
  return { path, before: befores.join(SNIPPET_SEPARATOR), after: afters.join(SNIPPET_SEPARATOR), source: 'snippets', note, byAgent };
}
