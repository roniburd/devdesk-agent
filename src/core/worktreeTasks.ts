import { basename } from 'node:path';
import { parseObject } from './json';
import type { SessionCard } from './sessions';

/** How a worktree started from the Claude view was made (setting `devdesk.worktrees.kind`). */
/** A package workspace's own worktree (`<root>/worktrees/<name>`), or a Claude Code one. */
export type WorktreeKind = 'workspace' | 'claude';

/** What a worktree started from the Claude view is for, recorded when it is created. */
export interface WorktreeTask {
  /** The task as typed. */
  task: string;
  /** The worktree's name (the slug of the task). */
  worktree: string;
  kind: WorktreeKind;
  dir: string;
  createdAt: number;
}

/** Task records by worktree directory. */
export type WorktreeTasks = Record<string, WorktreeTask>;

const MAX_SLUG = 40;

/**
 * A worktree name for `task`: lowercase ASCII letters and digits separated by single dashes, at most 40 characters
 * (cut at a dash when possible), `task` if nothing is left, numbered `-2`, `-3`, … when `taken` already has it.
 */
export function worktreeSlug(task: string, taken: Iterable<string>): string {
  let slug = task
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_SLUG) {
    const cut = slug.slice(0, MAX_SLUG);
    const dash = cut.lastIndexOf('-');
    slug = (slug[MAX_SLUG] === '-' || dash <= 0 ? cut : cut.slice(0, dash)).replace(/-+$/, '');
  }
  slug ||= 'task';
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  let n = 2;
  while (used.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

/** Claude's first prompt in a new worktree when `devdesk.worktrees.startPrompt` is empty. */
export const DEFAULT_START_PROMPT =
  'You are working in worktree {worktree} ({dir}) on: {task}\nStart by saying which worktree you are in, then work on the task.';

/** Fills `{task}`, `{worktree}` and `{dir}` in `template` (DEFAULT_START_PROMPT when empty), in one pass. */
export function renderStartPrompt(template: string, values: { task: string; worktree: string; dir: string }): string {
  return (template.trim() || DEFAULT_START_PROMPT).replace(/\{(task|worktree|dir)\}/g, (_, key: keyof typeof values) => values[key]);
}

/** The last three lines of a failed command's output that are not stack frames (`at …`, `... N more`), for a notification. */
export function failureSummary(output: string): string {
  return output
    .split('\n')
    .filter((line) => line.trim() && !/^\s+at\s/.test(line) && !/^\s*\.\.\. \d+ more/.test(line))
    .slice(-3)
    .join('\n')
    .trim();
}

function isTask(v: unknown): v is WorktreeTask {
  const t = v as WorktreeTask;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.task === 'string' &&
    typeof t.worktree === 'string' &&
    typeof t.kind === 'string' &&
    typeof t.dir === 'string' &&
    typeof t.createdAt === 'number'
  );
}

/** The task records in a `worktree-tasks.json`; malformed files or entries are ignored. */
export function parseWorktreeTasks(text: string): WorktreeTasks {
  const data = parseObject(text);
  if (!data || Array.isArray(data)) return {};
  const tasks: WorktreeTasks = {};
  for (const v of Object.values(data)) {
    if (isTask(v)) tasks[v.dir] = { task: v.task, worktree: v.worktree, kind: v.kind === 'claude' ? 'claude' : 'workspace', dir: v.dir, createdAt: v.createdAt };
  }
  return tasks;
}

export function serializeWorktreeTasks(tasks: WorktreeTasks): string {
  return `${JSON.stringify(tasks, null, 2)}\n`;
}

/** A record whose worktree does not exist is kept this long (a Claude Code worktree appears only once Claude starts). */
export const KEEP_MISSING_MS = 60 * 60_000;

/**
 * The task records to keep when `task` is added at `now`: records whose worktree is missing are dropped once they are
 * older than `KEEP_MISSING_MS` (`exists` tells whether a directory exists).
 */
export function withWorktreeTask(tasks: WorktreeTasks, task: WorktreeTask, now: number, exists: (dir: string) => boolean): WorktreeTasks {
  const kept: WorktreeTasks = {};
  for (const t of Object.values(tasks)) if (exists(t.dir) || now - t.createdAt < KEEP_MISSING_MS) kept[t.dir] = t;
  kept[task.dir] = task;
  return kept;
}

/** A top-level row of the Claude view: a worktree and the sessions in it. */
export interface WorktreeGroup {
  /** `worktree:<dir>`, or `worktree:` for sessions outside any worktree. */
  key: string;
  name: string;
  /** Undefined for the `no worktree` group. */
  dir?: string;
  isMain: boolean;
  /** The task the worktree was started for, if DevDesk started it. */
  task?: string;
  /** In the order given. */
  cards: SessionCard[];
}

/**
 * Groups `cards` (kept in their order) by worktree, ordering the groups (main and `no worktree` included) by their
 * first card, so attention-ordered cards give worktrees in the order of their most urgent session. Worktrees with a
 * task record but no session come last, newest task first. Main shows only when it has sessions; task records of
 * worktrees not in `features` (deleted) are ignored.
 */
export function groupCards(
  cards: readonly SessionCard[],
  features: readonly { name: string; dir: string; isMain: boolean }[],
  tasks: WorktreeTasks,
): WorktreeGroup[] {
  const byDir = new Map(features.map((f) => [f.dir, f]));
  const groups = new Map<string, WorktreeGroup & { createdAt: number }>();
  const group = (dir: string | undefined, name?: string): WorktreeGroup & { createdAt: number } => {
    const key = `worktree:${dir ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      const feature = dir === undefined ? undefined : byDir.get(dir);
      const task = dir === undefined ? undefined : tasks[dir];
      g = {
        key,
        name: dir === undefined ? 'no worktree' : feature?.name ?? name ?? basename(dir),
        dir,
        isMain: !!feature?.isMain,
        task: task?.task,
        cards: [],
        createdAt: task?.createdAt ?? 0,
      };
      groups.set(key, g);
    }
    return g;
  };
  for (const card of cards) {
    group(card.featureDir, card.featureName).cards.push(card);
  }
  for (const t of Object.values(tasks)) {
    const feature = byDir.get(t.dir);
    if (feature && !feature.isMain) group(t.dir);
  }
  // Groups with cards were created in the order of their first card; the sort is stable.
  return [...groups.values()]
    .sort((a, b) => (a.cards.length ? 0 : 1) - (b.cards.length ? 0 : 1) || (a.cards.length ? 0 : b.createdAt - a.createdAt))
    .map(({ createdAt: _, ...g }) => g);
}
