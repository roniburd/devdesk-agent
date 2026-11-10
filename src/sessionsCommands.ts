import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { endedDir, removeEndedRecord } from './core/ended';
import { featureForCwd, runningCopy, type SessionCard } from './core/sessions';
import { readRegistry } from './core/sessionInfo';
import { cardView, truncate } from './core/sessionsView';
import { forkArgs, isSessionId, listSessions, nextSessionName, resumeArgs, sessionName } from './core/tmux';
import { discoverFeatures, type Feature } from './core/worktrees';
import { attachSession, endTmuxSession, killTmuxSession, startClaude, startClaudeDetached } from './claudeSessions';
import type { LaunchMode } from './core/modes';
import { claudeSessionsDir, featureDiscovery, openSettings, sessionsClaudeCommand, sessionsDefaultMode, sessionsModes, sessionsStateDir, sessionsTmux, sessionsTmuxServer, workspaceRoot } from './config';
import { log, noteLatency, stepTimer } from './log';
import type { SessionsModel } from './sessionsModel';
import type { SessionNode, SessionsTree } from './sessionsTree';

/** What starting and opening sessions needs of the Claude view (`SessionsTree`): the model, and selecting a session's row. */
export interface SessionRowSelector {
  readonly model: SessionsModel;
  /** Reveals and selects a card's row. */
  select(card: SessionCard): void;
  /** Selects the session's row once the model lists it (it was just started). */
  selectWhenListed(session: string): void;
}

async function runningSessions(): Promise<string[]> {
  return (await listSessions(sessionsTmux())).map((s) => s.name);
}

/** Refreshes the model in a moment, once a session just started or resumed has had time to write its first record. */
function refreshSoon(model: SessionsModel): void {
  setTimeout(() => void model.refresh(), 500);
}

/** The card's title as confirmation dialogs name it. */
function cardLabel(card: SessionCard): string {
  return truncate(cardView(card, Date.now()).title, 60);
}

/**
 * Starts `command` in `dir` in the first free tmux session named after `base`, opens its terminal and selects it;
 * with `open` false, only starts it in the background (the Claude Board, set to stay on the board). Returns the session name.
 * `named` is told the name before the session starts, so a refresh during the start already knows what it is for.
 */
export async function startNumbered(
  model: SessionsModel,
  tree: SessionRowSelector,
  base: string,
  dir: string,
  command?: string,
  open = true,
  named?: (session: string) => void,
): Promise<string> {
  const session = nextSessionName(base, await runningSessions());
  named?.(session);
  log.info(`starting Claude session ${session} in ${dir}${open ? '' : ' (in the background)'}`);
  if (open) {
    tree.selectWhenListed(session);
    await startClaude(session, dir, command);
  } else await startClaudeDetached(session, dir, command);
  refreshSoon(model);
  return session;
}

/** The worktree's own session (`cc-<feature>`): its terminal, starting Claude there if it is not running. */
export function openFeatureSession(model: SessionsModel, tree: SessionRowSelector, feature: Feature): void {
  const session = sessionName(feature);
  tree.selectWhenListed(session);
  void startClaude(session, feature.dir);
  refreshSoon(model);
}

/**
 * + : another Claude in main (the workspace root), in the first free `cc-main[-<n>]`; no folder to pick. Runs in
 * the default mode (`devdesk.sessions.defaultMode`) unless `mode` is given (New Session with Mode…).
 */
export async function newSession(model: SessionsModel, tree: SessionRowSelector, mode = sessionsDefaultMode()): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showInformationMessage('Open a folder to start a Claude session.');
    return;
  }
  await startNumbered(model, tree, sessionName({ name: 'main', dir: root, isMain: true }), root, sessionsClaudeCommand('', mode));
}

/**
 * Fork: a copy of the conversation (`claude --resume <id> --fork-session`) in the folder the session is in now, in a
 * new tmux session named after that folder's worktree, in the default mode unless `mode` is given. The original
 * session is untouched.
 */
export async function forkSession(model: SessionsModel, tree: SessionRowSelector, card: SessionCard, mode = sessionsDefaultMode()): Promise<void> {
  if (!isSessionId(card.sessionId) || !card.cwd) {
    void vscode.window.showInformationMessage('This session has no Claude status record yet, so it cannot be forked.');
    return;
  }
  const root = workspaceRoot();
  const feature = root ? featureForCwd(await discoverFeatures(root, featureDiscovery()), card.cwd) : undefined;
  const base = feature ? sessionName(feature) : 'cc-fork';
  await startNumbered(model, tree, base, card.cwd, sessionsClaudeCommand(forkArgs(card.sessionId), mode));
}

const LAST_CUSTOM_KEY = 'devdesk.sessions.lastCustomArgs';

type ModeItem = vscode.QuickPickItem & { mode?: LaunchMode; action?: 'custom' | 'settings' };

/**
 * Asks for a launch mode: the configured modes (the default one marked), the last custom arguments, **Custom…** (type
 * any Claude arguments) and **Configure modes…**. Undefined when cancelled.
 */
export async function pickLaunchMode(state: vscode.Memento, title: string): Promise<LaunchMode | undefined> {
  const fallback = sessionsDefaultMode();
  const lastCustom = state.get<string>(LAST_CUSTOM_KEY, '');
  const items: ModeItem[] = sessionsModes().map((mode) => ({
    label: mode.name,
    description: [mode.name === fallback.name ? '(default)' : '', mode.args || 'no extra arguments'].filter(Boolean).join(' '),
    detail: mode.description,
    mode,
  }));
  if (lastCustom) items.push({ label: 'Custom (last used)', description: lastCustom, mode: { name: 'Custom', args: lastCustom } });
  items.push(
    { label: 'Custom…', description: 'type Claude arguments, for example --model opus --effort max', action: 'custom' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(gear) Configure modes…', action: 'settings' },
  );
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'How should Claude start?', matchOnDescription: true });
  if (!pick) return undefined;
  if (pick.action === 'settings') {
    await openSettings('devdesk.sessions.modes');
    return undefined;
  }
  if (pick.action === 'custom') {
    const args = await vscode.window.showInputBox({
      title,
      prompt: 'Claude Code arguments, in shell syntax; they go after devdesk.sessions.claudeArgs',
      value: lastCustom,
      placeHolder: '--model opus --permission-mode plan --effort high',
    });
    if (args === undefined) return undefined;
    await state.update(LAST_CUSTOM_KEY, args.trim());
    return { name: 'Custom', args: args.trim() };
  }
  return pick.mode;
}

/**
 * Resumes a parked session (`claude --resume <id>`, same session id) and opens its terminal: in its tmux pane when
 * Claude exited to a shell there, else in a new tmux session named after its worktree.
 */
async function resumeSession(model: SessionsModel, tree: SessionRowSelector, card: SessionCard): Promise<void> {
  if (!isSessionId(card.sessionId) || !card.cwd) {
    void vscode.window.showInformationMessage('DevDesk does not know which conversation this session had, so it cannot resume it.');
    return;
  }
  if (!existsSync(card.cwd)) {
    void vscode.window.showWarningMessage(`Cannot resume this Claude session: its folder ${card.cwd} is gone. Fork it from another folder, or remove it.`);
    return;
  }
  // Opened again (a second click, or the board and the Claude view) while it resumes: one Claude per conversation.
  const id = card.sessionId;
  if (resuming.has(id)) {
    log.info(`already resuming Claude session ${id}`);
    return;
  }
  resuming.add(id);
  try {
    await resumeOnce(model, tree, card, id, card.cwd);
  } finally {
    // Until the next refresh lists it running, which `runningCopy` then finds.
    setTimeout(() => resuming.delete(id), RESUME_SETTLE_MS);
  }
}

/** Conversations being resumed now, by session id. */
const resuming = new Set<string>();
/** How long a resume counts as in flight after it started Claude: until a refresh lists the session running. */
const RESUME_SETTLE_MS = 5_000;

async function resumeOnce(model: SessionsModel, tree: SessionRowSelector, card: SessionCard, sessionId: string, cwd: string): Promise<void> {
  // The card may predate a resume from another window, or a copy started some other way: open that one instead.
  const registry = await readRegistry(claudeSessionsDir()).catch(() => []);
  let copy = runningCopy(model.current, registry, sessionId);
  // A Claude on it that the cards do not show yet (started a moment ago): look again once a refresh lists it.
  if (copy === 'elsewhere') copy = runningCopy(await model.fresh(), registry, sessionId);
  if (copy === 'elsewhere') {
    void vscode.window.showInformationMessage(
      `This Claude conversation is already running outside DevDesk's tmux sessions, so DevDesk does not resume it again. Fork it to continue it here as a copy.`,
    );
    return;
  }
  if (copy) {
    log.info(`Claude session ${sessionId} already runs in tmux session ${copy.tmuxSession}: opening it instead of resuming it again`);
    return openTerminal(tree, copy);
  }
  const command = sessionsClaudeCommand(resumeArgs(sessionId));
  log.info(`resuming parked Claude session ${sessionId} in ${cwd}`);
  if (card.tmuxSession && card.tmuxPane) {
    try {
      // The pane runs only the shell Claude exited to: run Claude there again, so an open terminal on it follows.
      await sessionsTmux(card.tmuxServer)(['respawn-pane', '-k', '-t', card.tmuxPane, '-c', cwd, command]);
      await openTerminal(tree, card);
      refreshSoon(model);
      return;
    } catch (err) {
      log.warn(`cannot resume ${sessionId} in tmux pane ${card.tmuxPane}: ${(err as Error).message}; starting a new tmux session`);
    }
  }
  // DevDesk parked it: back in the tmux session it had, if still free, so its terminal tab keeps its name.
  const former = card.formerTmuxSession;
  if (former?.startsWith('cc-') && card.formerTmuxServer === sessionsTmuxServer() && !(await runningSessions()).includes(former)) {
    log.info(`resuming ${sessionId} in its former tmux session ${former}`);
    tree.selectWhenListed(former);
    await startClaude(former, cwd, command);
    refreshSoon(model);
    return;
  }
  const feature = model.featureList.find((f) => f.dir === card.featureDir);
  await startNumbered(model, tree, feature ? sessionName(feature) : 'cc-resumed', cwd, command);
}

/** Opens (or focuses) the session's Claude terminal in the editor area and selects its row; resumes a parked session. */
export async function openSessionCard(tree: SessionRowSelector, card: SessionCard): Promise<void> {
  if (card.state === 'parked') return resumeSession(tree.model, tree, card);
  return openTerminal(tree, card);
}

/** Shows the session's terminal (attaching one to its tmux session if none is open) and selects its row. */
async function openTerminal(tree: SessionRowSelector, card: SessionCard): Promise<void> {
  const steps = stepTimer();
  tree.select(card);
  steps.mark('select row');
  if (!card.tmuxSession) {
    void vscode.window.showInformationMessage(
      `This Claude session runs outside tmux (${card.cwd ?? 'unknown folder'}), so DevDesk cannot open its terminal. Fork it to continue it here.`,
    );
    return;
  }
  const terminal = await attachSession(card.tmuxSession, card.tmuxPane, card.tmuxServer);
  steps.mark('attach');
  // Opened from the Claude view (Enter or a click): the tree keeps focus, and showing a terminal tab that is already in
  // front does not move it, so focus the editor group the tab is in.
  terminal.show(false);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  steps.mark('show');
  log.debug(`open ${card.tmuxSession}: ${steps.total()}ms (${steps.describe()})`);
  noteLatency('open session terminal', steps.total());
}

/**
 * Removes a parked session from the list (and the shell its tmux session was left with, if any). The conversation stays
 * on disk until Claude Code cleans it up, so `claude --resume <id>` still finds it.
 */
export async function removeParked(model: SessionsModel, card: SessionCard): Promise<void> {
  if (card.state !== 'parked' || !card.sessionId) return;
  const label = cardLabel(card);
  const choice = await vscode.window.showWarningMessage(
    `Remove "${label}" from the list?`,
    { modal: true, detail: `It is not running. Its conversation stays on disk: claude --resume ${card.sessionId}` },
    'Remove',
  );
  if (choice !== 'Remove') return;
  await removeEndedRecord(endedDir(sessionsStateDir()), card.sessionId);
  if (card.tmuxSession) await endTmuxSession(card.tmuxSession, card.tmuxServer).catch(() => undefined);
  await model.refresh();
}

/** Asks, then ends a running session's tmux session; removes a parked one from the list instead. */
export async function killSession(model: SessionsModel, card: SessionCard): Promise<void> {
  if (card.state === 'parked') return removeParked(model, card);
  if (!card.tmuxSession) return;
  if (await killTmuxSession(card.tmuxSession, card.tmuxServer, cardLabel(card))) await model.refresh();
}

/** Opens the most urgent session needing input. */
export async function openNextWaiting(tree: SessionsTree): Promise<void> {
  const card = tree.state.cards.find((c) => c.state === 'waiting');
  if (card) await openSessionCard(tree, card);
  else void vscode.window.showInformationMessage('No Claude session needs input.');
}

/**
 * Opens a subagent's transcript, a background shell's output or a workflow's summary (the file a child row names),
 * scrolled to the end, where the latest output is.
 */
export async function openChildFile(file: unknown): Promise<void> {
  if (typeof file !== 'string' || !isAbsolute(file)) return;
  try {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (err) {
    void vscode.window.showWarningMessage(`Cannot open ${file}: ${(err as Error).message}`);
  }
}

/**
 * Tree commands get the clicked row; the Claude Board's card menu gets the card's `data-vscode-context`
 * (`{ sessionId }`); the command palette gets nothing (then the selected row is used).
 */
export function cardOf(model: SessionsModel, tree: SessionsTree, arg: unknown): SessionCard | undefined {
  const boardId = (arg as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof boardId === 'string') return model.find(boardId);
  const node = tree.clickedOrSelected(arg);
  return node?.kind === 'session' ? model.find(node.card.id) ?? node.card : undefined;
}

/**
 * The sessions a command acts on: every selected session row when the clicked row is part of a multi-selection (tree
 * commands get the clicked row and the selected rows), else the one `cardOf` finds.
 */
export function cardsOf(model: SessionsModel, tree: SessionsTree, arg: unknown, selected: unknown): SessionCard[] {
  if (Array.isArray(selected) && selected.length > 1 && selected.includes(arg)) {
    const cards = new Map<string, SessionCard>();
    for (const node of selected as SessionNode[]) {
      if (node?.kind === 'session' && !cards.has(node.card.id)) cards.set(node.card.id, model.find(node.card.id) ?? node.card);
    }
    return [...cards.values()];
  }
  const card = cardOf(model, tree, arg);
  return card ? [card] : [];
}
