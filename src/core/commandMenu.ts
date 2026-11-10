import { BUILTINS, type Category } from './builtins';
import type { CommandMatch, SlashCommand } from './slashCommands';
import { slashWord } from './slashTrigger';

/** A row of the board composer's `/` menu: what it shows, what picking it puts in the box, and what Enter does. */
export interface CommandRow {
  /** `/name`, or `/alias` when the query matched an alias. */
  label: string;
  /** What Tab (and Enter on a row that does not run) puts in the box: `/name `. */
  insert: string;
  /** `alias of /name`, or where it comes from (`user`, `project`, `built-in`); none for a plugin's `plugin:name`. */
  detail?: string;
  description?: string;
  /** The argument hint (`<task>`, `[model]`), shown after Tab. */
  hint?: string;
  /** Built-ins the board handles: their category (A–E); absent for F, which starts a session on it. */
  category?: Category;
  /** The alias the query matched (`cost` for `/usage`). */
  alias?: string;
  /**
   * Enter runs it at once (as if `/name` was submitted) instead of inserting it: A, C and D commands that need no
   * argument, and E ones (the box then says why at once).
   */
  run?: boolean;
  /** A short tag for the row: `board` (A), `session` (C), `terminal` (D: opens the session), `unavailable` (E). */
  badge?: Badge;
}

export type Badge = 'board' | 'session' | 'terminal' | 'unavailable';

const BADGES: Partial<Record<Category, Badge>> = { A: 'board', C: 'session', D: 'terminal', E: 'unavailable' };

/**
 * True when a catalog hint names a required argument (`<task>`, `<path>`); `[x]` is optional. Only the catalog's hints
 * say so: the CLI writes `<…>` for optional ones too (`/compact <optional custom summarization instructions>`).
 */
export function needsArgument(hint: string | undefined): boolean {
  return !!hint && hint.trim().startsWith('<');
}

/** Built-ins that do nothing useful without an argument (`/btw`, `/plan`), by the catalog. */
const NEEDS_ARGUMENT = new Set(BUILTINS.filter((b) => needsArgument(b.argumentHint)).map((b) => b.name));

/**
 * True when Enter on the command in the `/` menu runs it: the board handles it (A, C, D) and it needs no argument, or it
 * is blocked (E), as sending it only shows why, which inserting it would delay to a second Enter.
 */
export function runsFromMenu(c: SlashCommand): boolean {
  if (c.category === 'E') return true;
  return (c.category === 'A' || c.category === 'C' || c.category === 'D') && !NEEDS_ARGUMENT.has(c.name);
}

/** The `/` menu row for a match of `filterCommands`. */
export function commandRow({ command: c, alias }: CommandMatch): CommandRow {
  const category = c.category && c.category !== 'F' ? c.category : undefined;
  const badge = category ? BADGES[category] : undefined;
  return {
    // Matched by an alias: the alias as typed, saying what it stands for.
    label: `/${alias ?? c.name}`,
    insert: `/${c.name} `,
    // A plugin's commands already start with its name.
    ...(alias ? { detail: `alias of /${c.name}`, alias } : c.name.startsWith(`${c.origin}:`) ? {} : { detail: c.origin }),
    description: c.description,
    ...(c.argumentHint ? { hint: c.argumentHint } : {}),
    ...(category ? { category } : {}),
    ...(runsFromMenu(c) ? { run: true } : {}),
    ...(badge ? { badge } : {}),
  };
}

/**
 * What the `/` menu can offer of `commands`: all but the internal ones; after other commands (`stacked`: `/skill-a /sk`,
 * skills stack up to six) only what starts a session on the text (F), as only a message's first command runs otherwise.
 */
export function menuCommands(commands: readonly SlashCommand[], stacked = false): SlashCommand[] {
  return commands.filter((c) => !isInternal(c.name) && (!stacked || !c.category || c.category === 'F'));
}

/** Commands that are never offered, not even by their full name: Claude Code's internal ones. */
export function isInternal(name: string): boolean {
  return name.startsWith('_') || name === 'workflow-launch-exec';
}

/** How many skills a message can stack (`/a /b … text`). */
export const MAX_STACKED = 6;

/**
 * The names and aliases (lower case) of the built-ins the board handles (A–E): no skill stacks after them, as only a
 * message's first command runs and these do not start a session on the text. Posted to the webview with the board.
 */
export const UNSTACKABLE: readonly string[] = BUILTINS.filter((b) => b.category !== 'F').flatMap((b) => [b.name, ...b.aliases].map((n) => n.toLowerCase()));

/**
 * The `/` word the caret ends (`before` is the text up to it): at the very start, or after whitespace anywhere else
 * (`stacked`, for skills only: after up to five `/commands`, or in the middle of the text, `inline`, as Claude Code
 * runs a skill named there too). None when the text starts with commands one of which is in `unstackable`, as only a
 * message's first command runs and these do not start a session on the text. Undefined when the caret is not in one.
 */
export function slashTrigger(
  before: string,
  unstackable: readonly string[] = UNSTACKABLE,
): { start: number; query: string; stacked: boolean; inline?: true } | undefined {
  return slashWord(before, unstackable, MAX_STACKED);
}
