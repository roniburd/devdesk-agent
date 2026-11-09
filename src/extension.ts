import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import * as vscode from 'vscode';
import { refreshHookScript } from './core/hooks';
import { refreshStatusLineScript } from './core/statusLine';
import { installStatusLineCommand, removeStatusLineCommand } from './statusLineCommands';
import { cardView } from './core/sessionsView';
import {
  claudeConfigDir,
  claudeJobsDir,
  claudeSessionsDir,
  diagnosticsConfig,
  featureDiscovery,
  insightsClaude,
  insightsEnabled,
  insightsMaxConcurrent,
  insightsModel,
  insightsRefreshMs,
  MIGRATED_SETTINGS,
  sessionsFinishedChildren,
  sessionsParkBelowFreePercent,
  sessionsParkPolicy,
  sessionsPollMs,
  sessionsShowAll,
  sessionsWorkspaceOnly,
  sessionsShowChildren,
  sessionsStateDir,
  sessionsTmux,
  sessionsTmuxServer,
  workspaceRoot,
} from './config';
import { BacklogStore } from './backlogStore';
import { backlogItemBelongs } from './core/board';
import { BoardPanel } from './boardPanel';
import { CliBridge, registerCliCommands } from './devdeskCli';
import { ReviewComments } from './reviewComments';
import { InsightsWorker } from './insightsWorker';
import { applyCrashDiagnostics, cleanDiagnosticsRegularly, log, registerTimedCommand, watchEventLoop } from './log';
import { freeMemoryPercent } from './memory';
import { migrateSetting } from './migrate';
import { SessionsModel } from './sessionsModel';
import { registerSessions } from './sessionsRegistration';
import { SessionsTree } from './sessionsTree';
import { testApi } from './testApi';
import { UsagePanel } from './usagePanel';
import { UsageScopeState } from './usageScopeState';
import { UsageService } from './usageService';
import { WorktreeTaskStore } from './worktreeSessions';
import { registerWorktreesView, updateWorkspaceContext } from './worktreesView';

export async function activate(ctx: vscode.ExtensionContext) {
  for (const [from, to] of MIGRATED_SETTINGS) await migrateSetting(from, to);
  updateWorkspaceContext();
  const sessions = new SessionsModel({
    stateDir: sessionsStateDir,
    root: workspaceRoot,
    pollMs: sessionsPollMs,
    tmuxServer: sessionsTmuxServer,
    showAll: sessionsShowAll,
    workspaceOnly: sessionsWorkspaceOnly,
    finishedChildren: () => (sessionsShowChildren() ? sessionsFinishedChildren() : undefined),
    discovery: featureDiscovery,
    claudeSessionsDir,
    tmux: sessionsTmux,
    claudeJobsDir,
    parkPolicy: sessionsParkPolicy,
    parkBelowFreePercent: sessionsParkBelowFreePercent,
    freeMemoryPercent,
    insights: insightsEnabled,
  });
  const insights = new InsightsWorker({
    stateDir: sessionsStateDir,
    enabled: insightsEnabled,
    refreshMs: insightsRefreshMs,
    maxConcurrent: insightsMaxConcurrent,
    model: insightsModel,
    claude: insightsClaude,
  });
  const worktreeTasks = new WorktreeTaskStore(join(ctx.globalStorageUri.fsPath, 'worktree-tasks.json'));
  void worktreeTasks.load();
  const sessionsTree = new SessionsTree(sessions, worktreeTasks, ctx.globalState);
  sessions.setReadCheck((card) => sessionsTree.isRead(card));
  // Prompts for later belong to the project folder (`storageUri`); a window with no folder uses the host-wide file,
  // which every project used before: a project folder opening takes its prompts (and those that name no project) from it.
  const hostBacklog = join(ctx.globalStorageUri.fsPath, 'backlog.json');
  const backlog = new BacklogStore(ctx.storageUri ? join(ctx.storageUri.fsPath, 'backlog.json') : hostBacklog);
  void backlog
    .load()
    .then(async () => {
      if (!ctx.storageUri) return;
      const root = workspaceRoot();
      const dirs = new Set((await sessions.loadFeatures().catch(() => [])).map((f) => f.dir));
      const ours = (dir: string) => dirs.has(dir) || (!!root && (dir === root || dir.startsWith(root + sep)));
      const moved = await backlog.adopt(hostBacklog, (item) => backlogItemBelongs(item, ours, existsSync));
      if (moved) log.info(`moved ${moved} prompts for later from ${hostBacklog} to this project folder's ${backlog.file}`);
    })
    .catch((err: Error) => log.warn(`cannot move the prompts for later from ${hostBacklog}: ${err.message}`));
  // Token usage for the board's 📊 and the Claude Usage page, named by the sessions the Claude view knows.
  const usage = new UsageService(
    () => new Map(sessions.current.filter((c) => c.sessionId).map((c) => [c.sessionId!, cardView(c, Date.now()).title])),
    vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'usageWorker.js').fsPath,
  );
  // The project (or worktree) whose usage this window's 📊 popup and Claude Usage page show.
  const usageScope = new UsageScopeState(ctx.workspaceState);
  const usagePanel = new UsagePanel(ctx.extensionUri, usage, usageScope);
  const board = new BoardPanel(ctx.extensionUri, sessions, sessionsTree, backlog, worktreeTasks, ctx.globalState, ctx.workspaceState, usage, usageScope);
  ctx.subscriptions.push(log, sessions, sessionsTree, worktreeTasks, backlog, board, usagePanel, usage, usageScope);
  const worktrees = registerWorktreesView(ctx, sessions, sessionsTree);
  registerSessions(ctx, { sessions, sessionsTree, worktreeTasks, insights });
  // The `devdesk` command Claude runs to open files and diffs here, and notes left on diff lines for Claude.
  const cli = new CliBridge(sessions, () => worktrees.tree.mode);
  const review = new ReviewComments(ctx.workspaceState, sessions, sessionsTree);
  ctx.subscriptions.push(cli, review, ...registerCliCommands(cli));

  log.info(`activated; workspace root ${workspaceRoot() ?? 'none'}`);
  board.openIfEmpty();
  // A sidebar already showing when the window started was not opened by the user: only a later showing opens the board.
  ctx.subscriptions.push(sessionsTree.onDidChangeVisibility((e) => e.visible && board.sidebarShown()));
  applyCrashDiagnostics(diagnosticsConfig());
  // An upgraded extension brings an upgraded hook script; running sessions pick it up on their next hook event.
  void refreshHookScript(claudeConfigDir()).then(
    (changed) => changed && log.info('updated the Claude status hook script'),
    (err) => log.warn(`cannot update the Claude status hook script: ${(err as Error).message}`),
  );
  void refreshStatusLineScript(claudeConfigDir()).then(
    (changed) => changed && log.info("updated DevDesk's Claude status line script"),
    (err) => log.warn(`cannot update DevDesk's Claude status line script: ${(err as Error).message}`),
  );
  ctx.subscriptions.push(
    watchEventLoop(() => worktrees.tree.treeItemCalls, diagnosticsConfig),
    cleanDiagnosticsRegularly(diagnosticsConfig),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devdesk.diagnostics')) applyCrashDiagnostics(diagnosticsConfig());
      if (e.affectsConfiguration('devdesk.usage')) {
        // Prunes the history to the new limits now, not at the next count.
        void usage.snapshot().catch((err: Error) => log.warn(`cannot prune the usage history: ${err.message}`));
        usagePanel.refresh();
      }
    }),
    vscode.commands.registerCommand('devdesk.board.open', () => board.open()),
    vscode.commands.registerCommand('devdesk.board.openFromEditorTitle', () => board.open()),
    registerTimedCommand('devdesk.board.focusPrompt', () => board.focusPrompt()),
    // The → command before devdesk.board.focusPrompt, for keybindings that still name it.
    registerTimedCommand('devdesk.board.fromSidebar', () => board.focusPrompt()),
    vscode.commands.registerCommand('devdesk.board.addTask', (arg: unknown) => board.addTask(arg)),
    vscode.commands.registerCommand('devdesk.claude.showUsage', () => usagePanel.open()),
    registerTimedCommand('devdesk.usage.installStatusLine', installStatusLineCommand),
    registerTimedCommand('devdesk.usage.removeStatusLine', removeStatusLineCommand),
    vscode.commands.registerCommand('devdesk.sessions.diagnostics', async () => {
      // The extension's log folder: on the machine running it (the remote machine over Remote-SSH), next to the DevDesk log.
      const dir = ctx.logUri.fsPath;
      const file = join(dir, `claude-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify({ tree: sessionsTree.diagnostics(), board: board.data() }, null, 2));
      log.info(`Claude session diagnostics written to ${file}`);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      return file;
    }),
  );
  return testApi(ctx, { sessionsTree, worktrees, board, usagePanel, usageScope, cli, review });
}

export function deactivate(): void {}
