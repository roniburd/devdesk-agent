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
  claudeConfigDirs,
  claudeJobsDir,
  claudeSessionsDirs,
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
  sessionsHooksQuietMs,
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
import { sharedStorageDir } from './core/edition';
import { isSharedGlobalKey, isSharedProjectKey, SHARED_STATE_FILE } from './core/sharedState';
import { SharedMemento } from './state/sharedMemento';
import { registerEdition } from './edition';
import { ReviewComments } from './reviewComments';
import { InsightsWorker } from './insightsWorker';
import { applyCrashDiagnostics, cleanDiagnosticsRegularly, log, registerTimedCommand, watchEventLoop } from './log';
import { freeMemoryPercent } from './memory';
import { migrateSetting } from './migrate';
import { SessionsModel } from './sessionsModel';
import { registerSessions } from './sessionsRegistration';
import { SessionsTree } from './sessionsTree';
import { SessionViewState } from './sessionViewState';
import { testApi } from './testApi';
import { TicketLinks } from './ticketLinks';
import { UsagePanel } from './usagePanel';
import { UsageScopeState } from './usageScopeState';
import { UsageService } from './usageService';
import { WorktreeTaskStore } from './worktreeSessions';
import { WorktreeChecks } from './worktreeChecks';
import { WorkerHub } from './workers';
import { registerWorktreesView, updateWorkspaceContext } from './worktreesView';

export async function activate(ctx: vscode.ExtensionContext) {
  // v1's storage folders, which both versions share (see core/edition.ts).
  const globalStorage = sharedStorageDir(ctx.globalStorageUri.fsPath);
  const projectStorage = ctx.storageUri && sharedStorageDir(ctx.storageUri.fsPath);
  // The state both versions keep (read state, colors, terminals to reattach, the board's draft): see core/sharedState.ts.
  const globalState = new SharedMemento(ctx.globalState, join(globalStorage, SHARED_STATE_FILE), isSharedGlobalKey, "this host's shared DevDesk Claude state");
  const projectState = new SharedMemento(
    ctx.workspaceState,
    projectStorage && join(projectStorage, SHARED_STATE_FILE),
    isSharedProjectKey,
    "this project folder's shared DevDesk Claude state",
  );
  ctx.subscriptions.push(globalState, projectState);
  // Copied in even when stepping aside: what this version saved shows in v1 too.
  await Promise.all([globalState.load(ctx.extension.id), projectState.load(ctx.extension.id)]);
  if (await registerEdition(ctx)) return undefined;
  for (const [from, to] of MIGRATED_SETTINGS) await migrateSetting(from, to);
  updateWorkspaceContext();
  const sessions = new SessionsModel({
    stateDir: sessionsStateDir,
    root: workspaceRoot,
    pollMs: sessionsPollMs,
    hooksQuietMs: sessionsHooksQuietMs,
    tmuxServer: sessionsTmuxServer,
    showAll: sessionsShowAll,
    workspaceOnly: sessionsWorkspaceOnly,
    finishedChildren: () => (sessionsShowChildren() ? sessionsFinishedChildren() : undefined),
    discovery: featureDiscovery,
    claudeSessionsDir: claudeSessionsDirs,
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
    readInsight: (id) => sessions.insight(id),
    transcriptSize: (path) => sessions.transcriptSize(path),
  });
  const worktreeTasks = new WorktreeTaskStore(join(globalStorage, 'worktree-tasks.json'));
  void worktreeTasks.load();
  const viewState = new SessionViewState(sessions, globalState);
  const sessionsTree = new SessionsTree(sessions, worktreeTasks, viewState);
  sessions.setReadCheck((card) => viewState.isRead(card));
  // Prompts for later belong to the project folder (`storageUri`); a window with no folder uses the host-wide file,
  // which every project used before: a project folder opening takes its prompts (and those that name no project) from it.
  const hostBacklog = join(globalStorage, 'backlog.json');
  const backlog = new BacklogStore(projectStorage ? join(projectStorage, 'backlog.json') : hostBacklog);
  void backlog
    .load()
    .then(async () => {
      if (!projectStorage) return;
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
  const usageScope = new UsageScopeState(projectState);
  const usagePanel = new UsagePanel(ctx.extensionUri, usage, usageScope);
  const board = new BoardPanel(ctx.extensionUri, sessions, sessionsTree, viewState, backlog, worktreeTasks, globalState, projectState, usage, usageScope);
  ctx.subscriptions.push(log, sessions, sessionsTree, viewState, worktreeTasks, backlog, board, usagePanel, usage, usageScope);
  const worktrees = registerWorktreesView(ctx, sessions, sessionsTree);
  registerSessions(ctx, { sessions, sessionsTree, worktreeTasks, insights, projectState });
  // The `devdesk` command Claude runs to open files and diffs here, and notes left on diff lines for Claude.
  const cli = new CliBridge(sessions, () => worktrees.tree.mode);
  const review = new ReviewComments(ctx.workspaceState, sessions, sessionsTree);
  // The worktrees' pull request checks: a hint on their rows and cards, and Ask Claude to Fix Checks (sent as notes are).
  const checks = new WorktreeChecks(review, () => sessions.loadFeatures());
  worktrees.setChecks(checks);
  board.setChecks(checks);
  // Coordinator and worker sessions (`devdesk worker`): starts workers, keeps their mailboxes, tells coordinators.
  const workers = new WorkerHub(sessions, sessionsTree, worktreeTasks, () => cli.command);
  cli.workers = workers;
  // Tickets linked to worktrees and sessions: chips on their rows and cards, kept in the state both versions share.
  const tickets = new TicketLinks(globalState, sessions);
  worktrees.setTickets(tickets);
  board.setTickets(tickets);
  cli.tickets = tickets;
  ctx.subscriptions.push(cli, review, checks, workers, tickets, ...registerCliCommands(cli));

  log.info(`activated; workspace root ${workspaceRoot() ?? 'none'}`);
  board.openIfEmpty();
  // A sidebar already showing when the window started was not opened by the user: only a later showing opens the board.
  ctx.subscriptions.push(sessionsTree.onDidChangeVisibility((e) => e.visible && board.sidebarShown()));
  applyCrashDiagnostics(diagnosticsConfig());
  // An upgraded extension brings an upgraded hook script; running sessions pick it up on their next hook event. Each
  // Claude account (devdesk.claude.accounts) has its own copy, in its config directory.
  for (const dir of claudeConfigDirs()) {
    void refreshHookScript(dir).then(
      (changed) => changed && log.info(`updated the Claude status hook script in ${dir}`),
      (err) => log.warn(`cannot update the Claude status hook script in ${dir}: ${(err as Error).message}`),
    );
    void refreshStatusLineScript(dir).then(
      (changed) => changed && log.info(`updated DevDesk's Claude status line script in ${dir}`),
      (err) => log.warn(`cannot update DevDesk's Claude status line script in ${dir}: ${(err as Error).message}`),
    );
  }
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
      await writeFile(file, JSON.stringify({ tree: viewState.diagnostics(), board: board.data() }, null, 2));
      log.info(`Claude session diagnostics written to ${file}`);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      return file;
    }),
  );
  return testApi(ctx, { sessionsTree, worktrees, board, usagePanel, usageScope, cli, review, checks, workers, tickets, globalState, projectState });
}

export function deactivate(): void {}
