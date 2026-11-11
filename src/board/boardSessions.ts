import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { claudeIsWorking, claudePromptIsEmpty, paneScreenArgs, parsePaneScreen } from '../core/claudePrompt';
import { findDescendant, listProcesses } from '../core/processes';
import { readCardProgramStatus, screenWithProgramStatus } from '../core/programStatus';
import { isClaudeCommand, processAlive } from '../core/sessions';
import type { SessionCard } from '../core/sessions';
import { currentCard, NEW_SESSION, type PromptScreen, runningSessions, sessionEnded, sessionPicks } from '../core/sessionSend';
import { commandLine, commandParts, FIELD_SEP, pastedText, isShellCommand, paneTarget, pasteArgs, pasteBufferName, pasteSubmitDelayMs, typeArgs } from '../core/tmux';
import { boardPasteSettleMs, programStatusDir, sessionsTmux, sessionsTmuxServer } from '../config';
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
   * after the capture, so a capture taken while it still ran is not taken for its prompt once gone. Claude's own
   * report (OSC 7501, for sessions under the Program Status relay) says whether it works or a dialog is open, where
   * there is one; the capture says the rest, and all of it without one.
   */
  async promptScreen(card: SessionCard): Promise<PromptScreen> {
    const pane = paneOf(card);
    if (!pane) return { empty: false, working: false };
    // The screen and the pane's flags (tmux mode, bracketed paste, cursor) in one tmux call, so they agree.
    const out = await pane.tmux(paneScreenArgs(pane.target, FIELD_SEP, ['#{pane_pid}', '#{pane_current_command}']));
    const { capture, flags, extra } = parsePaneScreen(out, FIELD_SEP);
    const [pid, command = ''] = extra;
    const status = await readCardProgramStatus(programStatusDir(), card, processAlive);
    return screenWithProgramStatus(
      {
        empty: claudePromptIsEmpty(capture, flags),
        working: claudeIsWorking(capture),
        exited: !(await claudeRunsIn(Number(pid), command.trim())),
        inMode: flags?.inMode ?? false,
      },
      status,
    );
  }

  /**
   * Enters `text` (as one command line: `commandLine`) at Claude's prompt in the session's pane: the `/name ` before an
   * argument typed, the rest as one bracketed paste through a tmux paste buffer of its own (`commandParts`), then Enter
   * once Claude has taken it in (`devdesk.board.pasteSettleMs`). With `multiline`, text that is not a `/command` keeps
   * its line breaks (a bracketed paste of several lines is one prompt; only a `/command` must be one line).
   */
  async typeInto(card: SessionCard, text: string, opts: { multiline?: boolean } = {}): Promise<void> {
    const pane = paneOf(card);
    if (!pane) throw new Error('it does not run in tmux');
    const keepLines = opts.multiline && !text.trimStart().startsWith('/');
    const { lead, rest } = keepLines ? { lead: '', rest: pastedText(text).replace(/\\$/, '\\ ') } : commandParts(commandLine(text));
    // A file only this user reads, gone once loaded: tmux reads it, as an argument this long would be too long for it.
    const dir = await mkdtemp(join(tmpdir(), 'devdesk-send-'));
    const { load, paste, drop, submit } = pasteArgs(pane.target, pasteBufferName(randomBytes(8).toString('hex')), join(dir, 'text'));
    try {
      await writeFile(load.at(-1)!, rest, { mode: 0o600 });
      await pane.tmux(load);
      try {
        if (lead) await pane.tmux(typeArgs(pane.target, lead));
        await pane.tmux(paste);
      } catch (err) {
        await pane.tmux(drop).catch(() => undefined);
        throw err;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await new Promise((r) => setTimeout(r, pasteSubmitDelayMs(boardPasteSettleMs(), Buffer.byteLength(rest))));
    await pane.tmux(submit);
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

/**
 * Whether Claude runs in a pane whose process is `pid` and whose foreground command tmux names `command`: a Claude
 * process under it (tmux names a `claude; exec $SHELL -l` wrapper shell `sh` while Claude runs), else, when the process
 * list cannot be read, a foreground command that is not a shell.
 */
async function claudeRunsIn(pid: number, command: string): Promise<boolean> {
  const procs = Number.isInteger(pid) && pid > 0 ? await listProcesses() : undefined;
  if (procs) return findDescendant(procs, pid, isClaudeCommand) !== undefined;
  return isClaudeCommand(command) || (command !== '' && !isShellCommand(command));
}

/** The session's tmux runner and pane target; undefined outside tmux. */
function paneOf(card: SessionCard) {
  const target = paneTarget(card);
  return target ? { target, tmux: sessionsTmux(cardServer(card)) } : undefined;
}
