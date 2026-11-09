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
      return { label, description: item.description, tooltip, icon, contextValue: item.contextValue, unread: node.kind === 'session' && sessionsTree.unreadIds.has(node.card.id), expanded, command: item.command, children };
    });
  return {
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
    unreadIds: () => [...sessionsTree.unreadIds],
    /** The Claude view's session nodes, as a right-click on a multi-selection passes them to a command. */
    claudeSessionNodes: () =>
      sessionsTree
        .getChildren()
        .flatMap((node) => (node.kind === 'worktree' ? sessionsTree.getChildren(node) : [node]))
        .filter((node) => node.kind === 'session'),
    /** The Claude view's top-level rows (worktree groups, with their sessions as children). */
    claudeGroups: () => claudeRows(sessionsTree.getChildren()),
    /** This host's saved read state (`[session id, signature][]`), as the next window loads it. */
    savedSeenEntries: () => ctx.globalState.get<[string, string][]>(hostKey(SEEN_KEY)) ?? [],
    /** The ids of the sessions whose read state is saved for the next window. */
    savedSeen: () => (ctx.globalState.get<[string, string][]>(hostKey(SEEN_KEY)) ?? []).map(([id]) => id),
    /**
     * Saves a session as read the way another window of this VS Code would (`globalState` is shared by all of them),
     * on top of `stale` when given: what that window had before this one's last change reached it.
     */
    saveSeenAsOtherWindow: (id: string, signature: string, stale?: [string, string][]) =>
      ctx.globalState.update(hostKey(SEEN_KEY), [...(stale ?? ctx.globalState.get<[string, string][]>(hostKey(SEEN_KEY)) ?? []), [id, signature]]),
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
    savedClaudeTerminals: () => (ctx.workspaceState.get<[string, OpenTerminal][]>(REATTACH_KEY) ?? []).map(([, o]) => o.session),
    /** Saves a Claude terminal to reattach the way another window on this folder would (`workspaceState` is shared). */
    saveClaudeTerminalAsOtherWindow: (session: string) => {
      const open = { session, server: sessionsTmuxServer() };
      return ctx.workspaceState.update(REATTACH_KEY, [...(ctx.workspaceState.get<[string, OpenTerminal][]>(REATTACH_KEY) ?? []), [reattachKey(open), open]]);
    },
    /** Makes the next Worktrees load run git again. */
    refreshWorktrees: () => tree.refresh(),
    /** What the Worktrees view's timer does: run git again under the rows as listed, and look for new worktrees in the background. */
    refreshWorktreeChanges: () => tree.refreshChanges(),
    /** How many Worktrees root loads waited for the worktrees to be listed. */
    worktreeRootDiscoveries: () => tree.rootDiscoveries,
    /** How many Worktrees package loads ran git so far. */
    worktreeGitLoads: () => tree.gitLoads,
    /** Whether the Claude Board's tab is open, and what it shows. */
    boardOpen: () => board.isOpen,
    /** How many times the board's webview loaded (a hidden board keeps its webview, so showing it again loads none). */
    boardWebviewLoads: () => board.webviewLoads,
    /** How many times the board was told to focus its prompt box. */
    boardPromptEnters: () => board.promptEnters,
    /** The next showing of the Claude view opens the board again (`devdesk.board.openWithSidebar`). */
    boardForgetSidebarShown: () => board.forgetSidebarShown(),
    boardData: () => board.data(),
    /** The last ✨ search answer the board posted. */
    boardSearchResult: () => board.lastSearchResult,
    /** How far the board's history index is, a refresh of it now, and the last history results the board posted. */
    boardHistoryStatus: () => board.historyStatus(),
    boardHistoryRefresh: () => board.forceHistoryRefresh(),
    boardHistoryResults: () => board.lastHistoryResults,
    /** The board composer's choices, and a message as if its webview sent it. */
    boardComposer: () => board.composerInfo(),
    boardMessage: (m: unknown) => board.receive(m),
    /** What the board's prompt box keeps for this project folder (as posted to a webview that loads), and the file of its prompts for later. */
    boardKept: () => board.keptState(),
    boardBacklogFile: () => board.backlogFile,
    boardForgetKept: () => board.forgetKept(),
    /**
     * The prompt box messages (notice, setChoice, openPicker, clearBox, composed) posted since the last call and the
     * shown notice's action ids (click one with `boardMessage({ type: 'noticeAction', id })`), and what a submitted text
     * is classified as.
     */
    boardUi: () => board.takeUiMessages(),
    boardClassify: (text: string, where?: string) => board.classify(text, where),
    /** The `/` menu's rows for a query (`stacked`: after other commands; `kind: '@'`: the file menu's). */
    boardComplete: (query: string, options?: { where?: string; stacked?: boolean; kind?: '/' | '@' }) => board.complete(query, options),
    boardMakeRoomBeside: () => board.makeRoomBeside(),
    /** What the board's 📊 popover shows, for the window's scope or `scope`. */
    boardUsage: (scope?: UsageScope) => board.usage(scope),
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
