import * as vscode from 'vscode';
import { claudePromptIsEmpty } from './core/claudePrompt';
import { programStatusBusy, readCardProgramStatus } from './core/programStatus';
import { processAlive } from './core/sessions';
import { skipShellUpdate } from './core/skipShell';
import { claudeTerminalOfTab, claudeTerminalSession, isClaudeTerminal } from './claudeSessions';
import { programStatusDir, sessionsLeftArrowOpensSidebar, sessionsTmux } from './config';
import { log, registerTimedCommand } from './log';
import type { SessionsTree } from './sessionsTree';

/** The command DevDesk binds to ← in its Claude terminals. */
const LEFT_ARROW_COMMAND = 'devdesk.sessions.leftArrow';
/** Context key: the active terminal is one of DevDesk's Claude terminals. */
const CONTEXT = 'devdesk.claudeTerminalActive';
/** What a terminal sends for ←; tmux reads it as Left whatever cursor-key mode its pane is in. */
const LEFT = '\x1b[D';


/**
 * The terminal ← is pressed in: VS Code's active one, else the active editor tab's. Moving a terminal's tab to another
 * editor group leaves `activeTerminal` undefined while that terminal keeps the focus.
 */
function terminalInFront(): vscode.Terminal | undefined {
  const active = vscode.window.activeTerminal;
  if (active) return active;
  const terminal = claudeTerminalOfTab(vscode.window.tabGroups.activeTabGroup.activeTab);
  return terminal?.exitStatus === undefined ? terminal : undefined;
}

/**
 * ← in a DevDesk Claude terminal: on an empty prompt, focuses the Claude view (on the session's row) where Claude would
 * open its agent view; otherwise passes ← on to Claude.
 */
async function leftArrow(tree: SessionsTree): Promise<void> {
  const terminal = terminalInFront();
  if (!terminal) return;
  const target = claudeTerminalSession(terminal);
  const card = tree.focusedCard(terminal);
  let empty = false;
  if (target) {
    try {
      // Claude's own report (Program Status relay) shows a turn or a dialog without reading the screen; only the screen
      // shows whether text is typed.
      const status = card?.tmuxSession === target.session ? await readCardProgramStatus(programStatusDir(), card, processAlive) : undefined;
      // The session's current pane is the one its attached client shows.
      empty = !programStatusBusy(status) && claudePromptIsEmpty(await sessionsTmux(target.server)(['capture-pane', '-p', '-e', '-t', `=${target.session}:`]));
    } catch (err) {
      log.debug(`cannot read the prompt of ${target.session}: ${(err as Error).message}`);
    }
  }
  if (empty) await tree.focus(card);
  else terminal.sendText(LEFT, false);
}

/**
 * VS Code hands keys pressed in a terminal to the shell unless their command is in
 * `terminal.integrated.commandsToSkipShell`: adds DevDesk's ← command there while the feature is on, and removes it
 * when the user turns it off (`turnedOff`), without fighting windows of other folders (`skipShellUpdate`).
 */
async function syncSkipShell(turnedOff = false): Promise<void> {
  const config = vscode.workspace.getConfiguration('terminal.integrated');
  const current = config.inspect<string[]>('commandsToSkipShell')?.globalValue ?? [];
  const next = skipShellUpdate(current, LEFT_ARROW_COMMAND, sessionsLeftArrowOpensSidebar(), turnedOff);
  if (!next) return;
  try {
    await config.update('commandsToSkipShell', next.length ? next : undefined, vscode.ConfigurationTarget.Global);
  } catch (err) {
    log.warn(`cannot update terminal.integrated.commandsToSkipShell: ${(err as Error).message}`);
  }
}

/** The value of the `devdesk.claudeTerminalActive` context key. */
let inFront = false;

/** One of DevDesk's Claude terminals is in front, so ← in it goes through DevDesk (for tests). */
export const claudeTerminalActive = (): boolean => inFront;

export function registerLeftArrow(tree: SessionsTree): vscode.Disposable[] {
  const syncContext = () => {
    inFront = isClaudeTerminal(terminalInFront());
    void vscode.commands.executeCommand('setContext', CONTEXT, inFront);
  };
  syncContext();
  void syncSkipShell();
  return [
    vscode.window.onDidChangeActiveTerminal(syncContext),
    // Without an active terminal, the active tab decides.
    vscode.window.tabGroups.onDidChangeTabs(syncContext),
    vscode.window.tabGroups.onDidChangeTabGroups(syncContext),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devdesk.sessions.leftArrowOpensSidebar')) void syncSkipShell(!sessionsLeftArrowOpensSidebar());
      // Another window (of a folder where the setting is off) removed the entry: add it back if this one wants it.
      else if (e.affectsConfiguration('terminal.integrated.commandsToSkipShell')) void syncSkipShell();
    }),
    registerTimedCommand(LEFT_ARROW_COMMAND, () => leftArrow(tree)),
  ];
}
