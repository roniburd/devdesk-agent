import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { joinArgs, type LaunchMode } from './core/modes';
import { runCommand } from './core/shellRun';
import { sessionName } from './core/tmux';
import {
  failureSummary,
  parseWorktreeTasks,
  renderStartPrompt,
  serializeWorktreeTasks,
  type WorktreeGroup,
  type WorktreeKind,
  type WorktreeTask,
  type WorktreeTasks,
  withWorktreeTask,
  worktreeSlug,
} from './core/worktreeTasks';
import { prefillArg, promptArg } from './core/shell';
import { discoverFeatures, isGitWorkspace, isPlainFolder, type PackageRepo } from './core/worktrees';
import { workspaceProvider } from './core/workspaceProvider';
import { sessionsClaudeCommand, sessionsWorktreeCreateCommand, sessionsWorktreeKind, sessionsWorktreeStartPrompt, workspaceRoot } from './config';
import { log } from './log';
import { JsonFileStore } from './state/jsonFileStore';
import type { SessionsModel } from './sessionsModel';
import { startNumbered, type SessionRowSelector } from './sessionsCommands';
import type { SessionsTree } from './sessionsTree';

/** A package workspace's worktree command can take a while (it may set up its packages); give up after this. */
const CREATE_TIMEOUT_MS = 15 * 60_000;

/**
 * What each worktree started from the Claude view is for, in `worktree-tasks.json` in the extension's storage. Every
 * window shares the file through a `JsonFileStore` (a save is made on what is in the file now, under a lock, and another
 * window's save reloads it here).
 */
export class WorktreeTaskStore implements vscode.Disposable {
  private readonly store: JsonFileStore<WorktreeTasks>;
  readonly onDidChange: vscode.Event<void>;

  constructor(file: string) {
    this.store = new JsonFileStore(file, { empty: () => ({}), parse: parseWorktreeTasks, serialize: serializeWorktreeTasks, label: 'the worktree tasks' });
    this.onDidChange = this.store.onDidChange;
  }

  all(): WorktreeTasks {
    return this.store.value;
  }

  load(): Promise<void> {
    return this.store.load();
  }

  /** Adds `task`, dropping records of worktrees that are gone. */
  async save(task: WorktreeTask): Promise<void> {
    await this.store.update((tasks) => withWorktreeTask(tasks, task, Date.now(), existsSync));
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** Runs `devdesk.worktrees.createCommand` for `worktree` in `root`; true when `<root>/worktrees/<worktree>` exists afterwards. */
async function createWorkspaceWorktree(root: string, worktree: string, dir: string, failed?: (message: string) => void): Promise<boolean> {
  const command = sessionsWorktreeCreateCommand();
  log.info(`creating worktree ${worktree}: ${command}`);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating worktree ${worktree}…` },
    () => runCommand('/bin/sh', ['-c', command], { cwd: root, env: { DEVDESK_WORKTREE: worktree }, timeoutMs: CREATE_TIMEOUT_MS }),
  );
  if (result.output.trim()) log.info(`worktree ${worktree}: ${result.output.trim()}`);
  if (!result.ok) {
    const message = `Could not create worktree ${worktree}: ${failureSummary(result.output) || 'the command failed'}`;
    failed?.(message);
    void vscode.window.showErrorMessage(`${message} (full output in the DevDesk log)`);
    return false;
  }
  if (!existsSync(dir)) {
    const message = `The worktree command finished, but ${dir} does not exist. Check devdesk.worktrees.createCommand.`;
    failed?.(message);
    void vscode.window.showErrorMessage(message);
    return false;
  }
  return true;
}

/**
 * Makes the Claude Code worktree `<repo>/.claude/worktrees/<worktree>` on a new branch `worktree-<worktree>` (as
 * `claude --worktree` names it) from `base`, for a worktree that must start from a given commit. True when made.
 */
async function createGitWorktree(repo: string, worktree: string, dir: string, base: string, failed?: (message: string) => void): Promise<boolean> {
  log.info(`creating worktree ${worktree} from ${base} in ${repo}`);
  const result = await runCommand('git', ['worktree', 'add', '-b', `worktree-${worktree}`, dir, base], { cwd: repo, timeoutMs: CREATE_TIMEOUT_MS });
  if (result.output.trim()) log.info(`worktree ${worktree}: ${result.output.trim()}`);
  if (result.ok && existsSync(dir)) return true;
  const message = `Could not create worktree ${worktree} from ${base}: ${failureSummary(result.output) || 'git worktree add failed'}`;
  failed?.(message);
  void vscode.window.showErrorMessage(message);
  return false;
}

/** The package a Claude Code worktree is made in: the only one, or the one picked. */
async function pickPackage(packages: readonly PackageRepo[]): Promise<PackageRepo | undefined> {
  if (packages.length <= 1) {
    if (!packages.length) void vscode.window.showInformationMessage('No git package under src/ to make a Claude Code worktree in.');
    return packages[0];
  }
  const picked = await vscode.window.showQuickPick(
    packages.map((pkg) => ({ label: pkg.name, description: pkg.dir, pkg })),
    { title: 'New Worktree Session', placeHolder: 'Package to make the Claude Code worktree in' },
  );
  return picked?.pkg;
}

/** Why no worktree can be made in `root` (a plain folder: neither a package workspace nor a git repository), or empty. */
export function noWorktreesReason(root: string | undefined): string {
  const needs = workspaceProvider ? `a ${workspaceProvider.label} workspace or git repository` : 'a git repository';
  return root && isPlainFolder(root) ? `Worktree sessions need ${needs}, and ${root} is not one: start the session in main instead.` : '';
}

/** The kind of worktree New Worktree Session makes in `root`: a git repository's are Claude Code worktrees of it. */
function newWorktreeKind(root: string): WorktreeKind {
  return isGitWorkspace(root) ? 'claude' : sessionsWorktreeKind();
}

/**
 * Where New Worktree Session starts Claude in `root`, as far as known before it runs: the package of a Claude Code
 * worktree when there is one package to make it in (`packages`, the workspace's), else the workspace root (with
 * several, the package is picked only at launch; a workspace's own worktree is made inside the root).
 */
export function newWorktreeLaunchDir(root: string, packages: readonly PackageRepo[]): string {
  return newWorktreeKind(root) === 'claude' && packages.length === 1 ? packages[0].dir : root;
}

/** How the Claude Board's composer starts a worktree session (New Worktree Session itself uses none of these). */
export interface WorktreeLaunch {
  /** What the worktree is named after, instead of the task. */
  name?: string;
  /** Claude's first prompt as is, instead of `devdesk.worktrees.startPrompt` filled in with the task. */
  prompt?: string;
  /** The prompt is typed at Claude's prompt, not sent (`--prefill`), as a draft to edit there. */
  draft?: boolean;
  /** The launch mode, instead of the default one. */
  mode?: LaunchMode;
  /** More Claude arguments (`--model`, `--effort`), in shell syntax. */
  extraArgs?: string;
  /** Open its terminal (the default), or only start it in the background. */
  open?: boolean;
  /** Told the tmux session's name just before Claude starts in it. */
  started?: (session: string) => void;
  /**
   * Asked with the folder Claude starts in (a package for a Claude Code worktree) just before it starts: true when
   * Claude will ask to trust it, so the terminal opens whatever `open` says.
   */
  untrusted?: (launchDir: string) => Promise<boolean>;
  /** The package a Claude Code worktree is made in, when the workspace has several (instead of asking). */
  packageDir?: string;
  /** The commit the worktree starts from (Claude Code worktrees only; `claude --worktree` picks its own otherwise). */
  base?: string;
  /** Told where the worktree is, once made. */
  created?: (worktree: { name: string; dir: string }) => void;
  /** Told why the worktree or session could not be started (a notification says it too). */
  failed?: (message: string) => void;
}

/**
 * New Worktree Session: asks what you are working on (or takes it as `arg`), makes a worktree named after it, records
 * the task, and starts Claude there with the task as its first prompt. True when the session was started.
 */
export async function newWorktreeSession(
  model: SessionsModel,
  tree: SessionRowSelector,
  store: WorktreeTaskStore,
  arg?: unknown,
  launch: WorktreeLaunch = {},
): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showInformationMessage('Open a folder to start a worktree session.');
    return false;
  }
  const noWorktrees = noWorktreesReason(root);
  if (noWorktrees) {
    void vscode.window.showInformationMessage(noWorktrees);
    return false;
  }
  const typed =
    typeof arg === 'string'
      ? arg
      : await vscode.window.showInputBox({
          title: 'New Worktree Session',
          prompt: 'What are you working on? The worktree is named after it, and Claude starts on it.',
          placeHolder: 'Fix the login timeout',
          ignoreFocusOut: true,
        });
  const task = typed?.trim();
  if (!task) return false;
  const kind = newWorktreeKind(root);
  // Both kinds of worktree, so a new name never matches an existing worktree of either kind.
  const features = await discoverFeatures(root, { claudeWorktrees: true });
  const packages = features[0].packages;
  const given = launch.packageDir ? packages.find((p) => p.dir === launch.packageDir) : undefined;
  const pkg = kind === 'claude' ? (given ?? (await pickPackage(packages))) : undefined;
  if (kind === 'claude' && !pkg) {
    launch.failed?.('no package to make a Claude Code worktree in');
    return false;
  }
  if (launch.base && kind !== 'claude') {
    const message = `a base commit (${launch.base}) works only for git worktrees, not for ${workspaceProvider?.label ?? 'workspace'} worktrees`;
    launch.failed?.(message);
    void vscode.window.showErrorMessage(`Could not start the worktree session: ${message}.`);
    return false;
  }
  const worktree = worktreeSlug(launch.name?.trim() || task, [...features.map((f) => f.name), ...Object.values(store.all()).map((t) => t.worktree)]);

  let dir: string;
  let launchDir: string;
  let extraArgs = '';
  if (pkg && launch.base) {
    dir = join(pkg.dir, '.claude', 'worktrees', worktree);
    launchDir = dir;
    if (!(await createGitWorktree(pkg.dir, worktree, dir, launch.base, launch.failed))) return false;
  } else if (pkg) {
    dir = join(pkg.dir, '.claude', 'worktrees', worktree);
    launchDir = pkg.dir;
    extraArgs = `--worktree ${worktree}`;
  } else {
    dir = join(root, 'worktrees', worktree);
    launchDir = dir;
    if (!(await createWorkspaceWorktree(root, worktree, dir, launch.failed))) return false;
  }
  launch.created?.({ name: worktree, dir });
  try {
    await store.save({ task, worktree, kind, dir, createdAt: Date.now() });
  } catch (err) {
    log.warn(`cannot record the task of worktree ${worktree}: ${(err as Error).message}`);
  }
  model.rediscover();
  const prompt = launch.prompt ?? renderStartPrompt(sessionsWorktreeStartPrompt(), { task, worktree, dir });
  const args = joinArgs(extraArgs, launch.extraArgs, launch.draft ? prefillArg(prompt) : promptArg(prompt));
  const open = (await launch.untrusted?.(launchDir)) || (launch.open ?? true);
  await startNumbered(model, tree, sessionName({ name: worktree, dir, isMain: false }), launchDir, sessionsClaudeCommand(args, launch.mode), open, launch.started);
  return true;
}

/** + on a worktree row: another plain Claude session in that worktree. */
export async function newSessionInWorktree(model: SessionsModel, tree: SessionsTree, arg: unknown): Promise<void> {
  const node = tree.clickedOrSelected(arg);
  const group: WorktreeGroup | undefined = node?.kind === 'worktree' ? node.group : undefined;
  if (!group?.dir) return;
  await startNumbered(model, tree, sessionName({ name: group.name, dir: group.dir, isMain: group.isMain }), group.dir);
}
