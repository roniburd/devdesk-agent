import * as vscode from 'vscode';
import type { DiffMode } from './core/git';
import { featureForCwd } from './core/sessions';
import { LOOK_TEXT, stateLook } from './core/sessionsView';
import type { SessionCard } from './core/sessions';
import { tickLoop } from './core/tickLoop';
import { type SeenCards, sessionSignals } from './core/worktreeSignals';
import { discoverFeatures, type Feature } from './core/worktrees';
import { isClaudeTerminal, killClaude } from './claudeSessions';
import { featureDiscovery, openSettings, sessionsStuckMs, setGlobalSetting, workspaceRoot, worktreesPauseWhenUnfocused, worktreesRefreshSeconds } from './config';
import { type FeatureNode, FeaturesTree, type FileNode } from './featuresTree';
import { GitContentProvider, SCHEME } from './gitContent';
import { log, registerTimedCommand } from './log';
import type { SessionsModel } from './sessionsModel';
import { openFeatureSession } from './sessionsCommands';
import type { SessionsTree } from './sessionsTree';
import { deleteWorktreeRow } from './worktreeDelete';
import { openDiff } from './worktreeDiffs';

/** `workspaceState` key of the Worktrees view's diff base (`branch` or `uncommitted`). */
const MODE_KEY = 'devdesk.mode';

/** Sets `devdesk.inWorkspace`, which shows the Claude and Worktrees views only when a local folder is open (a package workspace, a git repository or a plain folder). */
export function updateWorkspaceContext(): void {
  void vscode.commands.executeCommand('setContext', 'devdesk.inWorkspace', workspaceRoot() !== undefined);
}

/** The Worktrees view and its rows' state text (each worktree's most urgent session's), by worktree directory. */
export interface WorktreesView {
  tree: FeaturesTree;
  urgent: () => ReadonlyMap<string, string>;
}

/**
 * Creates the Worktrees view and registers its commands, its auto-refresh while visible and in front
 * (`devdesk.worktrees.refreshSeconds`, `devdesk.worktrees.pauseWhenUnfocused`) and the diff documents its file rows open.
 */
export function registerWorktreesView(ctx: vscode.ExtensionContext, sessions: SessionsModel, sessionsTree: SessionsTree): WorktreesView {
  let urgent = new Map<string, string>();
  const tree = new FeaturesTree(workspaceRoot, () => urgent, sessionsTree);
  tree.mode = ctx.workspaceState.get<DiffMode>(MODE_KEY, 'branch');
  const view = vscode.window.createTreeView('devdesk.features', { treeDataProvider: tree, showCollapseAll: true });
  const describeMode = () => {
    view.description = tree.mode === 'branch' ? 'vs mainline' : 'uncommitted';
  };
  describeMode();
  const updateUrgent = () => {
    const now = Date.now();
    const next = new Map([...sessionsTree.urgentByWorktree()].map(([dir, c]) => [dir, LOOK_TEXT[stateLook(c, now, sessionsStuckMs())]]));
    if (JSON.stringify([...next]) === JSON.stringify([...urgent])) return;
    urgent = next;
    // Only the worktree rows' state text changed: keep the packages' changes as loaded, without running git again.
    tree.refreshLabels();
  };

  // One refresh at a time: the next starts refreshSeconds after the last one's git work is done, and only while the
  // view is visible and (unless pauseWhenUnfocused is off) the window is in front.
  let paused: boolean | undefined;
  const inFront = () => view.visible && (vscode.window.state.focused || !worktreesPauseWhenUnfocused());
  tree.setActive(inFront);
  const loop = tickLoop({
    intervalMs: () => worktreesRefreshSeconds() * 1000,
    active: () => {
      const active = inFront();
      if (paused !== undefined && paused === active) log.debug(`auto-refresh ${active ? 'resumed' : 'paused'}`);
      paused = !active;
      return active;
    },
    tick: async () => {
      const start = Date.now();
      log.debug('auto-refresh');
      await tree.refreshChanges();
      log.debug(`auto-refresh: done in ${Date.now() - start}ms`);
    },
    onProblem: (message) => log.warn(`Worktrees auto-refresh: ${message}`),
  });

  // What changed, from the Claude sessions (a file a session edits, a turn that ended) and from VS Code (saves, creates,
  // deletes, renames): only those packages load again.
  let seenCards: SeenCards = new Map();
  const onCards = (cards: readonly SessionCard[]) => {
    const signals = sessionSignals(seenCards, cards);
    seenCards = signals.seen;
    tree.setActivity(signals.activity);
    tree.touchPaths(signals.touchedPaths);
    for (const dir of signals.touchedWorktrees) tree.touchWorktree(dir);
  };
  const touchUris = (uris: readonly vscode.Uri[]) => tree.touchPaths(uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath));

  const openSession = (feature: Feature, command: string) => {
    log.info(`${command} ${feature.name}`);
    openFeatureSession(sessions, sessionsTree, feature);
    setTimeout(() => tree.refreshLabels(), 1500);
  };

  ctx.subscriptions.push(
    view,
    view.onDidChangeVisibility(() => loop.update()),
    view.onDidExpandElement((e) => e.element.kind === 'feature' && tree.setExpanded(e.element.feature.dir, true)),
    view.onDidCollapseElement((e) => e.element.kind === 'feature' && tree.setExpanded(e.element.feature.dir, false)),
    sessions.onDidChange(onCards),
    vscode.workspace.onDidSaveTextDocument((doc) => touchUris([doc.uri])),
    vscode.workspace.onDidCreateFiles((e) => touchUris(e.files)),
    vscode.workspace.onDidDeleteFiles((e) => touchUris(e.files)),
    vscode.workspace.onDidRenameFiles((e) => touchUris(e.files.flatMap((f) => [f.oldUri, f.newUri]))),
    vscode.window.onDidChangeWindowState(() => loop.update()),
    sessionsTree.onDidChangeUrgent(updateUrgent),
    sessionsTree.onDidChangeTreeData(() => tree.refreshSessions()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('devdesk.worktrees')) return;
      if (e.affectsConfiguration('devdesk.worktrees.root')) updateWorkspaceContext();
      loop.update();
      // Only another root or kind of worktree changes what is listed. The others (git processes, timers, sessions or
      // clean packages shown) change no package: keep their changes as loaded, so that a sweep isn't started again.
      const affects = (name: string) => e.affectsConfiguration(`devdesk.worktrees.${name}`);
      if (affects('root') || affects('kind')) tree.refresh();
      else if (affects('showSessions') || affects('showCleanPackages')) tree.refreshRows();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      log.info(`workspace folders changed; workspace root ${workspaceRoot() ?? 'none'}`);
      updateWorkspaceContext();
      tree.refresh();
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    registerTimedCommand('devdesk.features.refresh', () => tree.refresh()),
    registerTimedCommand('devdesk.features.showSessions', () => setGlobalSetting('worktrees.showSessions', true)),
    registerTimedCommand('devdesk.features.hideSessions', () => setGlobalSetting('worktrees.showSessions', false)),
    registerTimedCommand('devdesk.features.toggleBase', async () => {
      tree.mode = tree.mode === 'branch' ? 'uncommitted' : 'branch';
      await ctx.workspaceState.update(MODE_KEY, tree.mode);
      describeMode();
      tree.refresh();
    }),
    registerTimedCommand('devdesk.openDiff', (node: FileNode) => openDiff(node)),
    registerTimedCommand('devdesk.claude.open', (node: FeatureNode) => openSession(node.feature, 'claude.open')),
    // For other extensions (DevDesk Personal Stacks): opens, or starts, the Claude session of the worktree at `dir`.
    registerTimedCommand('devdesk.claude.openWorktree', async (dir: unknown) => {
      const root = workspaceRoot();
      const feature = typeof dir === 'string' && root ? featureForCwd(await discoverFeatures(root, featureDiscovery()), dir) : undefined;
      if (!feature) {
        void vscode.window.showInformationMessage(`No worktree of this workspace at ${String(dir)}.`);
        return false;
      }
      openSession(feature, 'claude.openWorktree');
      return true;
    }),
    registerTimedCommand('devdesk.claude.kill', async (node: FeatureNode) => {
      if (await killClaude(node.feature)) tree.refreshLabels();
    }),
    registerTimedCommand('devdesk.worktrees.delete', async (node: FeatureNode | undefined) => {
      if (await deleteWorktreeRow(sessions, node)) tree.refresh();
    }),
    vscode.window.onDidCloseTerminal((t) => {
      if (isClaudeTerminal(t)) tree.refreshLabels();
    }),
    registerTimedCommand('devdesk.features.openSettings', () => openSettings('devdesk.worktrees')),
    loop,
  );
  return { tree, urgent: () => urgent };
}
