import { splitCommand } from './builtins';
import type { CliModel } from './cliStream';
import type { LaunchMode } from './modes';
import { joinArgs } from './modes';
import { shellQuote } from './shell';

/** The `@` mention of a file for the prompt, followed by a space: quoted when its path has whitespace, as Claude Code reads it. */
export function fileMention(path: string): string {
  return `@${/\s/.test(path) ? `"${path}"` : path} `;
}

/** A choice in the composer's model or effort list that adds no argument: Claude's own default. */
export const DEFAULT_CHOICE = 'Default';

/** The model pill's choices when `devdesk.board.models` is empty and the CLI did not list its models: Claude Code's aliases, then their 1M-context ones. */
export const DEFAULT_MODELS: readonly string[] = [DEFAULT_CHOICE, 'opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'sonnet[1m]', 'fable[1m]'];

/** Every `claude --effort` level. */
export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `claude --effort` levels, after Claude's own default. */
export const EFFORTS: readonly string[] = [DEFAULT_CHOICE, ...EFFORT_LEVELS];

/** A row of the model pill: what `--model` gets (`Default`: none), what it shows, and the efforts it offers besides Default. */
export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  /** Effort levels besides Default (`[]`: the model takes no effort, such as a Bedrock router). */
  efforts: string[];
}

/**
 * The model pill's rows: Default first (no `--model`: the model in the user's Claude settings), then `setting`
 * (`devdesk.board.models`) when it lists any, else the CLI's picker rows (`cli`; its own `default` row is left out, as
 * `--model default` is not the user's setting), else Claude Code's aliases. A value the CLI has a row for takes its name,
 * description and efforts. `custom` values (typed with `/model`) follow when they are not there yet, unless `setting`
 * lists the models: it replaces the list.
 */
export function modelChoices(setting: readonly string[], cli: readonly CliModel[] | undefined, custom: readonly string[] = []): ModelChoice[] {
  const byValue = new Map((cli ?? []).map((m) => [m.value, m]));
  const cliDefault = byValue.get('default');
  const row = (value: string, description = ''): ModelChoice => {
    if (value === DEFAULT_CHOICE) {
      return { value, label: DEFAULT_CHOICE, description: 'The model in your Claude settings', efforts: [...(cliDefault?.efforts ?? EFFORT_LEVELS)] };
    }
    const m = byValue.get(value);
    return m ? { value, label: m.displayName, description: m.description, efforts: [...m.efforts] } : { value, label: value, description, efforts: [...EFFORT_LEVELS] };
  };
  const values = setting.length ? setting : [DEFAULT_CHOICE, ...(cli?.length ? cli.map((m) => m.value).filter((v) => v !== 'default') : DEFAULT_MODELS)];
  const rows = [...new Set(values)].map((v) => row(v));
  if (!setting.length) for (const value of custom) if (!rows.some((r) => r.value === value)) rows.push(row(value, TYPED_MODEL));
  return rows;
}

/** What a model typed with `/model` is described as in the model pill (`typedModels`). */
const TYPED_MODEL = 'Typed with /model';

/**
 * The models typed with `/model` (`custom`) that `rows` (the pill's) lack, which the box keeps when chosen without a row:
 * all of them when `devdesk.board.models` replaces the list.
 */
export function typedModels(rows: readonly ModelChoice[], custom: readonly string[]): ModelChoice[] {
  return rowlessChoices(custom, rows, TYPED_MODEL);
}

/** The `values` `rows` have no row for, as choices kept without a row (named as typed, with every effort level). */
function rowlessChoices(values: readonly string[], rows: readonly ModelChoice[], description: string): ModelChoice[] {
  return [...new Set(values)].filter((value) => !rows.some((r) => r.value === value)).map((value) => ({ value, label: value, description, efforts: [...EFFORT_LEVELS] }));
}

/** Claude Code's `--model` aliases: `/model` takes them without a row, as Claude does. */
const CLAUDE_MODEL_ALIASES: readonly string[] = ['best', 'sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'sonnet[1m]', 'opus[1m]', 'fable[1m]'];

/** Whether `want` is one of Claude's aliases, in any case (`OPUS[1M]`). */
export const isClaudeAlias = (want: string) => CLAUDE_MODEL_ALIASES.includes(want.toLowerCase());

/**
 * Claude's aliases the box takes though the pill has no row for them (`rows`), as `--model` takes them as typed: a
 * model picked from the alias rows before the CLI listed its models stays chosen (in the box, a prompt saved for later,
 * its Start) once the CLI's rows replace them, without becoming a row. None when `devdesk.board.models` (`setting`)
 * lists the models.
 */
export function aliasChoices(setting: readonly string[], rows: readonly ModelChoice[]): ModelChoice[] {
  return setting.length ? [] : rowlessChoices(CLAUDE_MODEL_ALIASES, rows, "Claude's alias");
}

/** A name without case, spaces or punctuation (`Opus (1M context)` → `opus1mcontext`), to match what `/model` was given. */
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether `/model <want>` names Default: `default`, or `Default model` (what the model pill shows for it), in any case. */
export function isDefaultModelName(want: string): boolean {
  const w = want.trim().toLowerCase().replace(/\s+/g, ' ');
  return w === 'default' || w === 'default model';
}

/**
 * The rows whose name starts with `want` (ignoring case, spaces and punctuation: `opus 1m` → `Opus (1M context)`), for a
 * `want` that is neither Default nor one of Claude's aliases (which `--model` takes as typed).
 */
export function modelsStartingWith(rows: readonly ModelChoice[], want: string): ModelChoice[] {
  const w = want.trim();
  const key = loose(w);
  if (!key || isDefaultModelName(w) || isClaudeAlias(w)) return [];
  return rows.filter((r) => loose(r.label).startsWith(key));
}

/**
 * The model pill's row `/model <want>` means: the row whose value is `want` (exactly, then in any case), Default for
 * `default` or `Default model`, the row whose name is `want` (in any case, then ignoring spaces and punctuation), the
 * 1M-context row of a `[1m]` alias's model (`opus[1m]` → `Opus (1M context)`), else the only row in `modelsStartingWith`; undefined when none or several do.
 */
export function findModel(rows: readonly ModelChoice[], want: string): ModelChoice | undefined {
  const w = want.trim();
  const lower = w.toLowerCase();
  const key = loose(w);
  const exact =
    rows.find((r) => r.value === w) ??
    (isDefaultModelName(w) ? rows.find((r) => r.value === DEFAULT_CHOICE) : undefined) ??
    rows.find((r) => r.value.toLowerCase() === lower) ??
    rows.find((r) => r.label.toLowerCase() === lower) ??
    (key ? rows.find((r) => loose(r.label) === key) : undefined);
  if (exact) return exact;
  // `opus[1m]` (any case) is the 1M-context row of the model `opus` names, when the pill has one.
  const base = /^(.+)\[1m\]$/i.exec(w)?.[1];
  if (base && isClaudeAlias(w)) {
    const baseRow = findModel(rows, base);
    const long = baseRow && longContextRow(rows, baseRow);
    if (long) return long;
  }
  const starting = modelsStartingWith(rows, w);
  return starting.length === 1 ? starting[0] : undefined;
}

/** The 1M-context row of a model's (`Opus` → `Opus (1M context)`), so choosing the 200K one can say so. */
export function longContextRow(rows: readonly ModelChoice[], row: ModelChoice): ModelChoice | undefined {
  return row.value === DEFAULT_CHOICE ? undefined : rows.find((r) => r !== row && r.label === `${row.label} (1M context)`);
}

/** What **Spec** puts before a prompt when the brainstorming skill is not there (and `devdesk.board.specPrompt` is empty). */
export const SPEC_INSTRUCTION = 'Before changing any code, write a design spec for the following and wait for my review of it.';

/** The skill **Spec** uses when it is installed and enabled. */
const SPEC_SKILL = 'superpowers:brainstorming';

/** Where a composed session runs: `main`, an existing worktree's directory, or `new` (a worktree named `worktreeName`, else after the prompt). */
export type ComposeWhere = 'main' | 'new' | string;

/** How a prompt is run: everything the composer picks besides the text. Saved with a prompt for later. */
export interface LaunchChoice {
  where: ComposeWhere;
  worktreeName?: string;
  /** A mode name from `devdesk.sessions.modes`. */
  mode: string;
  model: string;
  effort: string;
  ultracode: boolean;
}

export interface ComposeRequest extends LaunchChoice {
  prompt: string;
  /** Save to Prompts for later instead of starting now. */
  later: boolean;
}

/** What the extension accepts from the composer: the posted choices, so the webview never sends arguments. */
export interface ComposeAllowed {
  modes: readonly string[];
  /** The mode an unknown one falls back to (`devdesk.sessions.defaultMode`). */
  defaultMode: string;
  models: readonly string[];
  /** The effort levels each model offers besides Default (`ModelChoice.efforts`); a model not in it offers all. */
  efforts?: Readonly<Record<string, readonly string[]>>;
  /** Directories of the existing worktrees (main excluded). */
  worktrees: readonly string[];
}

/** What a compose message may choose, from the model pill's rows. */
export function allowedModels(rows: readonly ModelChoice[]): Pick<ComposeAllowed, 'models' | 'efforts'> {
  return { models: rows.map((r) => r.value), efforts: Object.fromEntries(rows.map((r) => [r.value, r.efforts])) };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * The launch choice in a webview message or a saved prompt, keeping only what the extension offers: an unknown mode
 * falls back to the default mode, an unknown model or effort to the first choice (an effort the model does not offer
 * to Default), an unknown worktree to main.
 */
export function parseChoice(m: Record<string, unknown>, allowed: ComposeAllowed): LaunchChoice {
  const pick = (v: unknown, list: readonly string[], fallback = list[0] ?? DEFAULT_CHOICE) => (list.includes(str(v) ?? '') ? (v as string) : fallback);
  const where = str(m.where);
  const worktreeName = str(m.worktreeName)?.trim();
  const model = pick(m.model, allowed.models);
  const efforts = allowed.efforts?.[model];
  const choice: LaunchChoice = {
    where: where === 'new' ? 'new' : where && allowed.worktrees.includes(where) ? where : 'main',
    mode: pick(m.mode, allowed.modes, allowed.defaultMode),
    model,
    effort: pick(m.effort, efforts ? [DEFAULT_CHOICE, ...efforts] : EFFORTS),
    ultracode: m.ultracode === true,
  };
  if (choice.where === 'new' && worktreeName) choice.worktreeName = worktreeName;
  return choice;
}

/** The worktree a message or saved choice names that is not (any more) one of `allowed`'s; undefined for main, new or a known one. */
export function missingWorktree(m: unknown, allowed: ComposeAllowed): string | undefined {
  const where = m && typeof m === 'object' ? str((m as Record<string, unknown>).where) : undefined;
  return where && where !== 'main' && where !== 'new' && !allowed.worktrees.includes(where) ? where : undefined;
}

/** A composer message (`{ type: 'compose', prompt, … }`), or undefined when it has no prompt. */
export function parseCompose(m: unknown, allowed: ComposeAllowed): ComposeRequest | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const prompt = str(o.prompt)?.trim();
  if (!prompt) return undefined;
  return { prompt, later: o.later === true, ...parseChoice(o, allowed) };
}

/** `--model` and `--effort` for a choice (nothing for the defaults), in shell syntax. */
export function choiceArgs(choice: Pick<LaunchChoice, 'model' | 'effort'>): string {
  return joinArgs(
    choice.model !== DEFAULT_CHOICE ? `--model ${shellQuote(choice.model)}` : '',
    choice.effort !== DEFAULT_CHOICE ? `--effort ${shellQuote(choice.effort)}` : '',
  );
}

/**
 * The prompt Claude starts on: `prefix` (Spec) first, `ultracode` on its own last line when chosen. An instruction
 * prefix goes after a leading skill or command (`/simplify <instruction>\n\n<args>`): Claude runs one only at the
 * start of the prompt.
 */
export function launchPrompt(prompt: string, options: { ultracode?: boolean; prefix?: string } = {}): string {
  const prefix = options.prefix?.trim();
  const text = prefix ? prefixed(prompt, prefix) : prompt;
  return options.ultracode ? `${text}\n\nultracode` : text;
}

function prefixed(prompt: string, prefix: string): string {
  if (prefix.startsWith('/')) {
    // A prompt that already starts with the command (Spec on '/superpowers:brainstorming a login page') keeps it once.
    const own = prompt.trim();
    return own === prefix || (own.startsWith(prefix) && /\s/.test(own[prefix.length])) ? own : `${prefix} ${prompt}`;
  }
  // As the box classifies a command (`/usr/bin is slow` is plain text).
  const command = splitCommand(prompt);
  if (!command) return `${prefix}\n\n${prompt}`;
  return command.arg ? `/${command.name} ${prefix}\n\n${command.arg}` : `/${command.name} ${prefix}`;
}

/** What **Spec** puts before a prompt: `setting` when set, else the brainstorming skill if it is there, else an instruction. */
export function specPrefix(setting: string | undefined, commandNames: Iterable<string>): string {
  if (setting?.trim()) return setting.trim();
  for (const name of commandNames) if (name === SPEC_SKILL) return `/${SPEC_SKILL}`;
  return SPEC_INSTRUCTION;
}

/** The models `devdesk.board.models` lists: non-empty strings, without duplicates; none when it is empty or not a list. */
export function parseModels(value: unknown): string[] {
  const models = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean) : [];
  return [...new Set(models)];
}

/** The composer's colour for a mode, like Claude Code's: plan, permission-skipping ones (danger), auto-edit, or the default. */
export type ModeTone = 'plan' | 'danger' | 'edits' | 'default';

export function modeTone(mode: LaunchMode): ModeTone {
  const a = mode.args;
  if (/permission-mode[ =]plan\b/.test(a)) return 'plan';
  if (/dangerously-skip-permissions|permission-mode[ =](bypassPermissions|auto)\b/.test(a)) return 'danger';
  if (/permission-mode[ =]acceptEdits\b/.test(a)) return 'edits';
  return 'default';
}

/** The mode **Plan** starts a prompt for later in: the configured mode that plans, else Claude's plan permission mode. */
export function planMode(modes: readonly LaunchMode[]): LaunchMode {
  return modes.find((m) => modeTone(m) === 'plan') ?? { name: 'Plan', args: '--permission-mode plan' };
}
