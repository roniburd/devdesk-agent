import * as vscode from 'vscode';
import type { SessionCard } from './core/sessions';
import { attentionOrder, cardShown, cardSignature, cardView, stateLook, truncate, urgentByWorktree, SettledOrder, type Settle, type ViewContext } from './core/sessionsView';
import { cardTerminal, findByTmux, claudeTerminalOfTab, claudeTerminalSession } from './claudeSessions';
import { sessionsIdleMs, sessionsReadAfterMs, sessionsResortWorkingMs, sessionsStuckMs, sessionsTmuxServer, sessionsUnreadFirst } from './config';
import type { SessionsModel } from './sessionsModel';
import { SessionsReadState } from './sessionsReadState';
import { hostKey, MementoEntries } from './state/mementoState';
import { isSessionColorId, SESSION_COLORS_LIMIT } from './core/sessionColors';

/** `globalState` key (per host, `hostKey`) of the colors given to sessions by hand: `[session id, color id][]`. */
const COLORS_KEY = 'devdesk.sessions.colors';

/** What a change of the view state asks the views to redraw. */
export interface ViewStateChange {
  /** The session rows' decorations (read state, colors). */
  decorations: boolean;
  /** The rows themselves (their read state or Color submenu checks), and through them the board. */
  rows: boolean;
  /** The most urgent session of some worktree (the Worktrees view shows it). */
  urgent: boolean;
}

/**
 * What the Claude view and the Claude Board show of the sessions besides the model's cards, kept once for both: which
 * sessions are unread, the colors given to them by hand, the order working sessions settle in between re-sorts, and
 * which session's Claude terminal is in front.
 */
export class SessionViewState implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ViewStateChange>();
  /** The read state or the colors changed: what to redraw. */
  readonly onDidChange = this.changed.event;
  private readonly read: SessionsReadState;
  /** Colors given to sessions by hand (**Set Color…**), shared by this host's windows. */
  private readonly colors: MementoEntries<string>;
  /** The colors last drawn, to redraw when another window changed them. */
  private drawnColors: ReadonlyMap<string, string> | undefined;
  private readonly settledOrder = new SettledOrder();

  constructor(
    private readonly model: SessionsModel,
    state: vscode.Memento,
  ) {
    this.read = new SessionsReadState(model, state, () => this.syncRead());
    this.colors = new MementoEntries(state, hostKey(COLORS_KEY), isSessionColorId, SESSION_COLORS_LIMIT);
  }

  /** Sessions with something new since the user last looked at them (the Claude view and the Claude Board show them). */
  get unreadIds(): ReadonlySet<string> {
    return this.read.unread;
  }

  /** Whether the user has read what `card` shows now (also for sessions this window does not list). */
  isRead(card: SessionCard): boolean {
    return this.read.isRead(card);
  }

  /**
   * Recomputes the unread sessions; when they changed, redraws their rows' decorations (and, if `fire`, the views).
   * Called by the read state itself when a terminal came to the front, and on every model refresh.
   */
  syncRead(fire = true): void {
    if (!this.read.sync()) return;
    this.changed.fire({ decorations: true, rows: fire, urgent: fire });
  }

  /** Marks a session read or unread by hand (its row's and card's **Mark as Read/Unread**; see `SessionsReadState.setRead`). */
  setRead(id: string, read: boolean): void {
    const changed = this.read.setRead(id, read);
    if (changed === undefined) return;
    this.changed.fire({ decorations: changed, rows: true, urgent: true });
  }

  /** Working sessions keep their order between re-sorts, in the Claude view and on the Claude Board. */
  get settle(): Settle {
    return { order: this.settledOrder, everyMs: sessionsResortWorkingMs() };
  }

  /** What the Claude view and the Claude Board go by besides the cards, now and with the current settings. */
  viewContext(now = Date.now()): ViewContext {
    return { now, idleMs: sessionsIdleMs(), stuckMs: sessionsStuckMs(), unread: this.read.unread, unreadFirst: sessionsUnreadFirst(), settle: this.settle };
  }

  /** Cards in attention order. */
  get cards(): SessionCard[] {
    return attentionOrder(this.model.current, this.viewContext());
  }

  /** The most urgent session of each worktree directory. */
  urgentByWorktree(): Map<string, SessionCard> {
    return urgentByWorktree(this.model.current, this.viewContext());
  }

  /** The color given to a session by hand, if any. */
  colorOf(id: string): string | undefined {
    return this.colors.get().get(id);
  }

  /** The colors given to sessions by hand, by session id (the board draws them too). */
  get sessionColors(): ReadonlyMap<string, string> {
    return this.colors.get();
  }

  /** Gives sessions a color (a `SESSION_COLORS` id), or takes it away (undefined). */
  async setColor(ids: readonly string[], color: string | undefined): Promise<void> {
    if (!ids.length) return;
    await this.colors.apply(new Map(ids.map((id) => [id, color])));
    this.syncColors();
    // Redraws the rows (their Color submenu checks) and, through it, the board's cards.
    this.changed.fire({ decorations: false, rows: true, urgent: false });
  }

  /** Redraws the rows' decorations when the saved colors changed (here or in another window). */
  syncColors(): void {
    const now = this.colors.get();
    if (now === this.drawnColors) return;
    this.drawnColors = now;
    this.changed.fire({ decorations: true, rows: false, urgent: false });
  }

  /** The card whose Claude terminal is in front (or is `terminal`), if any. */
  focusedCard(terminal = vscode.window.activeTerminal): SessionCard | undefined {
    const of = claudeTerminalSession(terminal);
    return of && findByTmux(this.model.current, of.session, of.server);
  }

  /**
   * The card of the Claude terminal in front: the active editor tab's when it is a terminal, else the active terminal's
   * (a terminal in the panel, or the one last in front while an editor or the board has the focus).
   */
  frontCard(): SessionCard | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return this.focusedCard(tab?.input instanceof vscode.TabInputTerminal ? claudeTerminalOfTab(tab) : vscode.window.activeTerminal);
  }

  /** The card of a terminal tab's Claude terminal, if any. */
  tabCard(tab: vscode.Tab): SessionCard | undefined {
    return this.focusedCard(claudeTerminalOfTab(tab));
  }

  /**
   * Everything that decides whether a session reads as unread, for `devdesk.sessions.diagnostics`: the window and its
   * terminal tabs, and per session what it shows, its signature against the saved one, and why it last changed.
   */
  diagnostics(): unknown {
    const now = Date.now();
    const readMs = sessionsReadAfterMs();
    const saved = this.read.savedState;
    return {
      at: new Date(now).toISOString(),
      windowFocused: vscode.window.state.focused,
      readAfterMs: readMs,
      idleMs: sessionsIdleMs(),
      stuckMs: sessionsStuckMs(),
      unreadFirst: sessionsUnreadFirst(),
      modelLoaded: this.model.isLoaded,
      seeded: saved.seeded,
      savedSeenCount: saved.count,
      savedSeenKey: saved.key,
      activeTerminal: vscode.window.activeTerminal?.name,
      terminals: vscode.window.terminals.map((t) => t.name),
      tabGroups: vscode.window.tabGroups.all.map((g) => ({
        active: g.isActive,
        activeTab: g.activeTab?.label,
        tabs: g.tabs.map((t) => `${t.label}${t.input instanceof vscode.TabInputTerminal ? ' [terminal]' : ''}`),
      })),
      sessions: this.model.current.map((c) => {
        const v = cardView(c, now, sessionsTmuxServer());
        const { savedSignature, lastChange, inFrontSince: since } = this.read.sessionState(c.id);
        return {
          id: c.id,
          title: v.title,
          worktree: v.worktree,
          look: stateLook(c, { now, stuckMs: sessionsStuckMs() }),
          unread: this.read.unread.has(c.id),
          lastReadChange: lastChange ? { ...lastChange, at: new Date(lastChange.at).toISOString() } : undefined,
          signature: cardSignature(c),
          savedSignature,
          shown: cardShown(c),
          terminalName: cardTerminal(c)?.name,
          inFrontForMs: since === undefined ? undefined : now - since,
          state: c.state,
          updatedAt: c.updatedAt && new Date(c.updatedAt).toISOString(),
          attached: c.attached,
          crashed: c.crashed,
          tmuxSession: c.tmuxSession,
          tmuxPane: c.tmuxPane,
          tmuxServer: c.tmuxServer,
          sessionId: c.sessionId,
          pid: c.pid,
          cwd: c.cwd,
          featureDir: c.featureDir,
          transcriptPath: c.transcriptPath,
          name: c.name,
          prompt: c.prompt && truncate(c.prompt, 200),
          summaryAt: c.summaryAt && new Date(c.summaryAt).toISOString(),
          children: c.children?.map((k) => ({ id: k.id, kind: k.kind, state: k.state, label: k.label })),
        };
      }),
    };
  }

  dispose(): void {
    this.read.dispose();
    this.changed.dispose();
  }
}
