import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { type BesideMode, type CardTitleMode, DEFAULT_LANE_WIDTH, MIN_LANE_WIDTH } from './core/board';
import { parseModels } from './core/composer';
import { EXTENSION_ID } from './core/edition';
import { programStatusDirIn } from './core/programStatus';
import type { ParkPolicy } from './core/park';
import { SORT_MODES, type SortMode } from './core/urgency';
import { DEFAULT_MODE_NAME, joinArgs, type LaunchMode, parseModes, pickMode } from './core/modes';
import { DEFAULT_CLAUDE_PATH, DEFAULT_SERVER, DEFAULT_PASTE_SETTLE_MS, defaultTmuxInstallCommand, isServerName, tmuxOptions, tmuxRunner, type TmuxRunner, type TmuxSetup } from './core/tmux';
import { settingsGearCommand } from './core/settingsGear';
import { scrollLines } from './core/smoothScroll';
import { sanitizedTmuxConfig, userTmuxConfigFiles } from './core/tmuxConfig';
import { claudeConfigFilePath } from './core/trust';
import { accountConfigFile, accountDirs, accountEnv, accountOfTranscript, type ClaudeAccount, configDirOfTranscript, defaultAccount, parseAccounts, pickAccount } from './core/accounts';
import { claudeLaunchCommand, type ClaudeLaunch } from './core/sessionStart';
import type { TurnReadLimits } from './core/turnChangesRead';
import { type DaemonConfig, needsTunnelChoice, resolveWebSettings, type TunnelPreview, tunnelPreview, type WebSettings } from './core/web/config';
import { webDir } from './core/web/webState';
import type { WorktreeKind } from './core/worktreeTasks';
import { gitRootFor, isPackageWorkspace, normalizeRoot, workspaceRootFor } from './core/worktrees';
import { workspaceProvider } from './core/workspaceProvider';
import { noteLatency } from './log';
import { programStatusLaunchWrapper } from './programStatusLaunch';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('devdesk');
}

/** Sets a `devdesk.` setting in the user settings. */
export function setGlobalSetting(key: string, value: unknown): Thenable<void> {
  return cfg().update(key, value, vscode.ConfigurationTarget.Global);
}

/** Opens the Settings editor on this extension's settings matching `query` (a settings gear), on the Remote tab in a remote window. */
export function openSettings(query: string): Thenable<unknown> {
  return vscode.commands.executeCommand(...settingsGearCommand(vscode.env.remoteName, `@ext:${EXTENSION_ID} ${query}`));
}

const expandHome = (p: string | undefined) => p?.trim().replace(/^~(?=\/|$)/, homedir());

/**
 * A number setting: `fallback` when unset or not a number, rounded down when `integer` (to the nearest with `'round'`),
 * then clamped to `[min, max]`; with `below: 'fallback'`, a value under `min` gives `fallback` instead of `min`.
 */
function numberSetting(key: string, fallback: number, min: number, max = Infinity, integer: boolean | 'round' = false, below: 'clamp' | 'fallback' = 'clamp'): number {
  const value = cfg().get<number>(key, fallback);
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, fallback));
  const n = integer === 'round' ? Math.round(value) : integer ? Math.floor(value) : value;
  if (below === 'fallback' && n < min) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A boolean setting, `fallback` when unset. */
function bool(key: string, fallback: boolean): boolean {
  return cfg().get<boolean>(key, fallback);
}

/** A string setting that must be one of `values`; anything else (or unset) is `fallback`. */
function oneOf<T extends string>(key: string, values: readonly T[], fallback: T): T {
  const value = cfg().get<string>(key);
  return (values as readonly (string | undefined)[]).includes(value) ? (value as T) : fallback;
}

/** A string setting, trimmed; `''` when unset. */
function text(key: string): string {
  return cfg().get<string>(key)?.trim() ?? '';
}

/** A path setting with a leading `~` expanded; empty or unset: `fallback()`. */
function pathSetting(key: string, fallback: () => string): string {
  return expandHome(cfg().get<string>(key)) || fallback();
}

/** A path's workspace root: the package workspace containing it, else the git repository's main worktree. */
function rootFor(path: string): string | undefined {
  return workspaceRootFor(path) ?? gitRootFor(path);
}

/**
 * Setting `devdesk.worktrees.root`, else the package workspace containing the first workspace folder that is inside
 * one (opening one of its worktrees resolves to the workspace), else the git repository containing the first
 * folder that is in one (opening a linked worktree resolves to the main repository), else the first folder as it is
 * (a plain folder: sessions run there, but it has no worktrees). Undefined only when no local folder is open; the
 * Claude and Worktrees views are hidden then.
 */
export function workspaceRoot(): string | undefined {
  const explicit = expandHome(cfg().get<string>('worktrees.root'));
  if (explicit) return isPackageWorkspace(explicit) ? normalizeRoot(explicit) : (rootFor(explicit) ?? explicit);
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  for (const folder of folders) {
    const root = workspaceRootFor(folder);
    if (root) return root;
  }
  for (const folder of folders) {
    const root = gitRootFor(folder);
    if (root) return root;
  }
  return folders[0];
}

/** Old keys (DevDesk Agents', and renamed DevDesk Claude ones) and the keys that replace them, copied once on activation. */
export const MIGRATED_SETTINGS: [string, string][] = [
  ['devdesk.workspaceRoot', 'devdesk.worktrees.root'],
  ['devdesk.autoRefreshSeconds', 'devdesk.worktrees.refreshSeconds'],
  ['devdesk.claudeCommand', 'devdesk.sessions.command'],
  ['devdesk.sessions.worktreeKind', 'devdesk.worktrees.kind'],
  ['devdesk.sessions.worktreeCreateCommand', 'devdesk.worktrees.createCommand'],
  ['devdesk.sessions.worktreeStartPrompt', 'devdesk.worktrees.startPrompt'],
];

/** Rest this long between the Worktrees view's refreshes while it is visible (setting `devdesk.worktrees.refreshSeconds`); 0 disables. */
export function worktreesRefreshSeconds(): number {
  return numberSetting('worktrees.refreshSeconds', 20, 0);
}

/**
 * A package of a worktree that is expanded, or that a Claude session is busy in, loads again at least this often, for
 * edits git has not seen (setting `devdesk.worktrees.activeReloadSeconds`); 0: only when something says it changed.
 */
export function worktreesActiveReloadMs(): number {
  return numberSetting('worktrees.activeReloadSeconds', 60, 0) * 1000;
}

/** The other worktrees' packages load again about this often, spread over the refreshes (setting `devdesk.worktrees.idleReloadMinutes`); 0: only when something says they changed. */
export function worktreesIdleReloadMs(): number {
  return numberSetting('worktrees.idleReloadMinutes', 10, 0) * 60_000;
}

/**
 * Accept Claude's trust dialog for a worktree DevDesk makes, when Claude trusts the workspace it is made in (setting
 * `devdesk.worktrees.autoTrust`).
 */
export function worktreesAutoTrust(): boolean {
  return bool('worktrees.autoTrust', true);
}

/** Pause the Worktrees view's refresh while the VS Code window is in the background (setting `devdesk.worktrees.pauseWhenUnfocused`). */
export function worktreesPauseWhenUnfocused(): boolean {
  return bool('worktrees.pauseWhenUnfocused', true);
}

/** Where devdesk_hook.py writes session state (setting `devdesk.sessions.stateDir`). */
export function sessionsStateDir(): string {
  return pathSetting('sessions.stateDir', () => join(homedir(), '.claude', 'devdesk', 'state'));
}

/** Claude Code's own config directory, whatever the account: `$CLAUDE_CONFIG_DIR` (VS Code's), else `~/.claude`. */
export function ambientClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

/** The Claude accounts (setting `devdesk.claude.accounts`); one, `default` (Claude's own config directory), when none is listed. */
export function claudeAccounts(): ClaudeAccount[] {
  return parseAccounts(cfg().get<unknown>('claude.accounts'), ambientClaudeConfigDir(), homedir());
}

/**
 * The account new sessions use unless another is picked (setting `devdesk.claude.defaultAccount`, which a folder's
 * workspace settings may set; empty or unknown: the first listed).
 */
export function claudeDefaultAccount(): ClaudeAccount {
  return defaultAccount(claudeAccounts(), text('claude.defaultAccount'));
}

/** The account `name` names, else the default one. */
export function claudeAccount(name?: string): ClaudeAccount {
  return pickAccount(claudeAccounts(), name, text('claude.defaultAccount'));
}

/** `path` with the home directory shown as `~`, for messages. */
export function shownPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The account a session runs in, from its transcript's config directory (`<dir>/projects/…`): a listed one, else one
 * named after the directory. Undefined without a transcript (not started yet, or no hook record).
 */
export function claudeAccountOf(transcriptPath: string | undefined): ClaudeAccount | undefined {
  return accountOfTranscript(claudeAccounts(), transcriptPath, ambientClaudeConfigDir(), shownPath);
}

/**
 * Claude Code's config directory for `account` (default: the default account, which with no accounts listed is
 * `$CLAUDE_CONFIG_DIR`, else `~/.claude`). What DevDesk derives from Claude's config directory resolves it here.
 */
export function claudeConfigDir(account: ClaudeAccount = claudeDefaultAccount()): string {
  return account.configDir;
}

/** Every Claude config directory DevDesk reads: each account's, and Claude's own. */
export function claudeConfigDirs(): string[] {
  return accountDirs(claudeAccounts(), ambientClaudeConfigDir());
}

/** Where Claude Code keeps its transcripts: `projects` in each config directory (`claudeConfigDirs`). */
export function claudeProjectsDirs(): string[] {
  return claudeConfigDirs().map((d) => join(d, 'projects'));
}

/**
 * Where Claude Code lists its running sessions and their names (setting `devdesk.sessions.claudeSessionsDir`).
 * Empty means `sessions` in each Claude config directory (`claudeConfigDirs`).
 */
export function claudeSessionsDirs(): string[] {
  const explicit = expandHome(cfg().get<string>('sessions.claudeSessionsDir'));
  return explicit ? [explicit] : claudeConfigDirs().map((d) => join(d, 'sessions'));
}

/**
 * Where Claude Code keeps its background jobs, read for the session each /fork was forked from (setting
 * `devdesk.sessions.claudeJobsDir`). Empty means `jobs` in the config directory of the session's transcript, else
 * the default account's.
 */
export function claudeJobsDir(transcriptPath?: string): string {
  return pathSetting('sessions.claudeJobsDir', () => join(configDirOfTranscript(transcriptPath) ?? claudeConfigDir(), 'jobs'));
}

/** Sessions DevDesk starts run with `DISABLE_AUTOUPDATER=1` (setting `devdesk.claude.disableAutoUpdater`). */
export function claudeDisableAutoUpdater(): boolean {
  return bool('claude.disableAutoUpdater', false);
}

/** List packages without changes in the Worktrees view (setting `devdesk.worktrees.showCleanPackages`). */
export function worktreesShowCleanPackages(): boolean {
  return bool('worktrees.showCleanPackages', false);
}

/** Each worktree row of the Worktrees view lists its Claude sessions above its packages (setting `devdesk.worktrees.showSessions`). */
export function worktreesShowSessions(): boolean {
  return bool('worktrees.showSessions', true);
}

/** Load every worktree's changes in the background while the Worktrees view is visible (`devdesk.worktrees.prefetch`). */
export function worktreesPrefetch(): boolean {
  return bool('worktrees.prefetch', true);
}

/**
 * The most git processes the Worktrees view runs at once (setting `devdesk.worktrees.maxGitProcesses`); background loads
 * use a share of it (`backgroundGitProcesses`). 0, what the setting used to mean "adaptive", is the default.
 */
export function worktreesMaxGitProcesses(): number {
  return numberSetting('worktrees.maxGitProcesses', 8, 0, 32, true) || 8;
}

/** A git command in the Worktrees view that runs longer is stopped and its package shows an error; 0 never stops it. */
export function worktreesGitTimeoutMs(): number {
  return numberSetting('worktrees.gitTimeoutSeconds', 30, 0) * 1000;
}

/** Poll interval for the sessions model (setting `devdesk.sessions.pollSeconds`, clamped to 1 s – 1 h). */
export function sessionsPollMs(): number {
  return numberSetting('sessions.pollSeconds', 3, 1, 3600) * 1000;
}

/** Notify when a Claude session starts waiting for input (setting `devdesk.sessions.notifyWhenWaiting`). */
export function sessionsNotifyWhenWaiting(): boolean {
  return bool('sessions.notifyWhenWaiting', true);
}

/**
 * The tmux server (`tmux -L <name>`) DevDesk starts its Claude sessions on (setting `devdesk.sessions.tmuxServer`).
 * Empty means `devdesk`; `default` is tmux's own server (no `-L`). An invalid name falls back to `devdesk`.
 */
export function sessionsTmuxServer(): string {
  const value = cfg().get<string>('sessions.tmuxServer')?.trim() || 'devdesk';
  return isServerName(value) ? value : 'devdesk';
}

/** The tmux binary DevDesk runs (setting `devdesk.sessions.tmuxPath`); empty means `tmux` on PATH. */
export function sessionsTmuxPath(): string {
  return pathSetting('sessions.tmuxPath', () => 'tmux');
}

/** The tmux config file the user set for DevDesk's tmux server (`devdesk.sessions.tmuxConfigFile`); empty: none. */
export function sessionsTmuxConfigFileSetting(): string {
  return expandHome(cfg().get<string>('sessions.tmuxConfigFile')) || '';
}

/** The sanitized config files already written in this process, so each is written once. */
const writtenTmuxConfigs = new Set<string>();

/**
 * DevDesk's own tmux config (`<stateDir>/tmux.conf`, sanitizedTmuxConfig): the user's tmux config without its hooks.
 * Written (when its content differs) the first time it is asked for in this process, so each install or update
 * rewrites it. Undefined when it can't be written: tmux then loads its own config.
 */
export function sanitizedTmuxConfigFile(): string | undefined {
  const file = join(sessionsStateDir(), 'tmux.conf');
  if (writtenTmuxConfigs.has(file)) return file;
  const text = sanitizedTmuxConfig(userTmuxConfigFiles(homedir(), process.env.XDG_CONFIG_HOME), 'devdesk.sessions.tmuxConfigFile');
  try {
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // Not written yet.
    }
    if (current !== text) {
      mkdirSync(sessionsStateDir(), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
    }
  } catch {
    return undefined;
  }
  writtenTmuxConfigs.add(file);
  return file;
}

/**
 * The tmux binary, and the config file for `server`: the file set in `devdesk.sessions.tmuxConfigFile`, else DevDesk's
 * sanitized one (sanitizedTmuxConfigFile). The config file only applies to DevDesk's tmux server, never to another
 * server DevDesk merely lists or attaches to. On tmux's own server (`default`), only the file set.
 */
export function sessionsTmuxSetup(server = sessionsTmuxServer()): TmuxSetup {
  if (server !== sessionsTmuxServer()) return { bin: sessionsTmuxPath(), configFile: undefined };
  // On tmux's own server (`default`), the user's config and hooks are theirs: DevDesk only loads a file they set.
  const configFile = sessionsTmuxConfigFileSetting() || (server === DEFAULT_SERVER ? undefined : sanitizedTmuxConfigFile());
  return { bin: sessionsTmuxPath(), configFile };
}

/** Runs tmux commands on `server` (DevDesk's by default) with the configured binary and config file. */
export function sessionsTmux(server = sessionsTmuxServer()): TmuxRunner {
  const run = tmuxRunner(server, sessionsTmuxSetup(server));
  // Each tmux subcommand's time feeds the slow-moment log (`devdesk.diagnostics.latencyOutlierFactor`).
  return async (args) => {
    const start = Date.now();
    try {
      return await run(args);
    } finally {
      noteLatency(`tmux ${args[0]}`, Date.now() - start);
    }
  };
}

/** Smooth wheel scrolling in DevDesk's tmux server (setting `devdesk.sessions.smoothScroll`, experimental): off by default. */
export function sessionsSmoothScroll(): boolean {
  return bool('sessions.smoothScroll', false);
}

/** Lines one wheel event scrolls with smooth scrolling on (setting `devdesk.sessions.smoothScrollLines`), 1 to 10. */
export function sessionsSmoothScrollLines(): number {
  return scrollLines(cfg().get('sessions.smoothScrollLines'));
}

/** With smooth scrolling on, fast wheel scrolling goes further (setting `devdesk.sessions.smoothScrollAcceleration`): on by default. */
export function sessionsSmoothScrollAcceleration(): boolean {
  return bool('sessions.smoothScrollAcceleration', true);
}

/** tmux options DevDesk sets on each of its Claude sessions (setting `devdesk.sessions.tmuxOptions`), as name/value pairs. */
export function sessionsTmuxOptions(): [string, string][] {
  return tmuxOptions(cfg().get('sessions.tmuxOptions'));
}

/** Shell command that installs tmux (setting `devdesk.sessions.tmuxInstallCommand`); empty: Homebrew on macOS, else yum. */
export function sessionsTmuxInstallCommand(): string {
  return text('sessions.tmuxInstallCommand') || defaultTmuxInstallCommand(process.platform);
}

/**
 * How DevDesk starts Claude in a new tmux session: `devdesk.claudeCommand` verbatim when set, else
 * `devdesk.sessions.claudePath` (empty: the toolbox Claude) with `devdesk.sessions.claudeArgs`, then a login shell.
 * The launch mode's arguments (the default mode unless `mode` is given), then `extraArgs` (for example a fork's
 * `--resume <id> --fork-session`), follow `claudeArgs`; with a full command they go right after its first word, except a prompt (`-- 'text'`), which goes after the command's own options.
 * Claude runs in `account` (default: the default account): its `CLAUDE_CONFIG_DIR` and `env` are exported first.
 */
export function sessionsClaudeCommand(extraArgs = '', mode: LaunchMode = sessionsDefaultMode(), account: ClaudeAccount = claudeDefaultAccount()): string {
  return claudeLaunchCommand(sessionsLaunch(mode, account), extraArgs);
}

/** How new sessions run Claude in launch mode `mode` and Claude account `account` (see `claudeLaunchCommand`). */
export function sessionsLaunch(mode: LaunchMode = sessionsDefaultMode(), account: ClaudeAccount = claudeDefaultAccount()): ClaudeLaunch {
  const c = cfg();
  const command = c.get<string>('sessions.command');
  const wrapper = !command?.trim() && sessionsProgramStatus() ? programStatusLaunchWrapper(ambientClaudeConfigDir(), programStatusDir()) : undefined;
  const launch: ClaudeLaunch = { modeArgs: mode.args, env: accountEnv(account) };
  const path = claudeBinary();
  const args = c.get<string>('sessions.claudeArgs');
  if (command) launch.command = command;
  if (path) launch.path = path;
  if (args) launch.args = args;
  if (wrapper) launch.wrapper = wrapper;
  return launch;
}

/**
 * What `sessionsClaudeCommand` gives Claude before its extra arguments, as shell text: `devdesk.claudeCommand` or
 * `devdesk.sessions.claudeArgs`, and the launch mode's arguments (to tell whether they already pick a model).
 */
export function sessionsLaunchArgs(mode: LaunchMode = sessionsDefaultMode()): string {
  const c = cfg();
  return joinArgs(c.get<string>('sessions.command'), c.get<string>('sessions.claudeArgs'), mode.args);
}

/**
 * New sessions run Claude under DevDesk's Program Status relay, which gets Claude to report its state (OSC 7501) to a
 * file per pane (setting `devdesk.sessions.programStatus`).
 */
export function sessionsProgramStatus(): boolean {
  return bool('sessions.programStatus', true);
}

/**
 * A hooked session whose record says working or waiting and has not changed for this long takes the state Claude
 * itself reports instead, when it differs (setting `devdesk.sessions.hooksQuietMinutes`; 0: never).
 */
export function sessionsHooksQuietMs(): number {
  return numberSetting('sessions.hooksQuietMinutes', 2, 0) * 60_000;
}

/** Where the Program Status relay writes each pane's status: `status` in the sessions state directory. */
export function programStatusDir(): string {
  return programStatusDirIn(sessionsStateDir());
}

/** The Claude binary new sessions run (setting `devdesk.sessions.claudePath`; empty: the toolbox Claude, else `claude` on PATH). */
function claudeBinary(): string | undefined {
  return expandHome(cfg().get<string>('sessions.claudePath')) || (existsSync(join(homedir(), '.toolbox', 'bin', 'claude')) ? undefined : 'claude');
}

/**
 * Claude as new sessions run it, without the mode or prompt, in shell syntax: the first word of `devdesk.sessions.command`
 * when set (its binary), else the binary with `devdesk.sessions.claudeArgs`. The Claude Board asks it for its `/` list.
 */
export function claudeInvocation(): string {
  const command = cfg().get<string>('sessions.command')?.trim();
  if (command) return command.split(/\s/)[0];
  return joinArgs(claudeBinary() ?? DEFAULT_CLAUDE_PATH, cfg().get<string>('sessions.claudeArgs'));
}

/** The launch modes (setting `devdesk.sessions.modes`). */
export function sessionsModes(): LaunchMode[] {
  return parseModes(cfg().get<unknown>('sessions.modes'));
}

/** The mode + and every other new session use (setting `devdesk.sessions.defaultMode`, a mode name). */
export function sessionsDefaultMode(): LaunchMode {
  return pickMode(sessionsModes(), cfg().get<string>('sessions.defaultMode') || DEFAULT_MODE_NAME);
}

/** A done Claude session not updated for this long sorts as idle, after working ones (setting `devdesk.sessions.idleMinutes`, at least 1). */
export function sessionsIdleMs(): number {
  return numberSetting('sessions.idleMinutes', 30, 1) * 60_000;
}

/**
 * A session's terminal must be in front this long before what happened in it counts as read (setting
 * `devdesk.sessions.readAfterSeconds`, at least 0).
 */
export function sessionsReadAfterMs(): number {
  return numberSetting('sessions.readAfterSeconds', 1.5, 0) * 1000;
}

/**
 * Working Claude sessions keep their order for this long before they are sorted again, newest first (setting
 * `devdesk.sessions.resortWorkingMinutes`, at least 0; 0: always sorted).
 */
export function sessionsResortWorkingMs(): number {
  return numberSetting('sessions.resortWorkingMinutes', 5, 0) * 60_000;
}

/** How the Claude view and the Claude Board order sessions (setting `devdesk.sessions.sort`): `urgency` or `attention`. */
export function sessionsSort(): SortMode {
  return oneOf('sessions.sort', SORT_MODES, 'urgency');
}

/**
 * With `urgency` order, an unread finished turn sorts above working sessions for this long (setting
 * `devdesk.sessions.recentlyFinishedMinutes`, at least 1).
 */
export function sessionsRecentlyFinishedMs(): number {
  return numberSetting('sessions.recentlyFinishedMinutes', 15, 1) * 60_000;
}

/** Unread sessions sort above every read one (setting `devdesk.sessions.unreadFirst`); else only within their state. */
export function sessionsUnreadFirst(): boolean {
  return bool('sessions.unreadFirst', true);
}

/** The Claude view nests sessions under their worktree; off, it lists every session in one list (setting `devdesk.sessions.groupByWorktree`). */
export function sessionsGroupByWorktree(): boolean {
  return bool('sessions.groupByWorktree', false);
}

/** Read session titles are greyed in the Claude view (setting `devdesk.sessions.dimRead`). */
export function sessionsDimRead(): boolean {
  return bool('sessions.dimRead', true);
}

/** Unread sessions get a dot badge in the Claude view (setting `devdesk.sessions.unreadBadge`). */
export function sessionsUnreadBadge(): boolean {
  return bool('sessions.unreadBadge', true);
}

/** A working session with no hook event for this long shows as stuck (setting `devdesk.sessions.stuckMinutes`, at least 1). */
export function sessionsStuckMs(): number {
  return numberSetting('sessions.stuckMinutes', 10, 1) * 60_000;
}

/**
 * In DevDesk's Claude terminals, ← on an empty prompt focuses the Claude view instead of opening Claude's agent view
 * (setting `devdesk.sessions.leftArrowOpensSidebar`).
 */
export function sessionsLeftArrowOpensSidebar(): boolean {
  return bool('sessions.leftArrowOpensSidebar', true);
}

/** Reopen the Claude terminals that were open, attached to their tmux sessions, in a new window (setting `devdesk.sessions.restoreTerminals`). */
export function sessionsRestoreTerminals(): boolean {
  return bool('sessions.restoreTerminals', true);
}

/** How many characters of a session's title its terminal's tab shows; 0: the session's name only (setting `devdesk.sessions.tabTitleLength`). */
export function sessionsTabTitleLength(): number {
  return numberSetting('sessions.tabTitleLength', 24, 0, 80, true);
}

/**
 * Environment DevDesk adds to the Claude sessions it starts: without agent view while ← opens the sidebar instead, and
 * without Claude's auto-updater with `devdesk.claude.disableAutoUpdater`.
 */
export function sessionsClaudeEnv(): Record<string, string> {
  return {
    ...(sessionsLeftArrowOpensSidebar() ? { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' } : {}),
    ...(claudeDisableAutoUpdater() ? { DISABLE_AUTOUPDATER: '1' } : {}),
  };
}

/**
 * A Claude session's environment. The status hook asks tmux for the session name of a session without DevDesk's tags
 * (`launchTags`), so it is told which tmux when not the one on PATH.
 */
export function sessionsEnv(bin = sessionsTmuxPath()): Record<string, string> {
  return bin === 'tmux' ? sessionsClaudeEnv() : { ...sessionsClaudeEnv(), DEVDESK_TMUX: bin };
}

/** Show the "needs you" status bar item (setting `devdesk.sessions.statusBar`). */
export function sessionsStatusBar(): boolean {
  return bool('sessions.statusBar', true);
}

/** List subagents, background shells and workflows under each session (setting `devdesk.sessions.showChildren`). */
export function sessionsShowChildren(): boolean {
  return bool('sessions.showChildren', false);
}

/** Finished children listed per level, older ones folded into one row (setting `devdesk.sessions.finishedChildren`, at least 0). */
export function sessionsFinishedChildren(): number {
  return numberSetting('sessions.finishedChildren', 10, 0, Infinity, true);
}

/**
 * How far back Show Changes by Turn reads a session's transcript: the last `turns` turns (setting
 * `devdesk.sessions.turnChangesTurns`, 1 to 200), and at most `maxBytes` from its end and from each subagent's
 * (`devdesk.sessions.turnChangesMaxMB`, 1 to 1024). A line over 16 MB (or `maxBytes`) is skipped.
 */
export function sessionsTurnChangesLimits(): TurnReadLimits {
  const maxBytes = numberSetting('sessions.turnChangesMaxMB', 64, 1, 1024) * 1024 * 1024;
  return { turns: numberSetting('sessions.turnChangesTurns', 30, 1, 200, true), maxBytes, maxLine: Math.min(maxBytes, 16 * 1024 * 1024) };
}

/**
 * Parked sessions (not running) listed per worktree in the Claude view and on the Claude Board, newest first; older ones
 * fold into one row (setting `devdesk.sessions.finishedSessions`, at least 0).
 */
export function sessionsFinishedSessions(): number {
  return numberSetting('sessions.finishedSessions', 10, 0, Infinity, true);
}

/**
 * When DevDesk parks its sessions (ends their tmux session and Claude; the row stays to resume them), without the
 * memory reading: settings `devdesk.sessions.parkAfterDays` (any parkable session; `0` turns parking off),
 * `parkReadAfterMinutes` (a finished one you have read), `maxLiveSessions` (`0`: no limit) and `idleMinutes`.
 */
export function sessionsParkPolicy(): Omit<ParkPolicy, 'lowMemory'> {
  const days = numberSetting('sessions.parkAfterDays', 2, 0);
  return {
    anyMs: days * 86_400_000,
    readMs: numberSetting('sessions.parkReadAfterMinutes', 60, 0) * 60_000,
    maxLive: numberSetting('sessions.maxLiveSessions', 12, 0, Infinity, true),
    idleMs: sessionsIdleMs(),
  };
}

/** Park one more idle session while less than this percent of memory is free (setting `devdesk.sessions.parkBelowFreeMemoryPercent`); 0: never. */
export function sessionsParkBelowFreePercent(): number {
  return numberSetting('sessions.parkBelowFreeMemoryPercent', 10, 0, 100);
}

/** List only the sessions working in the open workspace (setting `devdesk.sessions.scope`, `workspace` by default). */
export function sessionsWorkspaceOnly(): boolean {
  return oneOf('sessions.scope', ['workspace', 'all'], 'workspace') !== 'all';
}

/** Which Claude sessions the Claude view lists (setting `devdesk.sessions.show`): those on the DevDesk tmux server, or all. */
export function sessionsShowAll(): boolean {
  return oneOf('sessions.show', ['vscode', 'all'], 'vscode') === 'all';
}

/**
 * What kind of worktree New Worktree Session makes in a package workspace (setting `devdesk.worktrees.kind`): one of
 * the workspace's own, unless set to `claude` (a git repository's are always Claude Code worktrees).
 */
export function sessionsWorktreeKind(): WorktreeKind {
  return !workspaceProvider || cfg().get<string>('worktrees.kind') === 'claude' ? 'claude' : 'workspace';
}

/** How features are discovered: with the packages' Claude Code worktrees while those are the kind New Worktree Session makes. */
export function featureDiscovery(): { claudeWorktrees: boolean } {
  return { claudeWorktrees: sessionsWorktreeKind() === 'claude' };
}

/** Shell command that creates a package workspace worktree named `$DEVDESK_WORKTREE` (setting `devdesk.worktrees.createCommand`). */
export function sessionsWorktreeCreateCommand(): string {
  return text('worktrees.createCommand') || (workspaceProvider?.defaultCreateCommand ?? '');
}

/** Shell command that deletes a package workspace worktree named `$DEVDESK_WORKTREE` (setting `devdesk.worktrees.deleteCommand`). */
export function worktreesDeleteCommand(): string {
  return text('worktrees.deleteCommand') || (workspaceProvider?.defaultDeleteCommand ?? '');
}

/** Clean Up Worktrees' settings (`devdesk.worktrees.cleanup*`): idle days, base branches (empty: each package's mainline), whether it deletes a git worktree's branch, and how many candidates make it suggest a cleanup (0: never). */
export function worktreesCleanup(): { idleDays: number; baseBranches: string[]; deleteBranch: boolean; suggestCount: number } {
  const bases = cfg().get<unknown>('worktrees.cleanupBaseBranches');
  return {
    idleDays: numberSetting('worktrees.cleanupIdleDays', 3, 0),
    baseBranches: Array.isArray(bases) ? bases.filter((b): b is string => typeof b === 'string').map((b) => b.trim()).filter(Boolean) : [],
    deleteBranch: cfg().get<boolean>('worktrees.cleanupDeleteBranch', false) === true,
    suggestCount: numberSetting('worktrees.cleanupSuggestCount', 5, 0, Infinity, true),
  };
}

/** Template of Claude's first prompt in a new worktree session (setting `devdesk.worktrees.startPrompt`; empty: the default). */
export function sessionsWorktreeStartPrompt(): string {
  return cfg().get<string>('worktrees.startPrompt') ?? '';
}

/** Open the Claude Board when the editor area has no tabs (setting `devdesk.board.openWhenEmpty`). */
export function boardOpenWhenEmpty(): boolean {
  return bool('board.openWhenEmpty', true);
}

/** Open the Claude Board the first time the sidebar shows in a window (setting `devdesk.board.openWithSidebar`). */
export function boardOpenWithSidebar(): boolean {
  return bool('board.openWithSidebar', true);
}

/**
 * The models the board composer offers instead of the CLI's (setting `devdesk.board.models`); empty: the CLI's model
 * picker rows (see `modelChoices`).
 */
export function boardModels(): string[] {
  return parseModels(cfg().get<unknown>('board.models'));
}

/** Where the Claude Board's prompt box sits: in its own square under the lanes (`bottom`, the default) or above them (setting `devdesk.board.promptPlacement`). */
export function boardPromptPlacement(): 'bottom' | 'top' {
  return oneOf('board.promptPlacement', ['bottom', 'top'], 'bottom');
}

/** After the composer starts a session: stay on the board (`board`, the default) or open its terminal (setting `devdesk.board.afterStart`). */
export function boardOpensSession(): boolean {
  return oneOf('board.afterStart', ['board', 'session'], 'board') === 'session';
}

/** Whether a session opened from the Claude Board opens beside it (setting `devdesk.board.sessionsBeside`, `auto` by default). */
export function boardSessionsBeside(): BesideMode {
  return oneOf<BesideMode>('board.sessionsBeside', ['auto', 'always', 'never'], 'auto');
}

/** Each lane's width (CSS px) when a session opens beside the board (setting `devdesk.board.laneWidth`; at least 180). */
export function boardLaneWidth(): number {
  return numberSetting('board.laneWidth', DEFAULT_LANE_WIDTH, MIN_LANE_WIDTH, Infinity, 'round');
}


/**
 * How long (ms) the Claude Board waits after pasting a command into a running session before it presses Enter
 * (setting `devdesk.board.pasteSettleMs`; 0 or more, and 1 ms more per 4 KB pasted: `pasteSubmitDelayMs`).
 */
export function boardPasteSettleMs(): number {
  return numberSetting('board.pasteSettleMs', DEFAULT_PASTE_SETTLE_MS, 0, Infinity, 'round');
}

/** Working and Needs you cards show one line on what Claude is doing or asks (setting `devdesk.board.cardLine`, on by default; the board's ☰ button toggles it). */
export function boardCardLine(): boolean {
  return bool('board.cardLine', true);
}

/**
 * What a board card's title says (setting `devdesk.board.cardTitle`): `objective` (the default, a prototype), what the
 * whole session sets out to do, with the latest step in small text under it; `latest`, the latest prompt's title.
 */
export function boardCardTitle(): CardTitleMode {
  return oneOf<CardTitleMode>('board.cardTitle', ['objective', 'latest'], 'objective');
}

/** What **Spec** puts before a prompt for later (setting `devdesk.board.specPrompt`); empty: derived (see `specPrefix`). */
export function boardSpecPrompt(): string {
  return text('board.specPrompt');
}

/** Where images pasted into the Claude Board's prompt box are saved (setting `devdesk.board.pastedImagesDir`). */
export function boardPastedImagesDir(): string {
  return pathSetting('board.pastedImagesDir', () => join(homedir(), '.claude', 'devdesk', 'pasted-images'));
}

/**
 * Claude Code's global config file, read for the folders Claude trusts, and written only to trust new worktrees
 * (`devdesk.worktrees.autoTrust`) (setting `devdesk.board.claudeConfigFile`); empty: `$CLAUDE_CONFIG_DIR/.claude.json`,
 * else `~/.claude.json`.
 */
export function boardClaudeConfigFile(): string {
  return pathSetting('board.claudeConfigFile', () => claudeConfigFilePath(process.env, homedir()));
}

/**
 * Claude Code's global config file for `account` (default: the default account), where it keeps the folders it
 * trusts: `boardClaudeConfigFile()` for Claude's own config directory, else `<config dir>/.claude.json`.
 */
export function claudeConfigFile(account: ClaudeAccount = claudeDefaultAccount()): string {
  return accountConfigFile(account, boardClaudeConfigFile());
}

/** Extension host memory diagnostics (`devdesk.diagnostics.*`). */
export interface DiagnosticsConfig {
  /** Where Node writes a diagnostic report (native stack, heap spaces, resource usage) when the extension host dies of a fatal error. */
  dir: string;
  heapSnapshotNearLimit: boolean;
  /** Heap snapshots and fatal-error reports older than this many days are deleted; 0 keeps them. */
  keepDays: number;
  heapWarnMB: number;
  heapGrowthWarnMB: number;
  /** Write debug lines at info level (`devdesk.diagnostics.debugLog`). */
  debugLog: boolean;
  /** Warn once about a DevDesk operation (git, tmux, a tree load) running this long; 0 disables. */
  slowOperationSeconds: number;
  /** Log a command, board render or tmux call that took this many times its usual (median) time; 0 disables. */
  latencyOutlierFactor: number;
  /** ...and at least this many milliseconds more than usual. */
  latencyOutlierMinMs: number;
}

/** A number setting at least 0: `fallback` when unset, not a number, or negative. */
const nonNegative = (key: string, fallback: number) => numberSetting(key, fallback, 0, Infinity, false, 'fallback');

/** The `devdesk.diagnostics.*` settings. */
export function diagnosticsConfig(): DiagnosticsConfig {
  return {
    dir: pathSetting('diagnostics.dir', () => join(homedir(), '.cache', 'devdesk', 'diagnostics')),
    heapSnapshotNearLimit: bool('diagnostics.heapSnapshotNearLimit', true),
    keepDays: nonNegative('diagnostics.keepDays', 3),
    heapWarnMB: nonNegative('diagnostics.heapWarnMB', 1500),
    heapGrowthWarnMB: nonNegative('diagnostics.heapGrowthWarnMB', 300),
    debugLog: bool('diagnostics.debugLog', false),
    slowOperationSeconds: nonNegative('diagnostics.slowOperationSeconds', 60),
    latencyOutlierFactor: nonNegative('diagnostics.latencyOutlierFactor', 3),
    latencyOutlierMinMs: nonNegative('diagnostics.latencyOutlierMinMs', 50),
  };
}

/** DevDesk's Haiku insights on session cards (setting `devdesk.insights.enabled`). */
export function insightsEnabled(): boolean {
  return bool('insights.enabled', true);
}

/** A working session's status is refreshed at most this often (setting `devdesk.insights.refreshSeconds`, at least 10). */
export function insightsRefreshMs(): number {
  return numberSetting('insights.refreshSeconds', 45, 10) * 1000;
}

/** How many insight calls run at once (setting `devdesk.insights.maxConcurrent`, 1–20). */
export function insightsMaxConcurrent(): number {
  return numberSetting('insights.maxConcurrent', 5, 1, 20, true);
}

/** The model insight calls use (setting `devdesk.insights.model`; empty: `haiku`). */
export function insightsModel(): string {
  return text('insights.model') || 'haiku';
}

/**
 * The Claude binary insight calls run, in shell syntax (setting `devdesk.insights.claudePath`): empty means the one
 * sessions run (`devdesk.sessions.claudePath`, else the toolbox Claude), without `devdesk.sessions.claudeArgs`.
 */
export function insightsClaude(): string {
  return pathSetting('insights.claudePath', () => claudeBinary() || DEFAULT_CLAUDE_PATH);
}

/** The model the board's ✨ search asks (setting `devdesk.boardSearch.model`; empty: `haiku`). */
export function boardSearchModel(): string {
  return text('boardSearch.model') || 'haiku';
}

/** A program or script (with arguments) that answers the board's ✨ search instead of `claude -p` (setting `devdesk.boardSearch.command`); empty: none. */
export function boardSearchCommand(): string {
  return pathSetting('boardSearch.command', () => '');
}

/** Whether the board's search also looks through past sessions (setting `devdesk.boardSearch.history`). */
export function boardSearchHistory(): boolean {
  return bool('boardSearch.history', true);
}

/** Which past sessions: this workspace's, or every folder's (setting `devdesk.boardSearch.historyScope`). */
export function boardSearchHistoryScope(): 'workspace' | 'all' {
  return oneOf('boardSearch.historyScope', ['workspace', 'all'], 'workspace');
}

/** Transcripts not changed for this many days are not searched (setting `devdesk.boardSearch.historyDays`, 1-3650). */
export function boardSearchHistoryDays(): number {
  return numberSetting('boardSearch.historyDays', 90, 1, 3650, true);
}

/** At most this many past sessions, the most recently changed, are indexed (setting `devdesk.boardSearch.historyMaxSessions`, 100-100000). */
export function boardSearchHistoryMaxSessions(): number {
  return numberSetting('boardSearch.historyMaxSessions', 5000, 100, 100_000, true);
}

/** Where Claude keeps its transcripts (setting `devdesk.boardSearch.historyDir`; empty: `projects` in each Claude config directory). */
export function boardSearchHistoryDirs(): string[] {
  const explicit = expandHome(cfg().get<string>('boardSearch.historyDir'));
  return explicit ? [explicit] : claudeProjectsDirs();
}

/** How long a ✨ search may take (setting `devdesk.boardSearch.timeoutSeconds`, 5–300). */
export function boardSearchTimeoutMs(): number {
  return numberSetting('boardSearch.timeoutSeconds', 30, 5, 300) * 1000;
}

/** Days of token usage history kept (setting `devdesk.usage.historyDays`, at least 1). */
export function usageHistoryDays(): number {
  return numberSetting('usage.historyDays', 365, 1, Infinity, true);
}

/** The most the usage history file may take on disk, in bytes (setting `devdesk.usage.historyMaxMB`, at least 0.1 MB). */
export function usageHistoryMaxBytes(): number {
  return Math.round(numberSetting('usage.historyMaxMB', 10, 0.1) * 1024 * 1024);
}

/** What the 📊 popup and the Claude Usage page show until a project is chosen in them (setting `devdesk.usage.defaultScope`). */
export function usageDefaultScope(): 'project' | 'all' {
  return oneOf('usage.defaultScope', ['project', 'all'], 'project');
}

/**
 * How long the board's history index may keep what it read only in memory before saving it, in ms (setting
 * `devdesk.boardSearch.historySaveMinutes`, 0-60; 0: after every run that read something).
 */
export function boardSearchHistorySaveMs(): number {
  return numberSetting('boardSearch.historySaveMinutes', 5, 0, 60) * 60_000;
}

/** Whether this window takes requests from the `devdesk` command Claude runs (setting `devdesk.cli.enabled`). */
export function cliEnabled(): boolean {
  return bool('cli.enabled', true);
}

/** Whether the 📊 popup shows Claude's plan limits, or offers DevDesk's status line to record them (setting `devdesk.usage.planLimits`). */
export function usagePlanLimits(): boolean {
  return bool('usage.planLimits', true);
}

/** The checks and review comments of worktrees' pull requests (settings `devdesk.checks.*`). */
export interface ChecksConfig {
  enabled: boolean;
  /** How long a worktree's checks are kept before they are fetched again; 0: only when asked. */
  refreshMs: number;
  /** The longest wait after failures in a row (the wait doubles each time). */
  maxBackoffMs: number;
  timeoutMs: number;
  gh: string;
  reviewComments: boolean;
  logLines: number;
  maxLogs: number;
}

export function checksConfig(): ChecksConfig {
  return {
    enabled: bool('checks.enabled', true),
    refreshMs: numberSetting('checks.refreshMinutes', 5, 0) * 60_000,
    maxBackoffMs: numberSetting('checks.maxBackoffMinutes', 60, 1) * 60_000,
    timeoutMs: numberSetting('checks.timeoutSeconds', 30, 1) * 1000,
    gh: pathSetting('checks.ghPath', () => 'gh'),
    reviewComments: bool('checks.reviewComments', true),
    logLines: numberSetting('checks.logLines', 40, 0, 500, true),
    maxLogs: numberSetting('checks.maxLogs', 3, 0, 20, true),
  };
}

/**
 * Coordinator and worker sessions (`devdesk worker`): the most workers one coordinator may run at once
 * (`devdesk.workers.maxConcurrent`), whether an idle coordinator is told about unread worker messages
 * (`devdesk.workers.nudge`), and how long a worker may sit stopped without reporting before its coordinator is told
 * (`devdesk.workers.escalationMinutes`; 0 tells it at once).
 */
export function workersConfig(): { maxConcurrent: number; nudge: boolean; escalationMs: number } {
  return {
    maxConcurrent: numberSetting('workers.maxConcurrent', 4, 1, 32, true),
    nudge: bool('workers.nudge', true),
    escalationMs: numberSetting('workers.escalationMinutes', 3, 0, 24 * 60) * 60_000,
  };
}

/** Tickets linked to worktrees and sessions (settings `devdesk.tickets.*`, see `core/tickets.ts`). */
export interface TicketsConfig {
  enabled: boolean;
  /** `devdesk.tickets.providers`: the providers on (empty: all). */
  providers: string[];
  /** Find a worktree's ticket in its name and branch, and a session's in its first prompt. */
  autoDetect: boolean;
  /** Read titles and statuses (with the providers that can). */
  fetch: boolean;
  /** How long a ticket's title and status are kept before they are read again. */
  refreshMs: number;
  timeoutMs: number;
  includeInPrompt: boolean;
  /** The GitHub CLI (`devdesk.checks.ghPath`). */
  gh: string;
  jira: { baseUrl: string; projects: string[]; command: string };
  linear: { workspace: string; teams: string[] };
  /** `devdesk.tickets.patterns` as set (checked by `validPatterns`). */
  patterns: unknown;
}

const stringList = (key: string): string[] => {
  const v = cfg().get<unknown>(key);
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) : [];
};

/** The `devdesk.tickets.*` settings, with their defaults. */
export function ticketsConfig(): TicketsConfig {
  return {
    enabled: bool('tickets.enabled', true),
    providers: stringList('tickets.providers'),
    autoDetect: bool('tickets.autoDetect', true),
    fetch: bool('tickets.fetch', true),
    refreshMs: numberSetting('tickets.refreshMinutes', 10, 1) * 60_000,
    timeoutMs: numberSetting('tickets.timeoutSeconds', 15, 1, 120) * 1000,
    includeInPrompt: bool('tickets.includeInPrompt', false),
    gh: checksConfig().gh,
    jira: {
      baseUrl: cfg().get<string>('tickets.jira.baseUrl', '').trim(),
      projects: stringList('tickets.jira.projects'),
      command: cfg().get<string>('tickets.jira.command', '').trim(),
    },
    linear: { workspace: cfg().get<string>('tickets.linear.workspace', '').trim(), teams: stringList('tickets.linear.teams') },
    patterns: cfg().get<unknown>('tickets.patterns') ?? [],
  };
}

/** `devdesk.web.*` as VS Code gives them, unchecked: resolveWebSettings() checks and fills them. */
function webSettings(): WebSettings {
  const c = cfg();
  return {
    port: c.get('web.port'),
    auth: c.get('web.auth'),
    identityHeader: c.get('web.identityHeader'),
    allowedUsers: c.get('web.allowedUsers'),
    publicHost: c.get('web.publicHost'),
    tunnelCommand: c.get('web.tunnelCommand'),
    pollMs: c.get('web.pollMs'),
    tunnelName: c.get('web.tunnelName'),
    tunnel: c.get('web.tunnel'),
    cloudflareTeam: c.get('web.cloudflare.team'),
    cloudflareAudience: c.get('web.cloudflare.audience'),
    ngrokProvider: c.get('web.ngrok.oauthProvider'),
    sessionView: c.get('web.sessionView'),
  };
}

/** Start asks which tunnel to use first (needsTunnelChoice) for a window whose root is `root`. */
export function webNeedsTunnelChoice(root: string | undefined = workspaceRoot()): boolean {
  const provider = !!(root && workspaceProvider?.isWorkspace(root) && workspaceProvider.web);
  return needsTunnelChoice(webSettings(), provider);
}

/**
 * The tunnel this window's web access runs, named with `tunnelName` (default: `devdesk.web.tunnelName`), and its URL
 * when it is the workspace kind's own tunnel; undefined when no tunnel runs or its command has no {host}.
 */
export function webTunnelPreview(tunnelName?: string, root: string | undefined = workspaceRoot()): TunnelPreview | undefined {
  const config = webAccessConfig(root);
  const provider = root && workspaceProvider?.isWorkspace(root) ? workspaceProvider.web : undefined;
  const own = !config.tunnel && provider && config.tunnelCommand === provider.tunnelCommand.trim();
  return tunnelPreview({
    command: config.tunnelCommand,
    tunnelName: tunnelName ?? config.tunnelName,
    host: hostname(),
    user: config.user,
    ...(own && provider.tunnelUrl ? { urlTemplate: provider.tunnelUrl } : {}),
  });
}

/** The root as configured and with symlinks resolved (a session's cwd is the real path), as the Claude view scopes it. */
function scopeDirsOf(root: string): string[] {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that is gone scopes by its name.
  }
  return real === root ? [root] : [root, real];
}

/**
 * Everything the web access daemon runs with (`<stateDir>/web-v2/config.json`): the `devdesk.web.*` settings, with the
 * workspace kind's tunnel and identity header when `root` is one of its workspaces, and the sessions settings the
 * Claude view uses, so the phone sees the sessions this window sees. `root` defaults to this window's.
 */
export function webAccessConfig(root: string | undefined = workspaceRoot()): DaemonConfig {
  const user = process.env.USER || userInfo().username;
  const provider = root && workspaceProvider?.isWorkspace(root) ? workspaceProvider.web : undefined;
  const stateDir = sessionsStateDir();
  const { bin = 'tmux', configFile } = sessionsTmuxSetup();
  return {
    version: 1,
    ...resolveWebSettings(webSettings(), { provider, user }),
    user,
    stateDir,
    webDir: webDir(stateDir),
    ...(root ? { root } : {}),
    scopeDirs: root ? scopeDirsOf(root) : [],
    scope: sessionsWorkspaceOnly() ? 'workspace' : 'all',
    showAll: sessionsShowAll(),
    discovery: featureDiscovery(),
    claudeSessionsDirs: claudeSessionsDirs(),
    stuckMs: sessionsStuckMs(),
    hooksQuietMs: sessionsHooksQuietMs(),
    idleMs: sessionsIdleMs(),
    sort: { mode: sessionsSort(), recentMs: sessionsRecentlyFinishedMs(), unreadFirst: sessionsUnreadFirst() },
    insights: insightsEnabled(),
    pasteSettleMs: boardPasteSettleMs(),
    tmux: {
      bin,
      ...(configFile ? { configFile } : {}),
      server: sessionsTmuxServer(),
      options: sessionsTmuxOptions(),
      env: sessionsEnv(bin),
    },
    // The default launch mode and Claude account, as a new session from the Claude view starts.
    claude: {
      ...sessionsLaunch(),
      modes: sessionsModes(),
      defaultMode: sessionsDefaultMode().name,
      models: boardModels(),
      configDir: claudeConfigDir(),
      accounts: claudeAccounts(),
      ambientConfigDir: ambientClaudeConfigDir(),
    },
    finishedSessions: sessionsFinishedSessions(),
  };
}
