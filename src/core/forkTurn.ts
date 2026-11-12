import { isAbsolute, relative } from 'node:path';
import { parseObject } from './json';
import { shellQuote } from './shell';
import { truncate } from './text';
import { forward, type Turn, turnPaths } from './turnChanges';

/**
 * Fork from a turn: a new Claude session whose conversation ends after a chosen turn of another, optionally with the
 * files Claude changed after that turn put back as they were then.
 *
 * Claude Code 2.1.319 has no way to start an interactive session cut at a turn: `--resume-session-at <message uuid>`
 * cuts the resumed conversation after that message, but only with `-p` (it is ignored otherwise), and `-p` needs a
 * prompt. So DevDesk writes the cut conversation itself: a copy of the transcript up to the next turn's prompt, under a
 * new session id, which Claude then resumes (`--resume <new id>`). The original transcript is only read.
 *
 * `--rewind-files <prompt uuid>` (with `--resume`) restores files from Claude's checkpoints and exits, but it needs
 * `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`, overwrites a file changed since Claude wrote it, and refuses another
 * directory (a new worktree). So DevDesk rewinds from the transcript instead (`rewindPlan`): a file goes back only when
 * it is still what Claude last wrote, and the transcript has its text as it was after the chosen turn.
 */

/** Rewrites a transcript line for the copy: the original session id becomes the new one. */
function renamedLine(line: string, from: string, to: string): string {
  return line.split(`"sessionId":${JSON.stringify(from)}`).join(`"sessionId":${JSON.stringify(to)}`);
}

/** The model a transcript's assistant line ran on, when it names one (not Claude Code's own `<synthetic>` replies). */
function modelOf(o: Record<string, unknown>): string | undefined {
  if (o.type !== 'assistant') return undefined;
  const model = (o.message as { model?: unknown } | undefined)?.model;
  return typeof model === 'string' && model && !model.startsWith('<') ? model : undefined;
}

/**
 * Copies a transcript's lines, fed in order, up to the line whose `uuid` is `cut` (not included): the conversation as
 * it stood when that prompt was sent. Without `cut`, the whole transcript. Lines with no `uuid` after the last one
 * that has one (bookkeeping Claude Code writes before the next prompt: its checkpoint, a queue entry) are left out.
 * `emit` gets each copied line, the session id in it changed to `newId`.
 */
export class ForkCopier {
  /** The cut was reached (always false without one). */
  found = false;
  /** Turns copied: the prompts before the cut (counted as `promptOf` does), so the chosen turn's number. */
  turns = 0;
  /** The model of the last assistant reply copied. */
  model?: string;
  /** Lines written. */
  lines = 0;
  private held: string[] = [];

  constructor(
    private readonly oldId: string,
    private readonly newId: string,
    private readonly cut: string | undefined,
    private readonly emit: (line: string) => void,
    private readonly isPrompt: (o: Record<string, unknown>) => boolean,
  ) {}

  /** Feeds the next line; false once the cut is reached (nothing more is copied). */
  line(raw: string): boolean {
    if (this.found) return false;
    if (!raw.trim()) return true;
    const o = parseObject(raw);
    if (this.cut !== undefined && o?.uuid === this.cut) {
      this.found = true;
      this.held = [];
      return false;
    }
    const text = renamedLine(raw, this.oldId, this.newId);
    if (typeof o?.uuid !== 'string') {
      this.held.push(text);
      return true;
    }
    if (this.isPrompt(o)) this.turns++;
    this.model = modelOf(o) ?? this.model;
    for (const h of this.held) this.write(h);
    this.held = [];
    this.write(text);
    return true;
  }

  /** The copy is complete: without a cut, the lines held at the end are kept (the session as it is now). */
  end(): void {
    if (this.cut === undefined) for (const h of this.held) this.write(h);
    this.held = [];
  }

  private write(line: string): void {
    this.lines++;
    this.emit(line);
  }
}

/**
 * Where a fork from `turns[index]` cuts the conversation: before the next turn’s prompt (by its uuid); `last` when the
 * turn is the last one (the whole conversation); undefined when the next prompt has no uuid to cut at.
 */
export function forkCut(turns: readonly Turn[], index: number): { cut?: string; last: boolean } | undefined {
  const next = turns[index + 1];
  if (!next) return { last: true };
  return next.uuid ? { cut: next.uuid, last: false } : undefined;
}

/**
 * What rewinding does to one file Claude changed after the chosen turn:
 * - `restore`: put back `content`, its text after the chosen turn (it is still what Claude last wrote);
 * - `delete`: Claude created it after the chosen turn (and it is still what Claude wrote);
 * - `same`: it is already as it was then;
 * - `changed`: something other than Claude changed it since Claude last wrote it, so it is left alone;
 * - `unknown`: the transcript cannot tell its text then, or what Claude last wrote, so it is left alone.
 */
export type RewindAction = 'restore' | 'delete' | 'same' | 'changed' | 'unknown';

export interface RewindFile {
  path: string;
  action: RewindAction;
  /** For `restore`: the text to write. */
  content?: string;
  /** For `restore` and `delete`: what the file must still hold for the rewind to go ahead (checked again before writing). */
  expected?: string;
}

/**
 * The text of `path` after `turns[index]`: before the first later op on it, from that op's own copy of the file, else
 * from the earlier ops read. `null` when it did not exist then; undefined when unknown.
 */
function textAfterTurn(turns: readonly Turn[], index: number, path: string): string | null | undefined {
  const first = turns.slice(index + 1).flatMap((t) => t.ops.filter((o) => o.path === path))[0];
  if (!first) return undefined;
  if (first.original !== undefined) return first.original;
  let known: string | undefined;
  const earlier = turns.slice(0, index + 1).flatMap((t) => t.ops.filter((o) => o.path === path));
  for (const op of earlier) known = forward(op, known);
  if (known !== undefined) return known;
  if (earlier.length) return undefined;
  // First changed after the turn, by a Write that created it, or an Edit of an empty old string (which writes a new file).
  if (first.kind === 'write' && first.created) return null;
  if (first.kind === 'edit' && first.edits[0]?.old === '') return null;
  return undefined;
}

/**
 * For each file Claude changed after `turns[index]` (in the order it first changed them), what rewinding it to how it
 * was after that turn does. `disk` gives a file's text now (undefined when it does not exist or cannot be read).
 */
export function rewindPlan(turns: readonly Turn[], index: number, disk: (path: string) => string | undefined): RewindFile[] {
  const paths = [...new Set(turns.slice(index + 1).flatMap((t) => turnPaths(t)))];
  return paths.map((path) => {
    const then = textAfterTurn(turns, index, path);
    const later = turns.slice(index + 1).flatMap((t) => t.ops.filter((o) => o.path === path));
    let last: string | undefined = then === null ? '' : then;
    for (const op of later) last = forward(op, last);
    const now = disk(path);
    if (then === undefined || last === undefined) return { path, action: 'unknown' };
    if (then === null) {
      if (now === undefined) return { path, action: 'same' };
      return now === last ? { path, action: 'delete', expected: last } : { path, action: 'changed' };
    }
    if (now === then) return { path, action: 'same' };
    return now === last ? { path, action: 'restore', content: then, expected: last } : { path, action: 'changed' };
  });
}

/** The files to change of a plan (`restore` and `delete`). */
export const rewindWrites = (plan: readonly RewindFile[]) => plan.filter((f) => f.action === 'restore' || f.action === 'delete');

/**
 * What a new worktree for a fork from `turns[index]` gets of each file Claude changed in the turns read (it starts at
 * the original worktree's HEAD): the file as the original has it now, rewound as `plan` says. `null` means the file
 * must not exist. Paths outside `root` (the original worktree) are left out; the others are relative to it.
 */
export function worktreeFiles(
  turns: readonly Turn[],
  plan: readonly RewindFile[],
  root: string,
  disk: (path: string) => string | undefined,
): { rel: string; content: string | null; rewound: boolean }[] {
  const byPath = new Map(plan.map((f) => [f.path, f]));
  const paths = [...new Set(turns.flatMap((t) => turnPaths(t)))];
  const out: { rel: string; content: string | null; rewound: boolean }[] = [];
  for (const path of paths) {
    const rel = isAbsolute(path) ? relative(root, path) : '';
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const step = byPath.get(path);
    if (step?.action === 'restore') out.push({ rel, content: step.content!, rewound: true });
    else if (step?.action === 'delete') out.push({ rel, content: null, rewound: true });
    else out.push({ rel, content: disk(path) ?? null, rewound: false });
  }
  return out;
}

/** The fork's name in Claude Code (`--name`), which the Claude view and the board show as its title. */
export function forkName(title: string, turn: number): string {
  return `forked from “${truncate(title, 50)}” at turn ${turn}`;
}

/** True when Claude arguments (shell text) already pick a model. */
export const picksModel = (args: string | undefined) => /(^|\s)--model(\s|=|$)/.test(args ?? '');

/**
 * Claude's arguments for the fork: resume the copy, named, on the original's model unless `otherArgs` (the launch mode's
 * and `devdesk.sessions.claudeArgs`) pick one.
 */
export function forkResumeArgs(newId: string, name: string, model: string | undefined, otherArgs: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(newId)) throw new Error(`not a Claude session id: ${newId}`);
  const parts = [`--resume ${newId}`, `--name ${shellQuote(name)}`];
  if (model && !picksModel(otherArgs)) parts.push(`--model ${shellQuote(model)}`);
  return parts.join(' ');
}

/** A short list of file names for a message: the first few, then how many more. */
export function fileList(paths: readonly string[], label: (path: string) => string, max = 8): string {
  const shown = paths.slice(0, max).map(label);
  return shown.join(', ') + (paths.length > max ? `, and ${paths.length - max} more` : '');
}
