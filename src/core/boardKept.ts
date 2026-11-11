// What the Claude Board's prompt box keeps for a project folder (in `workspaceState`, see `BoardProjectState`): the
// choices picked in its pills, the text typed and not sent, the earlier prompts ⌥↑ goes through, and the lanes' filter
// and search. Pure: the webview's `keep` messages are checked here, and the saved values read back.

/** Earlier prompts kept for ⌥↑. */
export const HISTORY_MAX = 50;
/** The longest draft or earlier prompt kept (a pasted log is cut, not refused). */
export const TEXT_MAX = 100_000;
/** The longest mode, model or effort name, filter or search kept. */
const NAME_MAX = 500;

/**
 * The choices picked in this project folder (its override of the defaults: `devdesk.sessions.defaultMode`, the first
 * model the pill offers (`devdesk.board.models`), Default effort, Ultracode off). A field not there follows the default.
 */
export interface KeptChoice {
  mode?: string;
  model?: string;
  effort?: string;
  ultracode?: boolean;
  /** The Claude account picked in the account pill (`devdesk.claude.accounts`), by name. */
  account?: string;
}

/** The lanes' worktree filter and the search box's text. */
export interface KeptView {
  filter?: string;
  query?: string;
}

/** What a `keep` message changes; a field not there stays as saved. */
export interface KeepPatch {
  /** Choices picked (only those the user changed). */
  choice?: KeptChoice;
  /** The box's text, not sent yet. */
  draft?: string;
  /** A prompt that ran: it goes to the end of the earlier prompts. */
  remember?: string;
  filter?: string;
  query?: string;
}

/** What the extension posts to a webview that loaded (`restore`): only what this project folder has saved. */
export interface KeptState {
  choice?: KeptChoice;
  draft?: string;
  history?: string[];
  filter?: string;
  query?: string;
}

const name = (v: unknown) => (typeof v === 'string' && v.length <= NAME_MAX ? v : undefined);
const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, TEXT_MAX) : undefined);

/** The saved choice's known fields of the right type; an empty object when nothing (or nothing valid) is saved. */
export function parseKeptChoice(raw: unknown): KeptChoice {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: KeptChoice = {};
  for (const k of ['mode', 'model', 'effort', 'account'] as const) {
    const v = name(o[k]);
    if (v) out[k] = v;
  }
  if (typeof o.ultracode === 'boolean') out.ultracode = o.ultracode;
  return out;
}

/** The saved earlier prompts: strings only, the last `HISTORY_MAX`. */
export function parseHistory(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(-HISTORY_MAX) : [];
}

export function parseView(raw: unknown): KeptView {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const filter = name(o.filter);
  const query = name(o.query);
  return { ...(filter !== undefined ? { filter } : {}), ...(query !== undefined ? { query } : {}) };
}

/** `history` with `prompt` at its end (not twice in a row), capped at `max`. */
export function rememberPrompt(history: readonly string[], prompt: string, max = HISTORY_MAX): string[] {
  const t = prompt.trim();
  if (!t || history[history.length - 1] === t) return history.slice(-max);
  return [...history, t].slice(-max);
}

/** The fields of a webview's `keep` message, checked; undefined when it changes nothing. */
export function parseKeep(o: Record<string, unknown>): KeepPatch | undefined {
  const patch: KeepPatch = {};
  if (o.choice && typeof o.choice === 'object') {
    const choice = parseKeptChoice(o.choice);
    if (Object.keys(choice).length) patch.choice = choice;
  }
  const draft = text(o.draft);
  if (draft !== undefined) patch.draft = draft;
  const remember = text(o.remember)?.trim();
  if (remember) patch.remember = remember;
  const filter = name(o.filter);
  if (filter !== undefined) patch.filter = filter;
  const query = name(o.query);
  if (query !== undefined) patch.query = query;
  return Object.keys(patch).length ? patch : undefined;
}
