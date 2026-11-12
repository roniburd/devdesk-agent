import * as vscode from 'vscode';
import { readPromptScreen, typeIntoPane } from '../core/paneScreen';
import type { SessionCard } from '../core/sessions';
import { currentCard, NEW_SESSION, type PromptScreen, runningSessions, sessionEnded, sessionPicks } from '../core/sessionSend';
import { paneTarget } from '../core/tmux';
import { sessionsTmux, sessionsTmuxServer } from '../config';
import { cardServer } from '../claudeSessions';
import type { SessionsModel } from '../sessionsModel';
import { openSessionCard, type SessionRowSelector } from '../sessionsCommands';

/**
 * The running sessions as the board's prompt box reaches them (`composer.sessions`): which one a command goes to, whether
 * Claude waits at an empty prompt in it, typing into its tmux pane, and opening it. Handlers get it through the composer,
 * so they stay testable without VS Code.
 */
export class BoardSessions {
  constructor(
    private readonly model: SessionsModel,
    private readonly tree: SessionRowSelector,
  ) {}

  /** Sessions a command can go to (main and the worktrees), those in `preferDir` first. */
  running(preferDir?: string): SessionCard[] {
    return runningSessions(this.model.current, preferDir);
  }

  /** The session as last refreshed (its state, even its id, may have changed since it was picked). */
  latest(card: SessionCard): SessionCard {
    return currentCard(this.model.current, card);
  }

  /**
   * Asks which session a command goes to: `cards` in their order, else the running sessions (as just refreshed, so one
   * started a moment ago is there), those in `preferDir` first. `offerNew` (where it would start) adds a "New session"
   * row first; `onShow` runs as the list shows. Clicking back into the board does not dismiss it (Escape does).
   * Undefined when there is nothing to offer or the pick was dismissed.
   */
  async pick(options: {
    title: string;
    placeHolder?: string;
    cards?: readonly SessionCard[];
    preferDir?: string;
    offerNew?: string;
    onShow?: () => void;
  }): Promise<SessionCard | typeof NEW_SESSION | undefined> {
    type Item = vscode.QuickPickItem & { card?: SessionCard };
    const cards = options.cards ?? runningSessions(await this.model.fresh(), options.preferDir);
    const items: Item[] = sessionPicks(cards, Date.now(), sessionsTmuxServer());
    if (options.offerNew !== undefined) {
      if (items.length) items.unshift({ label: 'Running sessions', kind: vscode.QuickPickItemKind.Separator });
      items.unshift({ label: '$(add) New session', description: options.offerNew });
    }
    if (!items.length) return undefined;
    options.onShow?.();
    const picked = await vscode.window.showQuickPick(items, {
      title: options.title,
      placeHolder: options.placeHolder ?? 'Pick a running Claude session',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    return picked.card ?? NEW_SESSION;
  }

  /**
   * What the session's pane shows: Claude's prompt empty (no question or dialog open), Claude in a turn, the pane in a
   * tmux mode (copy mode), Claude exited (its old prompt box can stay above the shell prompt). Claude is looked for
   * after the capture, so a capture taken while it still ran is not taken for its prompt once gone.
   */
  async promptScreen(card: SessionCard): Promise<PromptScreen> {
    const pane = paneOf(card);
    if (!pane) return { empty: false, working: false };
    return readPromptScreen(pane.tmux, pane.target);
  }

  /** Types `text` (as one line) into the session's pane and presses Enter, as if typed in its terminal. */
  async typeInto(card: SessionCard, text: string): Promise<void> {
    const pane = paneOf(card);
    if (!pane) throw new Error('it does not run in tmux');
    await typeIntoPane(pane.tmux, pane.target, text);
  }

  /** Whether the session has ended (stopped, or its tmux session gone), as the sessions are just refreshed. */
  async ended(card: SessionCard): Promise<boolean> {
    return sessionEnded(await this.model.fresh(), card);
  }

  /** Runs before `open` opens a session's terminal (the panel makes room for it beside the board). */
  beforeOpen: (card: SessionCard) => Promise<unknown> = async () => undefined;

  /** Opens (or focuses) the session's terminal. */
  async open(card: SessionCard): Promise<void> {
    const latest = this.latest(card);
    await this.beforeOpen(latest);
    return openSessionCard(this.tree, latest);
  }
}

/** The session's tmux runner and pane target; undefined outside tmux. */
function paneOf(card: SessionCard) {
  const target = paneTarget(card);
  return target ? { target, tmux: sessionsTmux(cardServer(card)) } : undefined;
}
