import type { SharedMemento } from './state/sharedMemento';
import * as vscode from 'vscode';
import type { BoardPanel } from './boardPanel';
import type { CliBridge } from './devdeskCli';
import type { WorkerHub } from './workers';
import type { ReviewComments } from './reviewComments';
import type { WorktreeChecks } from './worktreeChecks';
import { claudeTerminalSession, restoreTerminals } from './claudeSessions';
import { type OpenTerminal, REATTACH_KEY, reattachKey } from './state/reattachTerminals';
import { sessionsTmuxServer } from './config';
import { claudeTerminalActive } from './leftArrow';
import { SEEN_KEY } from './sessionsReadState';
import type { SessionNode, SessionsTree } from './sessionsTree';
import { hostKey } from './state/mementoState';
import type { UsageScope } from './core/usageScope';
import { planLimits } from './planLimits';
import { startNotice } from './edition';
import type { UsagePanel } from './usagePanel';
import type { UsageScopeState } from './usageScopeState';
import type { WorktreesView } from './worktreesView';

/** A Claude view row as the e2e tests see it. */
interface ClaudeRow {
  label?: string;
  description?: string | boolean;
  /** Markdown source when the tooltip is a MarkdownString. */
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  unread: boolean;
  expanded: boolean;
  command?: vscode.Command;
  children: ClaudeRow[];
}

/** What the extension's views show, and hooks to drive them, for the e2e tests (the value `activate` returns). */
export function testApi(
  ctx: vscode.ExtensionContext,
  {
    sessionsTree,
    worktrees,
    board,
    usagePanel,
    usageScope,
    cli,
    review,
    checks,
    workers,
    globalState,
    projectState,
  }: {
    sessionsTree: SessionsTree;
    worktrees: WorktreesView;
    board: BoardPanel;
    usagePanel: UsagePanel;
    usageScope: UsageScopeState;
    cli: CliBridge;
    review: ReviewComments;
    checks: WorktreeChecks;
    workers: WorkerHub;
    globalState: SharedMemento;
    projectState: SharedMemento;
  },
) {
  const tree = worktrees.tree;
  /** How many times the usage scope changed: each time, the 📊 popup and the Claude Usage page are posted again. */
  let usageScopeChanges = 0;
  ctx.subscriptions.push(usageScope.onDidChange(() => usageScopeChanges++));
  const claudeRows = (nodes: SessionNode[]): ClaudeRow[] =>
    nodes.map((node) => {
      const item = sessionsTree.getTreeItem(node);
      const label = typeof item.label === 'string' ? item.label : item.label?.label;
      const icon = item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
      const children = item.collapsibleState ? claudeRows(sessionsTree.getChildren(node)) : [];
      const expanded = item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded;
      const tooltip = item.tooltip instanceof vscode.MarkdownString ? item.tooltip.value : item.tooltip;
      return { label, description: item.description, tooltip, icon, contextValue: item.contextValue, unread: node.kind === 'session' && sessionsTree.state.unreadIds.has(node.card.id), expanded, command: item.command, children };
    });
  return {
    /** What v2 told the user when it started (v1 enabled too, or its views missing), if anything. */
    editionNotice: startNotice,
    /** A Claude view session row's decoration (read state and color), with its theme color's id. */
    sessionDecoration: (id: string) => {
      const d = sessionsTree.provideFileDecoration(vscode.Uri.from({ scheme: 'devdesk-session', path: `/${id}` }));
      return d && { badge: d.badge, tooltip: d.tooltip, color: d.color instanceof vscode.ThemeColor ? d.color.id : undefined };
    },
    /** The Claude view's session rows (and the hooks row) as VS Code renders them, out of their worktree groups. */
    claudeRows: () => claudeRows(sessionsTree.getChildren().flatMap((node) => (node.kind === 'worktree' ? sessionsTree.getChildren(node) : [node]))),
    /** Starts moving the focus to the Claude view (as ← does) without waiting: says whether that has settled yet. */
    startClaudeViewFocus: () => {
      let settled = false;
      void sessionsTree.focus().finally(() => (settled = true));
      return () => settled;
    },
    /** The session of the Claude view's selected row, if any. */
    selectedSessionId: () => sessionsTree.selectedSessionId(),
    /** The ids of the sessions the Claude view shows as unread. */
    unreadIds: () => [...sessionsTree.state.unreadIds],
    /** The Claude view's session nodes, as a right-click on a multi-selection passes them to a command. */
    claudeSessionNodes: () =>
      sessionsTree
        .getChildren()
        .flatMap((node) => (node.kind === 'worktree' ? sessionsTree.getChildren(node) : [node]))
        .filter((node) => node.kind === 'session'),
    /** The Claude view's top-level rows (worktree groups, with their sessions as children). */
    claudeGroups: () => claudeRows(sessionsTree.getChildren()),
    /** This host's saved read state (`[session id, signature][]`), as the next window loads it. */
    /** The files of the state both DevDesk Claude versions share (`core/sharedState.ts`): this host's, this folder's. */
    sharedStateFiles: () => ({ global: globalState.file, project: projectState.file }),
    savedSeenEntries: () => globalState.get<[string, string][]>(hostKey(SEEN_KEY)) ?? [],
    /** The ids of the sessions whose read state is saved for the next window. */
    savedSeen: () => (globalState.get<[string, string][]>(hostKey(SEEN_KEY)) ?? []).map(([id]) => id),
    /**
     * Saves a session as read the way another window of this VS Code would (`globalState` is shared by all of them),
     * on top of `stale` when given: what that window had before this one's last change reached it.
     */
    saveSeenAsOtherWindow: (id: string, signature: string, stale?: [string, string][]) =>
      globalState.update(hostKey(SEEN_KEY), [...(stale ?? globalState.get<[string, string][]>(hostKey(SEEN_KEY)) ?? []), [id, signature]]),
    worktreeState: () => Object.fromEntries(worktrees.urgent()),
    /** Each Worktrees row (main and the worktrees) with its children's labels and descriptions. */
    worktreeRows: async () => {
      // Rows show what was last loaded while their packages load again: list them once those loads are done.
      for (const node of await tree.getChildren()) await tree.getChildren(node);
      await tree.loadsDone();
      return Promise.all(
        (await tree.getChildren()).map(async (node) => ({
          label: tree.getTreeItem(node).label,
          children: (await tree.getChildren(node)).map((child) => {
            const item = tree.getTreeItem(child);
            return { label: item.label, description: item.description, ...(item.contextValue ? { contextValue: item.contextValue } : {}) };
          }),
        })),
      );
    },
    /** The Worktrees view's selected rows' labels, and whether the view is visible. */
    worktreesSelection: () => ({ visible: worktrees.view.visible, labels: worktrees.view.selection.map((n) => tree.getTreeItem(n).label) }),
    /** The Worktrees rows alone (nothing expanded), with their descriptions. */
    worktreeRoots: async () =>
      (await tree.getChildren()).map((node) => {
        const item = tree.getTreeItem(node);
        return { label: item.label, description: item.description, contextValue: item.contextValue };
      }),
    /** The tmux session a terminal is attached to, when it is one of DevDesk's Claude terminals (their names are titles). */
    claudeTerminalSession: (terminal: vscode.Terminal) => claudeTerminalSession(terminal),
    /** What a new window would do with these Claude terminals (sessions on DevDesk's tmux server). */
    restoreClaudeTerminals: (sessions: string[]) => restoreTerminals(sessions.map((session) => ({ session, server: sessionsTmuxServer() }))),
    /** The tmux sessions of the Claude terminals saved for the next window to reattach, by this window and the others. */
    savedClaudeTerminals: () => (projectState.get<[string, OpenTerminal][]>(REATTACH_KEY) ?? []).map(([, o]) => o.session),
    /** Saves a Claude terminal to reattach the way another window on this folder would (`workspaceState` is shared). */
    saveClaudeTerminalAsOtherWindow: (session: string) => {
      const open = { session, server: sessionsTmuxServer() };
      return projectState.update(REATTACH_KEY, [...(projectState.get<[string, OpenTerminal][]>(REATTACH_KEY) ?? []), [reattachKey(open), open]]);
    },
    /** Makes the next Worktrees load run git again. */
    refreshWorktrees: () => tree.refresh(),
    /** What the Worktrees view's timer does: run git again under the rows as listed, and look for new worktrees in the background. */
    refreshWorktreeChanges: () => tree.refreshChanges(),
    /** How many Worktrees root loads waited for the worktrees to be listed. */
    worktreeRootDiscoveries: () => tree.rootDiscoveries,
    /** How many Worktrees package loads ran git so far. */
    worktreeGitLoads: () => tree.gitLoads,
    ...board.testHooks(),
    /** The 📊 popup's plan limits now (from DevDesk's status line), or its offer to install that. */
    boardPlanLimits: () => planLimits(),
    /** Whether the Claude Usage page is open, and what it shows (for the window's scope or `scope`). */
    usagePageOpen: () => usagePanel.isOpen,
    usagePage: (scope?: UsageScope) => usagePanel.data(scope),
    /** The window's usage scope, choosing one (as the popover's selects do), and forgetting the choice. */
    usageScope: () => usageScope.get(),
    setUsageScope: (scope: UsageScope) => usageScope.set(scope),
    clearUsageScope: () => usageScope.clear(),
    usageScopeChanges: () => usageScopeChanges,
    /** Whether the Claude view is showing. */
    sessionsViewVisible: () => sessionsTree.visible,
    claudeTerminalActive,
    /** The card of the Claude terminal in front, as ← finds it. */
    focusedCard: () => sessionsTree.state.focusedCard(),
    /** The `devdesk` command's path, and how many of its requests this window has handled. */
    cliCommand: () => cli.command,
    cliHandled: () => cli.handled,
    /** Notices and replies the worker hub has typed into sessions so far. */
    workersTyped: () => workers.typed,
    /** Adds a note for Claude on lines `start`-`end` (0-based) of `file` in the worktree at `featureDir`, as the diff's comment box does. */
    addReviewNote: (file: string, featureDir: string, start: number, end: number, text: string) =>
      review.addAt(vscode.Uri.file(file), featureDir, new vscode.Range(start, 0, end, 0), text),
    /** Notes for Claude not sent yet, by worktree directory. */
    reviewNoteCounts: () => Object.fromEntries(review.counts()),
    /** Fetches the checks of the worktrees the Worktrees view lists, as its refresh tick does when they are due (but now). */
    refreshChecks: async () => {
      for (const f of tree.listedFeatures()) await checks.fetch(f);
    },
    /** Each worktree's checks hint, by directory (only those with one). */
    checksHints: () => checks.hints(),
    /** How many times checks were fetched. */
    checksFetches: () => checks.fetches,
    /** The prompt Ask Claude to Fix Checks would send for the worktree at `dir` (or why it would send none). */
    checksFixRequest: async (dir: string) => {
      const f = tree.listedFeatures().find((x) => x.dir === dir);
      return f ? checks.fixRequest(f) : { message: `no worktree at ${dir}` };
    },
  };
}
