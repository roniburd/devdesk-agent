import * as vscode from 'vscode';
import type { SessionCard } from './core/sessions';
import { colorCommand, SESSION_COLORS } from './core/sessionColors';
import { cardView } from './core/sessionsView';
import { findByTmux, installTmux, registerTerminalRestore, type TerminalTitles } from './claudeSessions';
import { openSettings, sessionsNotifyWhenWaiting, sessionsTmuxServer, setGlobalSetting } from './config';
import { hooksStatus, installHooksCommand, removeHooksCommand } from './hooksCommands';
import type { InsightsWorker } from './insightsWorker';
import { registerLeftArrow } from './leftArrow';
import { registerTimedCommand } from './log';
import type { SessionsModel } from './sessionsModel';
import {
  cardOf,
  cardsOf,
  forkSession,
  killSession,
  newSession,
  openChildFile,
  openNextWaiting,
  openSessionCard,
  pickLaunchMode,
  removeParked,
} from './sessionsCommands';
import type { SessionsTree } from './sessionsTree';
import { newSessionInWorktree, newWorktreeSession, type WorktreeTaskStore } from './worktreeSessions';

/** What the Claude view's commands act on. */
export interface SessionsParts {
  sessions: SessionsModel;
  sessionsTree: SessionsTree;
  worktreeTasks: WorktreeTaskStore;
  insights: InsightsWorker;
}

/** After the hooks were installed or removed: the hooks row and the sessions' status may have changed. */
async function hooksChanged({ sessions, sessionsTree }: SessionsParts): Promise<void> {
  sessionsTree.refreshHooks();
  await sessions.refresh();
}

/** After `devdesk.sessions.stateDir` changes, installed DevDesk hooks still write to the old directory until reinstalled. */
async function offerHookReinstall(parts: SessionsParts): Promise<void> {
  if ((await hooksStatus()) !== 'outdated') return;
  const choice = await vscode.window.showInformationMessage('Claude status hooks write to the old state directory.', 'Reinstall hooks');
  if (choice === 'Reinstall hooks' && (await installHooksCommand())) await hooksChanged(parts);
}

/**
 * Registers the Claude view's commands, the "needs input" notifications (`devdesk.sessions.notifyWhenWaiting`), the
 * ← key in Claude terminals and the restore of Claude terminals in a new window, and applies `devdesk.sessions.*` and
 * `devdesk.insights.*` changes.
 */
export function registerSessions(ctx: vscode.ExtensionContext, parts: SessionsParts): void {
  const { sessions, sessionsTree, worktreeTasks, insights } = parts;

  let notifying = false;
  const syncNotify = () => {
    const want = sessionsNotifyWhenWaiting();
    if (want && !notifying) sessions.acquire();
    if (!want && notifying) sessions.release();
    notifying = want;
  };
  syncNotify();

  /** A command on a session: the clicked row, the board card's, or the selected row (see `cardOf`). */
  const onCard =
    (run: (card: SessionCard) => unknown) =>
    (arg: unknown): unknown => {
      const card = cardOf(sessions, sessionsTree, arg);
      return card ? run(card) : undefined;
    };
  /** A command on every selected session (a right-click on a multi-selection), else as `onCard`. */
  const onCards =
    (run: (card: SessionCard) => unknown) =>
    (arg: unknown, selected: unknown): void => {
      for (const card of cardsOf(sessions, sessionsTree, arg, selected)) run(card);
    };

  ctx.subscriptions.push(
    insights,
    sessions.onDidChange((cards) => insights.update(cards)),
    sessions.onDidStartWaiting((cards) => {
      if (!notifying) return;
      for (const c of cards) {
        const v = cardView(c, Date.now(), sessionsTmuxServer());
        void vscode.window.showInformationMessage(`Claude (${v.worktree}) needs input: ${v.detail}`, 'Open').then((choice) => {
          if (choice === 'Open') void openSessionCard(sessionsTree, c);
        });
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devdesk.sessions')) {
        syncNotify();
        sessions.restart();
        sessionsTree.syncAcquire();
        void sessions.refresh();
        sessionsTree.refreshHooks();
      }
      if (e.affectsConfiguration('devdesk.sessions.stateDir')) void offerHookReinstall(parts);
      if (e.affectsConfiguration('devdesk.insights')) {
        void sessions.refresh();
        insights.update(sessions.current);
      }
    }),
    registerTimedCommand('devdesk.sessions.open', () => vscode.commands.executeCommand('devdesk.sessions.focus')),
    registerTimedCommand('devdesk.sessions.new', () => newSession(sessions, sessionsTree)),
    registerTimedCommand('devdesk.sessions.newWorktree', (task: unknown) => newWorktreeSession(sessions, sessionsTree, worktreeTasks, task)),
    registerTimedCommand('devdesk.sessions.newInWorktree', (arg: unknown) => newSessionInWorktree(sessions, sessionsTree, arg)),
    registerTimedCommand('devdesk.sessions.newWithMode', async () => {
      const mode = await pickLaunchMode(ctx.globalState, 'New Claude Session');
      if (mode) await newSession(sessions, sessionsTree, mode);
    }),
    registerTimedCommand(
      'devdesk.sessions.forkWithMode',
      onCard(async (c) => {
        const mode = await pickLaunchMode(ctx.globalState, 'Fork Claude Session');
        if (mode) await forkSession(sessions, sessionsTree, c, mode);
      }),
    ),
    registerTimedCommand('devdesk.sessions.openCard', onCard((c) => openSessionCard(sessionsTree, c))),
    registerTimedCommand('devdesk.sessions.fork', onCard((c) => forkSession(sessions, sessionsTree, c))),
    registerTimedCommand('devdesk.sessions.kill', onCard((c) => killSession(sessions, c))),
    registerTimedCommand('devdesk.sessions.remove', onCard((c) => removeParked(sessions, c))),
    registerTimedCommand('devdesk.sessions.markRead', onCards((c) => sessionsTree.state.setRead(c.id, true))),
    registerTimedCommand('devdesk.sessions.markUnread', onCards((c) => sessionsTree.state.setRead(c.id, false))),
    // The Color submenu of a session row's and a board card's right-click menu: one command per color, and No Color.
    // The current color's row (`<color>.current`, titled with a ✓) gives the same color.
    ...[...SESSION_COLORS.map((c) => c.id), undefined].flatMap((color) =>
      (color ? [colorCommand(color), `${colorCommand(color)}.current`] : [colorCommand(color)]).map((command) =>
        registerTimedCommand(command, (arg: unknown, selected: unknown) => sessionsTree.state.setColor(cardsOf(sessions, sessionsTree, arg, selected).map((c) => c.id), color)),
      ),
    ),
    registerTimedCommand('devdesk.sessions.nextWaiting', () => openNextWaiting(sessionsTree)),
    registerTimedCommand('devdesk.sessions.openChild', (file: unknown) => openChildFile(file)),
    ...registerLeftArrow(sessionsTree),
    ...registerTerminalRestore(ctx.workspaceState, terminalTitles(sessions)),
    registerTimedCommand('devdesk.sessions.openSettings', () => openSettings('devdesk.sessions')),
    registerTimedCommand('devdesk.sessions.installTmux', installTmux),
    registerTimedCommand('devdesk.sessions.installHooks', async () => {
      if (await installHooksCommand()) await hooksChanged(parts);
    }),
    registerTimedCommand('devdesk.sessions.removeHooks', async () => {
      if (await removeHooksCommand()) await hooksChanged(parts);
    }),
    registerTimedCommand('devdesk.sessions.listAll', () => setGlobalSetting('sessions.groupByWorktree', false)),
    registerTimedCommand('devdesk.sessions.groupByWorktree', () => setGlobalSetting('sessions.groupByWorktree', true)),
  );
}

/** Claude terminals' tab titles: their sessions' board titles. */
function terminalTitles(sessions: SessionsModel): TerminalTitles {
  return {
    title: (session, server) => {
      const card = findByTmux(sessions.current, session, server);
      return card && cardView(card, Date.now()).title;
    },
    loaded: () => (sessions.isLoaded ? Promise.resolve() : sessions.fresh()),
    onDidChange: sessions.onDidChange,
  };
}
