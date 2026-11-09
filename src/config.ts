import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { type BesideMode, type CardTitleMode, DEFAULT_LANE_WIDTH, MIN_LANE_WIDTH } from './core/board';
import { parseModels } from './core/composer';
import type { ParkPolicy } from './core/park';
import { DEFAULT_MODE_NAME, joinArgs, type LaunchMode, parseModes, pickMode } from './core/modes';
import { claudeShellCommand, DEFAULT_CLAUDE_PATH, defaultTmuxInstallCommand, isServerName, tmuxOptions, tmuxRunner, type TmuxRunner, type TmuxSetup } from './core/tmux';
import { claudeConfigFilePath } from './core/trust';
import type { WorktreeKind } from './core/worktreeTasks';
import { gitRootFor, isPackageWorkspace, normalizeRoot, workspaceRootFor } from './core/worktrees';
import { workspaceProvider } from './core/workspaceProvider';
import { noteLatency } from './log';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('devdesk');
}

/** Sets a `devdesk.` setting in the user settings. */
export function setGlobalSetting(key: string, value: unknown): Thenable<void> {
  return cfg().update(key, value, vscode.ConfigurationTarget.Global);
}

/** Opens the Settings editor on this extension's settings matching `query` (a settings gear). */
export function openSettings(query: string): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:roniburd.devdesk-claude ${query}`);
}

const expandHome = (p: string | undefined) => p?.trim().replace(/^~(?=\/|$)/, homedir());

/** A number setting: `fallback` when unset or not a number, rounded down when `integer`, then clamped to `[min, max]`. */
function numberSetting(key: string, fallback: number, min: number, max = Infinity, integer = false): number {
  const value = cfg().get<number>(key, fallback);
  const n = Number.isFinite(value) ? (integer ? Math.floor(value) : value) : fallback;
  return Math.min(max, Math.max(min, n));
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

/** Pause the Worktrees view's refresh while the VS Code window is in the background (setting `devdesk.worktrees.pauseWhenUnfocused`). */
export function worktreesPauseWhenUnfocused(): boolean {
  return cfg().get<boolean>('worktrees.pauseWhenUnfocused', true);
}

/** Where devdesk_hook.py writes session state (setting `devdesk.sessions.stateDir`). */
export function sessionsStateDir(): string {
  return expandHome(cfg().get<string>('sessions.stateDir')) || join(homedir(), '.claude', 'devdesk', 'state');
}

/** Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

/** Where Claude Code keeps its transcripts: `projects` in its config directory. */
export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), 'projects');
}

/**
 * Where Claude Code lists its running sessions and their names (setting `devdesk.sessions.claudeSessionsDir`).
 * Empty means `sessions` in Claude's config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).
 */
export function claudeSessionsDir(): string {
  return expandHome(cfg().get<string>('sessions.claudeSessionsDir')) || join(claudeConfigDir(), 'sessions');
}

/**
 * Where Claude Code keeps its background jobs, read for the session each /fork was forked from (setting
 * `devdesk.sessions.claudeJobsDir`). Empty means `jobs` in Claude's config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).
 */
export function claudeJobsDir(): string {
  return expandHome(cfg().get<string>('sessions.claudeJobsDir')) || join(claudeConfigDir(), 'jobs');
}

/** List packages without changes in the Worktrees view (setting `devdesk.worktrees.showCleanPackages`). */
export function worktreesShowCleanPackages(): boolean {
  return cfg().get<boolean>('worktrees.showCleanPackages', false);
}

/** Each worktree row of the Worktrees view lists its Claude sessions above its packages (setting `devdesk.worktrees.showSessions`). */
export function worktreesShowSessions(): boolean {
  return cfg().get<boolean>('worktrees.showSessions', true);
}

/** Load every worktree's changes in the background while the Worktrees view is visible (`devdesk.worktrees.prefetch`). */
export function worktreesPrefetch(): boolean {
  return cfg().get<boolean>('worktrees.prefetch', true);
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
  return cfg().get<boolean>('sessions.notifyWhenWaiting', true);
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
  return expandHome(cfg().get<string>('sessions.tmuxPath')) || 'tmux';
}

/**
 * The tmux binary, and the config file (setting `devdesk.sessions.tmuxConfigFile`, empty: tmux's own) for `server`:
 * the config file only applies to DevDesk's tmux server, never to another server DevDesk merely lists or attaches to.
 */
export function sessionsTmuxSetup(server = sessionsTmuxServer()): TmuxSetup {
  const configFile = server === sessionsTmuxServer() ? expandHome(cfg().get<string>('sessions.tmuxConfigFile')) || undefined : undefined;
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

/** tmux options DevDesk sets on each of its Claude sessions (setting `devdesk.sessions.tmuxOptions`), as name/value pairs. */
export function sessionsTmuxOptions(): [string, string][] {
  return tmuxOptions(cfg().get('sessions.tmuxOptions'));
}

/** Shell command that installs tmux (setting `devdesk.sessions.tmuxInstallCommand`); empty: Homebrew on macOS, else yum. */
export function sessionsTmuxInstallCommand(): string {
  return cfg().get<string>('sessions.tmuxInstallCommand')?.trim() || defaultTmuxInstallCommand(process.platform);
}

/**
 * How DevDesk starts Claude in a new tmux session: `devdesk.claudeCommand` verbatim when set, else
 * `devdesk.sessions.claudePath` (empty: the toolbox Claude) with `devdesk.sessions.claudeArgs`, then a login shell.
 * The launch mode's arguments (the default mode unless `mode` is given), then `extraArgs` (for example a fork's
 * `--resume <id> --fork-session`), follow `claudeArgs`; with a full command they go right after its first word, except a prompt (`-- 'text'`), which goes after the command's own options.
 */
export function sessionsClaudeCommand(extraArgs = '', mode: LaunchMode = sessionsDefaultMode()): string {
  const c = cfg();
  return claudeShellCommand({ command: c.get<string>('sessions.command'), path: claudeBinary(), args: c.get<string>('sessions.claudeArgs') }, joinArgs(mode.args, extraArgs));
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

/** Unread sessions sort above every read one (setting `devdesk.sessions.unreadFirst`); else only within their state. */
export function sessionsUnreadFirst(): boolean {
  return cfg().get<boolean>('sessions.unreadFirst', true);
}

/** The Claude view nests sessions under their worktree; off, it lists every session in one list (setting `devdesk.sessions.groupByWorktree`). */
export function sessionsGroupByWorktree(): boolean {
  return cfg().get<boolean>('sessions.groupByWorktree', false);
}

/** Read session titles are greyed in the Claude view (setting `devdesk.sessions.dimRead`). */
export function sessionsDimRead(): boolean {
  return cfg().get<boolean>('sessions.dimRead', true);
}

/** Unread sessions get a dot badge in the Claude view (setting `devdesk.sessions.unreadBadge`). */
export function sessionsUnreadBadge(): boolean {
  return cfg().get<boolean>('sessions.unreadBadge', true);
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
  return cfg().get<boolean>('sessions.leftArrowOpensSidebar', true);
}

/** Reopen the Claude terminals that were open, attached to their tmux sessions, in a new window (setting `devdesk.sessions.restoreTerminals`). */
export function sessionsRestoreTerminals(): boolean {
  return cfg().get<boolean>('sessions.restoreTerminals', true);
}

/** How many characters of a session's title its terminal's tab shows; 0: the session's name only (setting `devdesk.sessions.tabTitleLength`). */
export function sessionsTabTitleLength(): number {
  return numberSetting('sessions.tabTitleLength', 24, 0, 80, true);
}

/** Environment DevDesk adds to the Claude sessions it starts: without agent view while ← opens the sidebar instead. */
export function sessionsClaudeEnv(): Record<string, string> {
  return sessionsLeftArrowOpensSidebar() ? { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' } : {};
}

/** Show the "needs you" status bar item (setting `devdesk.sessions.statusBar`). */
export function sessionsStatusBar(): boolean {
  return cfg().get<boolean>('sessions.statusBar', true);
}

/** List subagents, background shells and workflows under each session (setting `devdesk.sessions.showChildren`). */
export function sessionsShowChildren(): boolean {
  return cfg().get<boolean>('sessions.showChildren', false);
}

/** Finished children listed per level, older ones folded into one row (setting `devdesk.sessions.finishedChildren`, at least 0). */
export function sessionsFinishedChildren(): number {
  return numberSetting('sessions.finishedChildren', 10, 0, Infinity, true);
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
  return cfg().get<string>('sessions.scope', 'workspace') !== 'all';
}

/** Which Claude sessions the Claude view lists (setting `devdesk.sessions.show`): those on the DevDesk tmux server, or all. */
export function sessionsShowAll(): boolean {
  return cfg().get<string>('sessions.show') === 'all';
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
  return cfg().get<string>('worktrees.createCommand')?.trim() || (workspaceProvider?.defaultCreateCommand ?? '');
}

/** Shell command that deletes a package workspace worktree named `$DEVDESK_WORKTREE` (setting `devdesk.worktrees.deleteCommand`). */
export function worktreesDeleteCommand(): string {
  return cfg().get<string>('worktrees.deleteCommand')?.trim() || (workspaceProvider?.defaultDeleteCommand ?? '');
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
  return cfg().get<boolean>('board.openWhenEmpty', true);
}

/** Open the Claude Board the first time the sidebar shows in a window (setting `devdesk.board.openWithSidebar`). */
export function boardOpenWithSidebar(): boolean {
  return cfg().get<boolean>('board.openWithSidebar', true);
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
  return cfg().get<string>('board.promptPlacement') === 'top' ? 'top' : 'bottom';
}

/** After the composer starts a session: stay on the board (`board`, the default) or open its terminal (setting `devdesk.board.afterStart`). */
export function boardOpensSession(): boolean {
  return cfg().get<string>('board.afterStart') === 'session';
}

/** Whether a session opened from the Claude Board opens beside it (setting `devdesk.board.sessionsBeside`, `auto` by default). */
export function boardSessionsBeside(): BesideMode {
  const v = cfg().get<string>('board.sessionsBeside');
  return v === 'always' || v === 'never' ? v : 'auto';
}

/** Each lane's width (CSS px) when a session opens beside the board (setting `devdesk.board.laneWidth`; at least 180). */
export function boardLaneWidth(): number {
  const v = cfg().get<number>('board.laneWidth', DEFAULT_LANE_WIDTH);
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(MIN_LANE_WIDTH, Math.round(v)) : DEFAULT_LANE_WIDTH;
}

/** Working and Needs you cards show one line on what Claude is doing or asks (setting `devdesk.board.cardLine`, on by default; the board's ☰ button toggles it). */
export function boardCardLine(): boolean {
  return cfg().get<boolean>('board.cardLine', true);
}

/**
 * What a board card's title says (setting `devdesk.board.cardTitle`): `objective` (the default, a prototype), what the
 * whole session sets out to do, with the latest step in small text under it; `latest`, the latest prompt's title.
 */
export function boardCardTitle(): CardTitleMode {
  return cfg().get<string>('board.cardTitle', 'objective') === 'latest' ? 'latest' : 'objective';
}

/** What **Spec** puts before a prompt for later (setting `devdesk.board.specPrompt`); empty: derived (see `specPrefix`). */
export function boardSpecPrompt(): string {
  return cfg().get<string>('board.specPrompt')?.trim() ?? '';
}

/** Where images pasted into the Claude Board's prompt box are saved (setting `devdesk.board.pastedImagesDir`). */
export function boardPastedImagesDir(): string {
  return expandHome(cfg().get<string>('board.pastedImagesDir')) || join(homedir(), '.claude', 'devdesk', 'pasted-images');
}

/**
 * Claude Code's global config file, read (never written) for the folders Claude trusts (setting
 * `devdesk.board.claudeConfigFile`); empty: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
 */
export function boardClaudeConfigFile(): string {
  return expandHome(cfg().get<string>('board.claudeConfigFile')) || claudeConfigFilePath(process.env, homedir());
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

const nonNegative = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

/** The `devdesk.diagnostics.*` settings. */
export function diagnosticsConfig(): DiagnosticsConfig {
  const c = cfg();
  return {
    dir: expandHome(c.get<string>('diagnostics.dir')) || join(homedir(), '.cache', 'devdesk', 'diagnostics'),
    heapSnapshotNearLimit: c.get<boolean>('diagnostics.heapSnapshotNearLimit', true),
    keepDays: nonNegative(c.get<number>('diagnostics.keepDays'), 3),
    heapWarnMB: nonNegative(c.get<number>('diagnostics.heapWarnMB'), 1500),
    heapGrowthWarnMB: nonNegative(c.get<number>('diagnostics.heapGrowthWarnMB'), 300),
    debugLog: c.get<boolean>('diagnostics.debugLog', false),
    slowOperationSeconds: nonNegative(c.get<number>('diagnostics.slowOperationSeconds'), 60),
    latencyOutlierFactor: nonNegative(c.get<number>('diagnostics.latencyOutlierFactor'), 3),
    latencyOutlierMinMs: nonNegative(c.get<number>('diagnostics.latencyOutlierMinMs'), 50),
  };
}

/** DevDesk's Haiku insights on session cards (setting `devdesk.insights.enabled`). */
export function insightsEnabled(): boolean {
  return cfg().get<boolean>('insights.enabled', true);
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
  return cfg().get<string>('insights.model')?.trim() || 'haiku';
}

/**
 * The Claude binary insight calls run, in shell syntax (setting `devdesk.insights.claudePath`): empty means the one
 * sessions run (`devdesk.sessions.claudePath`, else the toolbox Claude), without `devdesk.sessions.claudeArgs`.
 */
export function insightsClaude(): string {
  return expandHome(cfg().get<string>('insights.claudePath')) || claudeBinary() || DEFAULT_CLAUDE_PATH;
}

/** The model the board's ✨ search asks (setting `devdesk.boardSearch.model`; empty: `haiku`). */
export function boardSearchModel(): string {
  return cfg().get<string>('boardSearch.model')?.trim() || 'haiku';
}

/** A program or script (with arguments) that answers the board's ✨ search instead of `claude -p` (setting `devdesk.boardSearch.command`); empty: none. */
export function boardSearchCommand(): string {
  return expandHome(cfg().get<string>('boardSearch.command')) ?? '';
}

/** Whether the board's search also looks through past sessions (setting `devdesk.boardSearch.history`). */
export function boardSearchHistory(): boolean {
  return cfg().get<boolean>('boardSearch.history', true);
}

/** Which past sessions: this workspace's, or every folder's (setting `devdesk.boardSearch.historyScope`). */
export function boardSearchHistoryScope(): 'workspace' | 'all' {
  return cfg().get<string>('boardSearch.historyScope') === 'all' ? 'all' : 'workspace';
}

/** Transcripts not changed for this many days are not searched (setting `devdesk.boardSearch.historyDays`, 1-3650). */
export function boardSearchHistoryDays(): number {
  return numberSetting('boardSearch.historyDays', 90, 1, 3650, true);
}

/** At most this many past sessions, the most recently changed, are indexed (setting `devdesk.boardSearch.historyMaxSessions`, 100-100000). */
export function boardSearchHistoryMaxSessions(): number {
  return numberSetting('boardSearch.historyMaxSessions', 5000, 100, 100_000, true);
}

/** Where Claude keeps its transcripts (setting `devdesk.boardSearch.historyDir`; empty: `projects` in Claude's config directory). */
export function boardSearchHistoryDir(): string {
  return expandHome(cfg().get<string>('boardSearch.historyDir')) || claudeProjectsDir();
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
  return cfg().get<string>('usage.defaultScope') === 'all' ? 'all' : 'project';
}
