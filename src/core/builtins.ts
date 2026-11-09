/**
 * Claude Code's built-in slash commands as the Claude Board's prompt box handles them, for CLI 2.1.316, and the one
 * function that decides what a submitted text is. See docs/superpowers/specs/2026-10-31-board-slash-commands-research.
 *
 * Categories:
 * - **A** board-native: the board does it itself, nothing is sent to Claude (`/model`, `/effort`, `/clear`, …).
 * - **B** launch flags: becomes arguments of the next new session (`/plan <task>`, `/add-dir <path>`).
 * - **C** sent to a running session (typed into its tmux pane when its prompt is empty).
 * - **D** interactive-only: sent to a running session or a new one, which is always opened so the user sees the panel.
 * - **E** blocked with an explanation in the box (harmful or pointless from the board, removed, or unavailable here).
 * - **F** passed through as a new session's first prompt (skills, workflows, prompt commands): today's behavior.
 */

export type Category = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface Builtin {
  /** Without the slash. */
  name: string;
  aliases: readonly string[];
  category: Category;
  argumentHint?: string;
  description: string;
  /** Left out of the `/` menu unless its full name (or an alias) is typed. */
  hidden?: boolean;
  /** Category E: why the board does not run it, shown in the box. */
  reason?: string;
}

type Row = [name: string, category: Category, description: string, extra?: Partial<Omit<Builtin, 'name' | 'category' | 'description'>>];

const WRAPPER_DISABLED = 'The toolbox Claude turns this command off.';
const NOT_FROM_BOARD = 'Run it in a Claude terminal: it changes Claude itself, not a session.';

const ROWS: Row[] = [
  // A: board-native.
  ['model', 'A', 'Set the model for the next session the board starts (not saved)', { argumentHint: '[model]' }],
  ['effort', 'A', 'Set the effort for the next session the board starts (not saved)', { argumentHint: '[low|medium|high|xhigh|max|auto|ultracode [on|off]]' }],
  ['clear', 'A', 'Clear the prompt box', { aliases: ['reset', 'new'] }],
  ['help', 'A', "The board's commands and what each one does"],
  ['resume', 'A', 'Pick a Claude session and open it', { aliases: ['continue'], argumentHint: '[session]' }],

  // B: launch flags for the next new session.
  ['plan', 'B', 'Start a new session in plan mode on a task', { argumentHint: '<task>' }],
  ['add-dir', 'B', 'Start a new session that can also work in another directory', { argumentHint: '<path>' }],

  // C: sent to a running session.
  ['compact', 'C', 'Free up context by summarizing the conversation so far', { argumentHint: '[instructions]' }],
  ['context', 'C', 'Show current context usage', { argumentHint: '[all]' }],
  ['usage', 'C', "Show session cost, plan usage, and what's contributing to your limits", { aliases: ['cost', 'stats'] }],
  ['status', 'C', 'Show version, model, account and connectivity'],
  ['rename', 'C', 'Rename the conversation', { aliases: ['name'], argumentHint: '[name]' }],
  ['color', 'C', 'Set the prompt bar color for the session', { argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]' }],
  ['goal', 'C', 'Set a goal: keep working until the condition is met', { argumentHint: '[condition|clear]' }],
  ['btw', 'C', 'Ask a side question without adding it to the conversation', { argumentHint: '<question>' }],
  ['fork', 'C', 'Fork the conversation into a background session', { argumentHint: '[prompt]' }],
  ['subtask', 'C', 'Hand a task to a subagent forked from the conversation', { argumentHint: '<task>' }],
  ['mcp', 'C', 'Manage MCP servers', { argumentHint: '[reconnect|enable|disable [<server>|all]]' }],
  ['output-style', 'C', 'List output styles or switch to one', { argumentHint: '[style]' }],
  ['reload-skills', 'C', 'Pick up skills added or changed on disk during the session'],
  ['reload-plugins', 'C', 'Activate pending plugin changes in the session', { argumentHint: '[--force]' }],
  ['recap', 'C', 'Generate a one-line session recap now'],
  ['rewind', 'C', 'Rewind the conversation or code to an earlier point', { aliases: ['checkpoint', 'undo'] }],
  ['export', 'C', 'Export the conversation to a file or the clipboard', { argumentHint: '[filename]' }],
  ['copy', 'C', "Copy Claude's last response to the clipboard", { argumentHint: '[N]' }],
  ['diff', 'C', 'Show the changes made in the session'],
  ['autocompact', 'C', 'Configure the auto-compact window size', { argumentHint: '[auto|<tokens>]' }],
  ['list-agents', 'C', 'List subagents, teammates, and other Claude sessions you can message', { aliases: ['peers'] }],

  // D: interactive-only panels; the session is always opened.
  ['permissions', 'D', 'Manage allow and deny rules for tools', { aliases: ['allowed-tools'] }],
  ['hooks', 'D', 'Manage hook configurations'],
  ['memory', 'D', 'Edit Claude memory files'],
  ['skills', 'D', 'List skills and turn them on or off'],
  ['tasks', 'D', 'List and manage background tasks', { aliases: ['bashes'] }],
  ['theme', 'D', 'Change the color theme'],
  ['config', 'D', 'Open the settings panel', { aliases: ['settings'], argumentHint: '[key=value]' }],
  ['plugin', 'D', 'Manage plugins and marketplaces: browse, install, enable', { aliases: ['plugins', 'marketplace'] }],
  ['keybindings', 'D', 'Edit the key bindings file'],
  ['sandbox', 'D', 'Configure the sandbox'],
  ['agents', 'D', 'Manage subagents'],
  ['ide', 'D', 'Manage IDE integrations'],
  ['privacy-settings', 'D', 'View and change privacy settings'],
  ['focus', 'D', 'Toggle focus view: just your prompt, summary, and response', { argumentHint: '[on|off]' }],
  ['tui', 'D', 'Switch the terminal renderer', { argumentHint: '[default|fullscreen]' }],
  ['release-notes', 'D', 'View release notes'],
  // Not in the CLI's headless list (they only exist in a terminal), so the catalog is all that knows them.
  ['branch', 'D', 'Branch the conversation at this point into a new session', { argumentHint: '[name]' }],
  ['import', 'D', 'Import settings from another coding agent', { argumentHint: '[codex|gemini|cursor] [--dry-run] [--yes]' }],
  ['advisor', 'D', 'Pick the advisor model, or turn the advisor off', { argumentHint: '[model|off]' }],

  // E: blocked.
  ['login', 'E', 'Sign in to your Anthropic account', { hidden: true, reason: WRAPPER_DISABLED }],
  ['logout', 'E', 'Sign out of your Anthropic account', { hidden: true, reason: WRAPPER_DISABLED }],
  ['upgrade', 'E', 'Upgrade your plan', { hidden: true, reason: WRAPPER_DISABLED }],
  ['install-github-app', 'E', 'Set up the Claude GitHub app', { hidden: true, reason: WRAPPER_DISABLED }],
  ['feedback', 'E', 'Send feedback about Claude Code', { aliases: ['bug'], hidden: true, reason: WRAPPER_DISABLED }],
  ['extra-usage', 'E', 'Buy extra usage', { hidden: true, reason: WRAPPER_DISABLED }],
  ['restart', 'E', 'Restart Claude Code', { aliases: ['update'], reason: 'A session the board starts has nothing to restart.' }],
  ['exit', 'E', 'Exit Claude Code', { aliases: ['quit'], reason: 'End a session with End on its card instead.' }],
  ['terminal-setup', 'E', 'Install the Shift+Enter key binding for newlines', { reason: NOT_FROM_BOARD }],
  ['setup-bedrock', 'E', 'Set up Amazon Bedrock', { reason: NOT_FROM_BOARD }],
  ['setup-vertex', 'E', 'Set up Google Vertex AI', { reason: NOT_FROM_BOARD }],
  ['remote-control', 'E', 'Control the session from another device', { aliases: ['rc'], reason: NOT_FROM_BOARD }],
  ['teleport', 'E', 'Move a web session to this terminal', { aliases: ['tp'], reason: NOT_FROM_BOARD }],
  ['mobile', 'E', 'Get the Claude mobile app', { reason: NOT_FROM_BOARD }],
  ['desktop', 'E', 'Continue in Claude Desktop', { reason: NOT_FROM_BOARD }],
  ['auto-mode-setup', 'E', 'Teach auto mode about your environment', { reason: NOT_FROM_BOARD }],
  ['voice', 'E', 'Talk to Claude', { reason: 'Voice input needs a terminal of its own.' }],
  ['cd', 'E', 'Change the working directory', { argumentHint: '<path>', reason: 'Pick where the session starts with the folder button instead.' }],
  ['background', 'E', 'Send the session to the background', { aliases: ['bg'], reason: 'Sessions the board starts already run in the background, with agent view off, so Claude turns /background off in them.' }],
  ['workflows', 'E', 'List workflows and their runs', { reason: 'The Claude view lists the workflows each session runs, under the session.' }],
  ['heapdump', 'E', 'Dump the JS heap to the Desktop', { hidden: true, reason: 'A debugging command for Claude Code itself.' }],
  ['vim', 'E', 'Vim editing mode (removed)', { hidden: true, reason: 'Claude Code removed /vim in v2.1.92: set the editor mode in /config.' }],
  ['pr-comments', 'E', 'Pull request comments (removed)', { hidden: true, reason: 'Claude Code removed /pr-comments in v2.1.91: ask Claude for the comments instead.' }],
  ['fast', 'E', 'Fast mode', { argumentHint: '[on|off]', reason: 'Fast mode is only available with the Anthropic API, not on Bedrock.' }],
  ['design', 'E', 'Claude Design', { reason: 'Claude Design is not available on Bedrock.' }],
  ['workflow-launch-exec', 'E', 'Internal', { hidden: true, reason: 'An internal command.' }],
];

/** The built-in commands the board knows, by category. Commands the CLI lists but this does not are category F. */
export const BUILTINS: readonly Builtin[] = ROWS.map(([name, category, description, extra]) => ({ name, category, description, aliases: [], ...extra }));

/** A command as `classifySubmission` looks it up: a name and its aliases. */
export interface KnownCommand {
  name: string;
  aliases?: readonly string[];
  /** `built-in`, `user`, `project` or a plugin's name (see `SlashCommand`). */
  origin?: string;
}

/** What the text in the box is: a command of a category, an unknown command, or plain text (a prompt). */
export type SubmissionKind = Category | 'unknown' | 'text';

export interface Submission {
  kind: SubmissionKind;
  /** The command's canonical name (without `/`), or what was typed for an unknown one; absent for plain text. */
  command?: string;
  /** The alias that was typed (`cost` for `/usage`), when it was one. */
  alias?: string;
  /** What follows the command, trimmed; for plain text, the whole text. */
  arg: string;
  /** The catalog entry, for built-ins. */
  builtin?: Builtin;
}

/**
 * A command at the very start: `/name` followed by whitespace or the end. The name starts with a letter or number of any
 * script and runs to the first space, so `/café` and `/model—sonnet` are names (an unknown one gets the warning, not a
 * paid turn). `/usr/bin` (a path: a second `/`) and `/` alone are not commands.
 */
const COMMAND = /^\/([\p{L}\p{N}][^\s/]*)(?:\s+([\s\S]*))?$/u;

/** The command `text` starts with (its name as typed, without `/`) and what follows it, trimmed; undefined for plain text. */
export function splitCommand(text: string): { name: string; arg: string } | undefined {
  const m = COMMAND.exec(text.trim());
  return m ? { name: m[1], arg: (m[2] ?? '').trim() } : undefined;
}

function lookup<T extends KnownCommand>(list: Iterable<T>, name: string): { entry: T; alias?: string } | undefined {
  const n = name.toLowerCase();
  let byAlias: { entry: T; alias?: string } | undefined;
  for (const c of list) {
    if (c.name.toLowerCase() === n) return { entry: c };
    if (!byAlias) {
      const alias = c.aliases?.find((a) => a.toLowerCase() === n);
      if (alias) byAlias = { entry: c, alias };
    }
  }
  return byAlias;
}

/**
 * What a submitted text is. A command counts only at the start of the text, by name or alias: the catalog decides the
 * category of built-ins, except a blocked (E) one a user's or project's command in `known` shares a name with; any other
 * command `known` lists (skills, workflows, plugin and MCP prompts) is F; anything else
 * starting with `/name` is unknown. Everything else is plain text.
 */
export function classifySubmission(text: string, catalog: readonly Builtin[] = BUILTINS, known: Iterable<KnownCommand> = []): Submission {
  const command = splitCommand(text);
  if (!command) return { kind: 'text', arg: text.trim() };
  const { name: typed, arg } = command;
  let builtin = lookup(catalog, typed);
  const other = lookup(known, typed);
  // A user's or project's command named like a blocked built-in (removed, turned off, not on Bedrock) is theirs: F.
  if (builtin?.entry.category === 'E' && other?.entry.origin !== undefined && other.entry.origin !== 'built-in') builtin = undefined;
  if (builtin) return { kind: builtin.entry.category, command: builtin.entry.name, ...(builtin.alias ? { alias: builtin.alias } : {}), arg, builtin: builtin.entry };
  if (other) return { kind: 'F', command: other.entry.name, ...(other.alias ? { alias: other.alias } : {}), arg };
  return { kind: 'unknown', command: typed, arg };
}

/** True for what starts a new session on the text as a prompt, so Ultracode and the Spec prefix apply: F and plain text. */
export function isPromptKind(kind: SubmissionKind): kind is 'F' | 'text' {
  return kind === 'F' || kind === 'text';
}

/** The command as typed: the alias when it was one (`/quit`), else its name. */
export function typedCommand(submission: Submission): string {
  return `/${submission.alias ?? submission.command ?? ''}`;
}

/**
 * `text` with its command spelled as Claude knows it (`/COST` as `/cost`): the box matches names in any case, the CLI
 * does not. Plain text and unknown commands stay as typed.
 */
export function spelledText(text: string, submission: Submission): string {
  if (submission.kind === 'text' || submission.kind === 'unknown' || !submission.command) return text;
  return text.replace(/^(\s*)\/\S+/, (_, space: string) => `${space}${typedCommand(submission)}`);
}

/** What the box says for a blocked (E) command: why the board does not run it. */
export function blockedNotice(submission: Submission): string {
  const of = submission.alias ? ` (/${submission.command})` : '';
  return `${typedCommand(submission)}${of} does not run from the board. ${submission.builtin?.reason ?? 'The board does not run this command.'}`;
}

/** Claude settings keys `/config key=value` would save that the board sets per launch instead, and its command for each. */
const LAUNCH_SETTING_KEYS: Readonly<Record<string, string>> = { model: '/model', effortlevel: '/effort' };

/**
 * For `/config` (`/settings`) with a `model=` or `effortLevel=` argument, what the box says instead of running it: it
 * would save the model or effort to the user's Claude settings (and switch a running session), which the board never
 * does. Undefined for anything else.
 */
export function savedLaunchSettingNotice(submission: Submission): string | undefined {
  if (submission.command !== 'config') return undefined;
  for (const m of submission.arg.matchAll(/(?:^|\s)([A-Za-z]+)\s*=/g)) {
    const instead = LAUNCH_SETTING_KEYS[m[1].toLowerCase()];
    if (instead) {
      return `${typedCommand(submission)} ${m[1]}=… would save it to your Claude settings, for every session. The board does not change those: use ${instead}, which sets it for the next session the board starts only.`;
    }
  }
  return undefined;
}

/** What the box says for an unknown command, before it is sent as text anyway. */
export function unknownCommandNotice(submission: Submission): string {
  return `${typedCommand(submission)} is not a command, skill or plugin prompt Claude knows here. Sent as text, a new session asks the model about it (a paid turn).`;
}
