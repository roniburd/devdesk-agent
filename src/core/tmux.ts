import { createHash } from 'node:crypto';
import { shellQuote } from './shell';
import { execText } from './shellRun';

export type TmuxRunner = (args: string[]) => Promise<string>;

/** How DevDesk runs tmux: the binary (`tmux` on PATH by default) and a config file loaded when a server starts. */
export interface TmuxSetup {
  bin?: string;
  configFile?: string;
}

/** A tmux command that has not answered in this long is killed, so a stuck server cannot hang a refresh forever. */
const TMUX_TIMEOUT_MS = 15_000;

/** Runs the tmux binary `bin` (`tmux` on PATH by default). */
const execTmuxWith =
  (bin = 'tmux'): TmuxRunner =>
  (args) =>
    execText(bin, args, { timeoutMs: TMUX_TIMEOUT_MS });

/** False when the tmux binary `bin` cannot be run (not installed, or not on PATH). */
export function tmuxInstalled(bin = 'tmux'): Promise<boolean> {
  return execText(bin, ['-V']).then(
    () => true,
    () => false,
  );
}

/** The tmux server tmux uses without `-L`. */
export const DEFAULT_SERVER = 'default';

/** True for a name usable with `tmux -L` (it becomes a socket file name). */
export const isServerName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..';

/**
 * Arguments for `tmux` on a named server: `-L <server>` first, nothing extra for the default server. `configFile`
 * adds `-f <file>`, which tmux reads only when the command starts the server.
 */
export function serverArgs(server: string, args: string[], configFile?: string): string[] {
  const config = configFile ? ['-f', configFile] : [];
  if (server === DEFAULT_SERVER) return [...config, ...args];
  if (!isServerName(server)) throw new Error(`not a tmux server name: ${server}`);
  return [...config, '-L', server, ...args];
}

/** A runner for one tmux server (each `tmux -L <name>` is a separate server with its own sessions). */
export const tmuxRunner =
  (server: string, setup: TmuxSetup = {}): TmuxRunner =>
  (args) =>
    execTmuxWith(setup.bin)(serverArgs(server, args, setup.configFile));

export interface TmuxSession {
  name: string;
  attached: boolean;
  command: string;
}

export interface TmuxPane {
  session: string;
  /** tmux pane id such as `%12`, stable for the pane's lifetime (what Claude sees in `$TMUX_PANE`). */
  paneId: string;
  attached: boolean;
  /** tmux's name for the foreground process; a wrapper shell (`claude; exec $SHELL`) hides Claude behind `zsh`. */
  command: string;
  /** The pane's top process. */
  pid?: number;
  /** The pane's working directory (of its foreground process). */
  cwd?: string;
  /** The tmux server (`-L` name) the pane lives on; undefined means DEFAULT_SERVER. */
  server?: string;
  /** Set by callers that inspected the pane's process tree: Claude Code runs in it. */
  claude?: boolean;
  /** Set with `claude`: Claude Code's process, which names the session in Claude's registry (`sessions/<pid>.json`). */
  claudePid?: number;
}

/** Field separator: printable, because some tmux versions (3.6a) print a tab in a format as `_`. */
export const FIELD_SEP = '|^|';

/** The path comes last, so a path that contains FIELD_SEP still parses. */
export const LIST_FORMAT = ['#{session_name}', '#{session_attached}', '#{pane_id}', '#{pane_current_command}', '#{pane_pid}', '#{pane_current_path}'].join(FIELD_SEP);

/**
 * Unique tmux session per feature. The root is `cc-main`; a worktree is `cc-<name>`, with a short hash of its
 * directory appended when its name is `main` or had to be sanitized, so no two features share a session.
 */
export function sessionName(feature: { name: string; dir: string; isMain: boolean }): string {
  if (feature.isMain) return 'cc-main';
  const safe = feature.name.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe === feature.name && safe !== 'main') return `cc-${safe}`;
  return `cc-${safe}-${createHash('sha1').update(feature.dir).digest('hex').slice(0, 6)}`;
}

export function parsePanes(out: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split(FIELD_SEP);
    const [session, attached, paneId = '', command = '', pid = ''] = parts;
    const cwd = parts.slice(5).join(FIELD_SEP);
    const pane: TmuxPane = { session, paneId, attached: attached !== '0', command };
    if (/^\d+$/.test(pid)) pane.pid = Number(pid);
    if (cwd) pane.cwd = cwd;
    panes.push(pane);
  }
  return panes;
}

/** One entry per session, described by its first pane. */
export function sessionsOf(panes: readonly TmuxPane[]): TmuxSession[] {
  const sessions = new Map<string, TmuxSession>();
  for (const p of panes) {
    if (!sessions.has(p.session)) sessions.set(p.session, { name: p.session, attached: p.attached, command: p.command });
  }
  return [...sessions.values()];
}

/** Every pane of every tmux session; empty when tmux is missing or no server is running. Tagged with `server` if given. */
export async function listPanes(run: TmuxRunner, server?: string): Promise<TmuxPane[]> {
  try {
    const panes = parsePanes(await run(['list-panes', '-a', '-F', LIST_FORMAT]));
    return server === undefined ? panes : panes.map((p) => ({ ...p, server }));
  } catch {
    return [];
  }
}

export const serverOf = (p: { server?: string }) => p.server ?? DEFAULT_SERVER;

/** All tmux sessions; empty when tmux is missing or no server is running. */
export async function listSessions(run: TmuxRunner): Promise<TmuxSession[]> {
  return sessionsOf(await listPanes(run));
}

/** True when a tmux error says its target is gone: the pane or session was closed, or its server is no longer running. */
export const tmuxTargetGone = (message: string) => /can't find (pane|session|window)|no server running|error connecting to|server exited/i.test(message);

/** True for a tmux pane id (`%<n>`), the only pane target DevDesk passes to tmux. */
export const isPaneId = (s: unknown): s is string => typeof s === 'string' && /^%\d+$/.test(s);

/** `base` if no session has that name yet, else the first free `base-2`, `base-3`, ... (another Claude in the same feature). */
export function nextSessionName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** True for `base-<n>`, a session nextSessionName numbered after `base`. */
export const isNumberedSession = (name: string, base: string) => name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1));

/** The Claude Code binary DevDesk starts when `devdesk.sessions.claudePath` is empty. */
export const DEFAULT_CLAUDE_PATH = '$HOME/.toolbox/bin/claude';

/**
 * The shell command tmux runs in a new Claude session: `command` verbatim when set (`devdesk.claudeCommand`), else
 * `<path> <args>; exec $SHELL -l`, so the pane drops to a login shell when Claude exits. `path` and `args` are shell
 * text, not quoted, so `$HOME` and quoted arguments work. `extraArgs` follow `args`. `wrapper` (shell text) goes before
 * the binary, which it runs (the Program Status relay, `programStatusWrapper`); a full `command` runs without it.
 */
export function claudeShellCommand(opts: { command?: string; path?: string; args?: string; wrapper?: string }, extraArgs = ''): string {
  const command = opts.command?.trim();
  if (command) {
    // A full command is a shell snippet (`claude --model opus; exec $SHELL -l`): extra options go after its first word,
    // the binary, and a prompt (`-- 'fix it'`, which must come after every option) at the end of its first command.
    const cut = unquotedIndex(extraArgs, /(?<=^|\s)--(?=\s|$)/y);
    const options = (cut < 0 ? extraArgs : extraArgs.slice(0, cut)).trim();
    const prompt = cut < 0 ? '' : extraArgs.slice(cut).trim();
    const withOptions = options ? command.replace(/^\S+/, (claude) => `${claude} ${options}`) : command;
    if (!prompt) return withOptions;
    // `;`, `&`, `&&`, `|`, `||` or a newline ends it; `&` and `|` in a redirection (`2>&1`, `&>log`, `>|log`) do not.
    const end = unquotedIndex(withOptions, /[;\n]|(?<![<>])&(?!>)|(?<![>])\|/y);
    const first = (end < 0 ? withOptions : withOptions.slice(0, end)).trimEnd();
    return `${first} ${prompt}${withOptions.slice(first.length)}`;
  }
  const claude = [opts.wrapper?.trim(), opts.path?.trim() || DEFAULT_CLAUDE_PATH, opts.args?.trim(), extraArgs].filter(Boolean).join(' ');
  return `${claude}; exec $SHELL -l`;
}

/** Index of the first match of sticky `re` in shell text `s` outside quotes and backslash escapes; -1 if none. */
function unquotedIndex(s: string, re: RegExp): number {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (quote === '"' && ch === '\\') i++;
    } else if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else {
      re.lastIndex = i;
      if (re.test(s)) return i;
    }
  }
  return -1;
}

/** The command that installs tmux when `devdesk.sessions.tmuxInstallCommand` is empty: Homebrew on macOS, else yum (as on Fedora or RHEL). */
export function defaultTmuxInstallCommand(platform: string): string {
  return platform === 'darwin' ? 'brew install tmux' : 'sudo yum install -y tmux';
}

/** True for a Claude session id DevDesk may pass to a shell (Claude uses UUIDs). */
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);

/** Claude's arguments to continue a copy of session `sessionId`, leaving the original untouched. */
export function forkArgs(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`not a Claude session id: ${sessionId}`);
  return `--resume ${sessionId} --fork-session`;
}

/** Claude's arguments to continue session `sessionId` itself (a parked session); the session id stays the same. */
export function resumeArgs(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`not a Claude session id: ${sessionId}`);
  return `--resume ${sessionId}`;
}

/** True for a tmux option name: built-in (`mouse`, `history-limit`) or a user option (`@name`). */
const isOptionName = (s: string) => /^@?[A-Za-z][A-Za-z0-9_-]*$/.test(s);

/**
 * `devdesk.sessions.tmuxOptions` as name/value pairs for `set-option`: booleans become `on`/`off`, numbers strings.
 * Entries with an invalid name or a value of another type are dropped.
 */
export function tmuxOptions(raw: unknown): [string, string][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const options: [string, string][] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isOptionName(name)) continue;
    if (typeof value === 'boolean') options.push([name, value ? 'on' : 'off']);
    else if (typeof value === 'number' && Number.isFinite(value)) options.push([name, String(value)]);
    else if (typeof value === 'string') options.push([name, value]);
  }
  return options;
}

/**
 * Variables Claude Code sets for the programs it runs, which make a Claude started there act as that session's child
 * (or refuse to start, nested). A tmux server started from inside a Claude session (VS Code launched from one, an agent
 * that runs tmux) keeps them in its global environment and gives them to every session it starts.
 */
export const CLAUDE_CHILD_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
] as const;

/**
 * What a session DevDesk starts is told about itself: its tmux session and server, so the status hook need not ask tmux
 * (`devdesk_hook.py` reads them).
 */
export function launchTags(session: string, server: string): Record<string, string> {
  return { DEVDESK_TMUX_SESSION: session, DEVDESK_TMUX_SERVER: server };
}

/**
 * Attaches to session `name`, or creates it in `cwd` running `command` with `env` added to its environment (`-e`,
 * tmux 3.0+). Each of `options` is then set on the session (and its current window, for window options), on attach
 * too, so a changed setting reaches running sessions. tmux runs `;`-separated commands in one invocation.
 * `detached`: create it in the background instead (no client attaches; the Claude Board opens it later).
 * First it removes Claude's child-session variables (CLAUDE_CHILD_ENV_KEYS) from the server's global environment, which
 * the session would inherit: `-e` can only set a variable, and `start-server` lets this run before any session exists.
 */
export function attachArgs(
  name: string,
  cwd: string,
  command: string,
  env: Record<string, string> = {},
  options: readonly [string, string][] = [],
  detached = false,
): string[] {
  const unset = CLAUDE_CHILD_ENV_KEYS.flatMap((k) => ['set-environment', '-g', '-u', k, ';']);
  const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const set = options.flatMap(([option, value]) => [';', 'set-option', '-t', `=${name}:`, option, value]);
  return ['start-server', ';', ...unset, 'new-session', detached ? '-d' : '-A', '-s', name, '-c', cwd, ...vars, command, ...set];
}

/**
 * The longest command (in UTF-8 bytes) passed to `new-session` as is. tmux sends a command's arguments to its server in
 * one message of at most 16 KB and refuses a longer one ("command too long"), so a longer command (a long prompt) goes
 * through a script file (scriptedCommand).
 */
const MAX_INLINE_COMMAND_BYTES = 8 * 1024;

/** True when `command` can be passed to `new-session` as is (see MAX_INLINE_COMMAND_BYTES). */
export const fitsTmuxCommandLine = (command: string) => Buffer.byteLength(command, 'utf8') <= MAX_INLINE_COMMAND_BYTES;

/**
 * For a `command` too long for tmux's command line: the short command tmux runs instead (`. '<file>'`, so the same
 * shell runs it, `exec $SHELL -l` included) and the `script` to write to `file`, which first removes `dir` (the
 * private directory holding the file; the open file still reads to its end).
 */
export function scriptedCommand(command: string, dir: string, file: string): { command: string; script: string } {
  return { command: `. ${shellQuote(file)}`, script: `rm -rf ${shellQuote(dir)}\n${command}\n` };
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh']);

/** True when a tmux pane's current command is an interactive shell (login shells show as `-zsh`). */
export function isShellCommand(command: string): boolean {
  return SHELLS.has(command.replace(/^-/, ''));
}

export function sessionLabel(session: TmuxSession | undefined): string {
  if (!session) return '';
  return isShellCommand(session.command) ? '○ shell' : '● claude';
}

/** The tmux target of a session's pane: its pane id, else the current pane of its tmux session; undefined outside tmux. */
export function paneTarget(session: { tmuxSession?: string; tmuxPane?: string }): string | undefined {
  if (isPaneId(session.tmuxPane)) return session.tmuxPane;
  return session.tmuxSession ? `=${session.tmuxSession}:` : undefined;
}

/** `text` as one line typed at a prompt: line breaks and tabs become spaces (a typed newline would submit), other control characters go. */
export function typedLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
}

/** tmux arguments that kill session `name` exactly (`=` stops tmux matching a prefix). */
export function killSessionArgs(name: string): string[] {
  return ['kill-session', '-t', `=${name}`];
}

/** What stands for an ESC byte in pasted text: plain text, so the paste can neither end early (`ESC [201~`) nor move the cursor. */
export const INERT_ESCAPE = '<ESC>';

/**
 * `text` as it is pasted into a terminal: each ESC byte as `INERT_ESCAPE` (older tmux pastes control characters as
 * they are; newer tmux shows them as `^[`), line breaks as `\n`, and the other control characters, except tabs, dropped.
 */
export function pastedText(text: string): string {
  return text
    .replace(/\x1b/g, INERT_ESCAPE)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/**
 * `text` as a command line pasted at Claude's prompt: one line (Claude runs a pasted `/command` only when it is one
 * line; one that spans lines goes to the model as a prompt), its ESC bytes defused. One ending in `\` gets a space
 * after it: Claude reads Enter right after a `\` as "insert a newline", so nothing would be submitted (it trims the
 * line it runs).
 */
export function commandLine(text: string): string {
  return typedLine(pastedText(text)).replace(/\\$/, '\\ ');
}

/**
 * A command line split into what is typed (`lead`: `/name ` when an argument follows) and what is pasted (`rest`: the
 * argument, else the whole line). Claude shows a long paste as `[Pasted text #1]`, and a `/command` inside one goes to
 * the model as a prompt; typed before the paste, the command runs with the pasted argument, however long.
 */
export function commandParts(line: string): { lead: string; rest: string } {
  const m = /^(\/[A-Za-z0-9_.:-]+ )(.+)$/s.exec(line);
  return m ? { lead: m[1], rest: m[2] } : { lead: '', rest: line };
}

/** tmux arguments that type `text` into pane `target` literally (`-l`: key names in it stay text). For short safe text: no `;` at its end. */
export function typeArgs(target: string, text: string): string[] {
  if (!isPaneId(target) && !/^=[^:]+:$/.test(target)) throw new Error(`not a tmux pane target: ${target}`);
  // tmux reads an argument ending in `;` as the end of a command.
  if (text.endsWith(';')) throw new Error(`cannot type text ending in ';': ${text}`);
  return ['send-keys', '-t', target, '-l', '--', text];
}

/** The tmux paste buffer of one paste into a session: unique (`unique`), so pastes never take each other's or the user's. */
export function pasteBufferName(unique: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(unique)) throw new Error(`not a paste buffer suffix: ${unique}`);
  return `devdesk-send-${unique}`;
}

/** Default of `devdesk.board.pasteSettleMs`: how long Claude gets to take in a paste before Enter. */
export const DEFAULT_PASTE_SETTLE_MS = 500;

/** Bytes a paste is given per millisecond to arrive before Enter, on top of the settle delay. */
export const PASTE_BYTES_PER_MS = 4096;

/** How long to wait after pasting `bytes` bytes before Enter: `settleMs`, and 1 ms more per `PASTE_BYTES_PER_MS` bytes. */
export function pasteSubmitDelayMs(settleMs: number, bytes: number): number {
  const settle = Number.isFinite(settleMs) && settleMs > 0 ? Math.round(settleMs) : 0;
  return settle + Math.ceil(Math.max(0, bytes) / PASTE_BYTES_PER_MS);
}

/**
 * The tmux commands that paste the text in `file` into pane `target` as one bracketed paste, then submit it. Run them
 * one after the other: `load` reads the file into paste buffer `buffer` (a file, not an argument: tmux refuses a
 * command over about 16 KB); `paste` pastes it (`-p`: between bracketed-paste markers when the program asked for them,
 * as Claude does, so nothing in it is read as a key; `-d`: the buffer is deleted after); `drop` deletes the buffer when
 * the paste failed; `submit` is the Enter, sent on its own after a settle delay (Claude can leave a paste unsent when
 * Enter comes with it).
 */
export function pasteArgs(target: string, buffer: string, file: string): { load: string[]; paste: string[]; drop: string[]; submit: string[] } {
  if (!isPaneId(target) && !/^=[^:]+:$/.test(target)) throw new Error(`not a tmux pane target: ${target}`);
  return {
    load: ['load-buffer', '-b', buffer, file],
    paste: ['paste-buffer', '-d', '-p', '-b', buffer, '-t', target],
    drop: ['delete-buffer', '-b', buffer],
    submit: ['send-keys', '-t', target, 'Enter'],
  };
}

/**
 * What a terminal reattaching to tmux session `session` says while tmux attaches: which session, and that Claude kept
 * running there. Dimmed; tmux's screen replaces it once attached. Control characters in `title` are dropped.
 */
export function attachMessage(session: string, title?: string): string {
  const shown = title?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const which = shown ? `"${shown}" (tmux session ${session})` : `tmux session ${session}`;
  return `\x1b[2mReattaching to ${which}…\r\nClaude kept running there; this terminal reconnects to it.\x1b[0m\r\n`;
}

/**
 * A terminal's shell that prints `message` at once and then runs `bin args` in its place (`exec`), so the terminal
 * shows something while `bin` starts. `/bin/sh` gets the message and the command as arguments, never as script text.
 */
export function shellPrinting(message: string, bin: string, args: string[]): { shellPath: string; shellArgs: string[] } {
  return { shellPath: '/bin/sh', shellArgs: ['-c', 'printf "%s" "$1"; shift; exec "$@"', 'sh', message, bin, ...args] };
}
