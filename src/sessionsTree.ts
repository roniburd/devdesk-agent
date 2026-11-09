import * as vscode from 'vscode';
import { runningCount, type SessionChild } from './core/sessionChildren';
import type { SessionCard } from './core/sessions';
import {
  badgeFor,
  cardShown,
  cardSignature,
  cardView,
  foldParked,
  formatAgo,
  LOOK_ICONS,
  shownLook,
  readDecoration,
  stateLook,
  truncate,
  SettledOrder,
  type Settle,
} from './core/sessionsView';
import { oneLine } from './core/text';
import { sortSessions, urgentByWorktree } from './core/urgency';
import { statusFromText } from './core/statusMerge';
import { groupCards, type WorktreeGroup } from './core/worktreeTasks';
import { cardTerminal, findByTmux, claudeTerminalOfTab, claudeTerminalSession } from './claudeSessions';
import { sessionsDimRead, sessionsFinishedSessions, sessionsGroupByWorktree, sessionsIdleMs, sessionsReadAfterMs, sessionsStatusBar, sessionsStuckMs, sessionsTmuxServer, sessionsResortWorkingMs, sessionsRecentlyFinishedMs, sessionsSort, sessionsUnreadBadge, sessionsUnreadFirst } from './config';
import { hooksSettingsShown, hooksStatus, watchHooksSettings } from './hooksCommands';
import type { HooksStatus } from './core/hooks';
import { log } from './log';
import type { SessionsModel } from './sessionsModel';
import { SessionsReadState } from './sessionsReadState';
import { hostKey, MementoEntries } from './state/mementoState';
import { isSessionColorId, rowDecoration, SESSION_COLORS_LIMIT } from './core/sessionColors';
import type { WorktreeTaskStore } from './worktreeSessions';

export type SessionNode =
  | { kind: 'worktree'; group: WorktreeGroup }
  /** `flat`: listed outside any worktree row (`devdesk.sessions.groupByWorktree` off), so the row names its worktree. */
  | { kind: 'session'; card: SessionCard; flat?: boolean }
  | { kind: 'child'; card: SessionCard; child: SessionChild }
  /** A worktree's older parked sessions, folded into one row (`devdesk.sessions.finishedSessions`). */
  | { kind: 'more'; groupKey: string; cards: SessionCard[] }
  | { kind: 'hooks' };

/** Group key of the flat list's `N earlier finished` row (`devdesk.sessions.groupByWorktree` off). */
const ALL_KEY = 'all';

/** A worktree's rows: its sessions, with the older parked ones folded into one row. */
function worktreeRows(groupKey: string, cards: readonly SessionCard[]): SessionNode[] {
  const { shown, folded } = foldParked(cards, sessionsFinishedSessions());
  const flat = groupKey === ALL_KEY;
  const rows: SessionNode[] = shown.map((card) => ({ kind: 'session', card, flat }));
  if (folded.length) rows.push({ kind: 'more', groupKey, cards: folded });
  return rows;
}

const CHILD_ICONS: Record<SessionChild['kind'], string> = { agent: 'hubot', shell: 'terminal', workflow: 'type-hierarchy', phase: 'list-tree', more: 'ellipsis' };
const CHILD_COLORS: Record<SessionChild['state'], string | undefined> = { running: undefined, done: 'charts.green', failed: 'charts.red', stopped: 'disabledForeground' };
const CHILD_KIND_TEXT: Record<SessionChild['kind'], string> = { agent: 'agent', shell: 'shell', workflow: 'workflow', phase: 'phase', more: '' };

/** How long a just-started session may take to show up before the view stops waiting to select it. */
const PENDING_SELECT_MS = 30_000;
/** URI scheme of the session rows' `resourceUri`, which only carries their read-state decoration. */
const SESSION_SCHEME = 'devdesk-session';
/** `globalState` key (per host, `hostKey`) of the colors given to sessions by hand: `[session id, color id][]`. */
const COLORS_KEY = 'devdesk.sessions.colors';

/**
 * The Claude view: sessions grouped by worktree (or one flat list, `devdesk.sessions.groupByWorktree`) in the order
 * of `devdesk.sessions.sort`, unread ones marked (a dot badge, read titles greyed: `devdesk.sessions.unreadBadge`, `dimRead`), with a
 * needs-input badge and a "needs you" status bar item.
 */
export class SessionsTree implements vscode.TreeDataProvider<SessionNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly changed = new vscode.EventEmitter<SessionNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly urgentChanged = new vscode.EventEmitter<void>();
  /** Fires when the most urgent session of some worktree may have changed (the Worktrees view shows it). */
  readonly onDidChangeUrgent = this.urgentChanged.event;
  readonly view: vscode.TreeView<SessionNode>;
  private readonly status = vscode.window.createStatusBarItem('devdesk.sessions.needsYou', vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: vscode.Disposable[];
  private readonly read: SessionsReadState;
  /** Colors given to sessions by hand (**Set Color…**), shared by this host's windows. */
  private readonly colors: MementoEntries<string>;
  /** The colors last drawn, to redraw when another window changed them. */
  private drawnColors: ReadonlyMap<string, string> | undefined;
  private hooksState: HooksStatus = 'installed';
  /** Counts hook reads, so a slow earlier read cannot overwrite a later one. */
  private hooksReads = 0;
  private readonly settledOrder = new SettledOrder();
  /** A tmux session just started from DevDesk: selected as soon as the model lists it. */
  private pending: { session: string; server: string; until: number } | undefined;
  /** The session whose row was last selected because its Claude terminal came to the front. */
  private followed: string | undefined;
  /** Holds the model while the view is visible or the status bar item is on. */
  private readonly hold: { set(want: boolean): void };

  constructor(
    readonly model: SessionsModel,
    private readonly tasks: WorktreeTaskStore,
    state: vscode.Memento,
  ) {
    this.hold = this.model.holder();
    this.read = new SessionsReadState(model, state, () => this.syncRead());
    this.colors = new MementoEntries(state, hostKey(COLORS_KEY), isSessionColorId, SESSION_COLORS_LIMIT);
    this.view = vscode.window.createTreeView('devdesk.sessions', { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
    this.status.name = 'Claude sessions needing input';
    this.status.command = 'devdesk.sessions.nextWaiting';
    this.subscriptions = [
      this.read,
      this.view,
      this.status,
      this.changed,
      this.urgentChanged,
      this.decorationsChanged,
      vscode.window.registerFileDecorationProvider(this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        const reorders = ['groupByWorktree', 'resortWorkingMinutes', 'sort', 'recentlyFinishedMinutes', 'unreadFirst', 'idleMinutes', 'stuckMinutes'];
        if (reorders.some((k) => e.affectsConfiguration(`devdesk.sessions.${k}`))) {
          this.changed.fire(undefined);
          // The Worktrees view shows each worktree's first session in this order.
          this.urgentChanged.fire();
        }
        if (e.affectsConfiguration('devdesk.sessions.dimRead') || e.affectsConfiguration('devdesk.sessions.unreadBadge')) this.decorationsChanged.fire(undefined);
      }),
      model.onDidChange(() => this.update()),
      tasks.onDidChange(() => this.changed.fire(undefined)),
      // Not on showing the view: its reveal would race a closing sidebar and show it again.
      this.view.onDidChangeVisibility(() => this.syncAcquire()),
      vscode.window.onDidChangeActiveTerminal((t) => this.followTerminal(this.focusedCard(t))),
      vscode.window.tabGroups.onDidChangeTabs(() => this.followTab()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.followTab()),
      watchHooksSettings(() => this.refreshHooks()),
    ];
    this.status.text = '';
    this.syncAcquire();
    this.refreshHooks();
  }

  /** The model polls while the view is visible or the status bar item is on. */
  syncAcquire(): void {
    const want = this.view.visible || sessionsStatusBar();
    this.hold.set(want);
    this.update();
  }

  /** The decoration of a session row: its read state (see `readDecoration`) and the color given to it (`rowDecoration`). */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SESSION_SCHEME) return undefined;
    const id = uri.path.slice(1);
    const read = readDecoration(this.read.unread.has(id), { dimRead: sessionsDimRead(), badge: sessionsUnreadBadge() });
    const d = rowDecoration(read, this.colors.get().get(id));
    return d && new vscode.FileDecoration(d.badge, d.tooltip, d.color ? new vscode.ThemeColor(d.color) : undefined);
  }

  /** Re-reads whether the hooks are installed (settings.json): on activation, setting changes and when the file changes. */
  refreshHooks(): void {
    const read = ++this.hooksReads;
    void hooksStatus().then(
      (state) => {
        if (read !== this.hooksReads || this.hooksState === state) return;
        this.hooksState = state;
        this.changed.fire(undefined);
      },
      (err) => log.warn(`cannot read Claude hook settings: ${(err as Error).message}`),
    );
  }

  /** Sessions with something new since the user last looked at them (the Claude Board shows the same). */
  get unreadIds(): ReadonlySet<string> {
    return this.read.unread;
  }

  /** Whether the user has read what `card` shows now (also for sessions this window does not list). */
  isRead(card: SessionCard): boolean {
    return this.read.isRead(card);
  }

  /** Working sessions keep their order between re-sorts, here and on the Claude Board. */
  get settle(): Settle {
    return { order: this.settledOrder, everyMs: sessionsResortWorkingMs() };
  }

  /** Cards in the order `devdesk.sessions.sort` names (urgency or attention). */
  get cards(): SessionCard[] {
    return sortSessions(this.model.current, {
      mode: sessionsSort(),
      now: Date.now(),
      idleMs: sessionsIdleMs(),
      stuckMs: sessionsStuckMs(),
      recentMs: sessionsRecentlyFinishedMs(),
      unread: this.read.unread,
      unreadFirst: sessionsUnreadFirst(),
      settle: this.settle,
    });
  }

  /** Top-level rows: the worktrees with sessions or a recorded task (by their first card), each with its cards in order. */
  groups(): WorktreeGroup[] {
    return groupCards(this.cards, this.model.featureList, this.tasks.all());
  }

  /** A worktree's rows as the Claude view nests them (the Worktrees view lists them too, `devdesk.worktrees.showSessions`). */
  rowsForWorktree(dir: string): SessionNode[] {
    const group = this.groups().find((g) => g.dir === dir);
    return group ? worktreeRows(group.key, group.cards) : [];
  }

  private group(key: string): WorktreeGroup | undefined {
    return this.groups().find((g) => g.key === key);
  }

  /** The cards a `N earlier finished` row stands for, from the current listing. */
  private cardsOf(groupKey: string): SessionCard[] {
    return groupKey === ALL_KEY ? this.cards : this.group(groupKey)?.cards ?? [];
  }

  /** The most urgent session of each worktree directory. */
  urgentByWorktree(): Map<string, SessionCard> {
    return urgentByWorktree(this.model.current, {
      mode: sessionsSort(),
      now: Date.now(),
      idleMs: sessionsIdleMs(),
      stuckMs: sessionsStuckMs(),
      recentMs: sessionsRecentlyFinishedMs(),
      unread: this.read.unread,
      unreadFirst: sessionsUnreadFirst(),
    });
  }

  /** The Claude view is showing (for tests). */
  get visible(): boolean {
    return this.view.visible;
  }

  /** The Claude view was shown or hidden. */
  get onDidChangeVisibility(): vscode.Event<vscode.TreeViewVisibilityChangeEvent> {
    return this.view.onDidChangeVisibility;
  }

  /** The row a command was run on: the clicked one, else (from the command palette) the selected one. */
  clickedOrSelected(arg: unknown): SessionNode | undefined {
    return (arg as SessionNode | undefined) ?? this.view.selection[0];
  }

  /** The session of the Claude view's selected row (a session or one of its children), if any. */
  selectedSessionId(): string | undefined {
    const node = this.view.selection[0];
    return node && (node.kind === 'session' || node.kind === 'child') ? node.card.id : undefined;
  }

  /** Selects the session's row once the model lists it (it was just started). */
  selectWhenListed(session: string): void {
    this.pending = { session, server: sessionsTmuxServer(), until: Date.now() + PENDING_SELECT_MS };
    this.selectPending();
  }

  /** Reveals and selects a card's row (only while the view is visible, so it never steals the sidebar). */
  select(card: SessionCard): void {
    if (this.view.visible) void this.view.reveal(this.sessionNode(card), { select: true, focus: false }).then(undefined, () => undefined);
  }

  /** A card's row in the Claude view as currently laid out. */
  private sessionNode(card: SessionCard): SessionNode {
    return { kind: 'session', card, flat: !sessionsGroupByWorktree() };
  }

  /** The last focus() call, settled once VS Code has put the keyboard on the row (or the view). */
  private focusing: Promise<void> = Promise.resolve();

  /**
   * Shows the Claude view and moves focus to it: on `card`'s row when given and listed, else the selected session's,
   * else the first session's (focusing the view alone leaves the keyboard on no row), else the empty view.
   */
  focus(card?: SessionCard): Promise<void> {
    const run = this.focusRow(card);
    this.focusing = run.catch(() => undefined);
    return run;
  }

  /**
   * Settles once the last focus() is done. VS Code shows (and focuses) the view first and moves the keyboard to the row
   * last, after asking this extension host for the rows: on a busy or remote one, a key pressed in between (→ to the
   * board) would otherwise lose the focus to that last step.
   */
  focusSettled(): Promise<void> {
    return this.focusing;
  }

  private async focusRow(card?: SessionCard): Promise<void> {
    const selected = this.selectedSessionId();
    card ??= (selected ? this.model.find(selected) : undefined) ?? this.groups()[0]?.cards[0];
    if (card) {
      try {
        await this.view.reveal(this.sessionNode(card), { select: true, focus: true });
        return;
      } catch {
        // Not listed (yet): focus the view itself.
      }
    }
    await vscode.commands.executeCommand('devdesk.sessions.focus');
  }

  /** The card whose Claude terminal is in front (or is `terminal`), if any. */
  focusedCard(terminal = vscode.window.activeTerminal): SessionCard | undefined {
    const of = claudeTerminalSession(terminal);
    return of && findByTmux(this.model.current, of.session, of.server);
  }

  /** Recomputes the unread sessions; when they changed, redraws their rows (and, if `fire`, the views). */
  private syncRead(fire = true): void {
    if (!this.read.sync()) return;
    this.decorationsChanged.fire(undefined);
    if (fire) {
      this.changed.fire(undefined);
      this.urgentChanged.fire();
    }
  }

  /** Marks a session read or unread by hand (its row's and card's **Mark as Read/Unread**; see `SessionsReadState.setRead`). */
  setRead(id: string, read: boolean): void {
    const changed = this.read.setRead(id, read);
    if (changed === undefined) return;
    if (changed) this.decorationsChanged.fire(undefined);
    this.changed.fire(undefined);
    this.urgentChanged.fire();
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
    this.changed.fire(undefined);
  }

  /** Redraws the rows' decorations when the saved colors changed (here or in another window). */
  private syncColors(): void {
    const now = this.colors.get();
    if (now === this.drawnColors) return;
    this.drawnColors = now;
    this.decorationsChanged.fire(undefined);
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
          look: stateLook(c, now, sessionsStuckMs()),
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

  /**
   * The card of the Claude terminal in front: the active editor tab's when it is a terminal, else the active terminal's
   * (a terminal in the panel, or the one last in front while an editor or the board has the focus).
   */
  frontCard(): SessionCard | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return this.focusedCard(tab?.input instanceof vscode.TabInputTerminal ? claudeTerminalOfTab(tab) : vscode.window.activeTerminal);
  }

  /**
   * Selects the row of the session whose Claude terminal came to the front (or is listed now), once each time, so the
   * user can select other rows meanwhile. Only while the view is visible.
   */
  private followTerminal(card = this.frontCard()): void {
    if (!card) {
      this.followed = undefined;
      return;
    }
    if (card.id === this.followed || !this.view.visible) return;
    this.followed = card.id;
    this.select(card);
  }

  /** The active editor tab changed: a Claude terminal tab brought to the front selects its row again. */
  private followTab(): void {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputTerminal) this.followTerminal(this.focusedCard(claudeTerminalOfTab(tab)));
    else this.followed = undefined;
  }

  private selectPending(): void {
    const p = this.pending;
    if (!p) return;
    if (Date.now() > p.until) {
      this.pending = undefined;
      return;
    }
    const card = findByTmux(this.model.current, p.session, p.server);
    if (card) {
      this.pending = undefined;
      this.select(card);
    }
  }

  private update(): void {
    const next = this.model.current;
    this.syncRead(false);
    this.syncColors();
    const waiting = next.filter((c) => c.state === 'waiting').length;
    this.view.badge = badgeFor(next);
    if (waiting && sessionsStatusBar()) {
      this.status.text = `$(comment-discussion) ${waiting} need${waiting === 1 ? 's' : ''} you`;
      this.status.tooltip = 'Open the next Claude session needing input';
      this.status.show();
    } else {
      this.status.hide();
    }
    this.changed.fire(undefined);
    this.urgentChanged.fire();
    this.selectPending();
    this.followTerminal();
  }

  getChildren(node?: SessionNode): SessionNode[] {
    if (node?.kind === 'session') return (node.card.children ?? []).map((child) => ({ kind: 'child', card: node.card, child }));
    if (node?.kind === 'child') return node.child.children.map((child) => ({ kind: 'child', card: node.card, child }));
    if (node?.kind === 'worktree') {
      return worktreeRows(node.group.key, this.group(node.group.key)?.cards ?? []);
    }
    if (node?.kind === 'more') {
      const flat = node.groupKey === ALL_KEY;
      return foldParked(this.cardsOf(node.groupKey), sessionsFinishedSessions()).folded.map((card) => ({ kind: 'session', card, flat }));
    }
    if (node) return [];
    const rows: SessionNode[] = sessionsGroupByWorktree() ? this.groups().map((group) => ({ kind: 'worktree', group })) : worktreeRows(ALL_KEY, this.cards);
    return this.hooksState !== 'installed' ? [{ kind: 'hooks' }, ...rows] : rows;
  }

  /** A session's worktree group (needed to reveal session rows); other rows are never revealed. */
  getParent(node: SessionNode): SessionNode | undefined {
    if (!sessionsGroupByWorktree()) {
      const { folded } = foldParked(this.cards, sessionsFinishedSessions());
      return node.kind === 'session' && folded.some((c) => c.id === node.card.id) ? { kind: 'more', groupKey: ALL_KEY, cards: folded } : undefined;
    }
    if (node.kind === 'more') {
      const group = this.group(node.groupKey);
      return group ? { kind: 'worktree', group } : undefined;
    }
    if (node.kind !== 'session') return undefined;
    const group = this.groups().find((g) => g.cards.some((c) => c.id === node.card.id));
    if (!group) return undefined;
    const { folded } = foldParked(group.cards, sessionsFinishedSessions());
    if (folded.some((c) => c.id === node.card.id)) return { kind: 'more', groupKey: group.key, cards: folded };
    return { kind: 'worktree', group };
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    if (node.kind === 'hooks') {
      const outdated = this.hooksState === 'outdated';
      const item = new vscode.TreeItem(outdated ? 'Update Claude status hooks…' : 'Install Claude status hooks…');
      item.id = 'hooks';
      item.description = outdated ? 'need an update' : 'sessions show no status without them';
      item.tooltip = outdated
        ? `This version of DevDesk needs its hooks in ${hooksSettingsShown()} updated to show every session's status. Click to update them.`
        : `DevDesk shows what each Claude session is doing (working, waiting for you, done) through hooks in ${hooksSettingsShown()}. Click to install them.`;
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      item.command = { command: 'devdesk.sessions.installHooks', title: 'Install Claude Status Hooks' };
      return item;
    }
    if (node.kind === 'child') return this.childItem(node.card, node.child);
    if (node.kind === 'more') {
      const n = node.cards.length;
      const item = new vscode.TreeItem(`${n} earlier finished`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `more:${node.groupKey}`;
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.tooltip = `${n} older parked session${n === 1 ? '' : 's'} (devdesk.sessions.finishedSessions)`;
      item.contextValue = 'more';
      return item;
    }
    if (node.kind === 'worktree') return this.worktreeItem(node.group);
    const { card, flat } = node;
    const now = Date.now();
    const v = cardView(card, now, sessionsTmuxServer());
    const { look, label } = shownLook(card, now, sessionsStuckMs());
    const unread = this.read.unread.has(card.id);
    const item = new vscode.TreeItem(v.title);
    item.id = `session:${card.id}`;
    // Only for its read-state decoration (provideFileDecoration): tree labels cannot be bold.
    item.resourceUri = vscode.Uri.from({ scheme: SESSION_SCHEME, path: `/${card.id}` });
    const running = runningCount(card.children ?? []);
    // Under a worktree row the worktree is the row above (the tooltip still names it); in the flat list the row names it.
    const parked = card.state === 'parked';
    const worktree = flat ? v.worktree : '';
    item.description = [worktree, running ? `${running} running` : '', parked ? 'parked' : '', v.ago, v.liveStatus || v.detail].filter(Boolean).join(' · ');
    // Expanded while something it started runs; after that VS Code keeps the user's choice (by id).
    if (card.children?.length) item.collapsibleState = running ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${label}**${unread ? ' (unread)' : ''} · ${v.worktree}\n\n`);
    tooltip.appendText(`${v.title}\n\n`);
    if (v.liveStatus) tooltip.appendText(`Now: ${v.liveStatus}\n\n`);
    if (v.insight) tooltip.appendText(`Where it stands: ${v.insight}\n\n`);
    if (v.summary) tooltip.appendText(`${v.summary}\n\n`);
    if (v.prompt) tooltip.appendText(`Last prompt: ${v.prompt}\n\n`);
    if (v.detail) tooltip.appendText(`${v.detail}\n\n`);
    const from = statusFromText(card, now);
    if (from) tooltip.appendText(`${from}\n\n`);
    if (v.times) tooltip.appendText(`${v.times}\n\n`);
    if (parked) tooltip.appendText(`Not running (${card.endReason ?? 'ended'}). Opening it resumes the conversation: claude --resume ${card.sessionId}\n\n`);
    tooltip.appendText(v.location);
    item.tooltip = tooltip;
    const icon = LOOK_ICONS[look];
    item.iconPath = new vscode.ThemeIcon(icon.icon, icon.color ? new vscode.ThemeColor(icon.color) : undefined);
    // `color-<id>` checks the current color in the Color submenu; the read state stays last (the menus' `read$`).
    const color = this.colorOf(card.id);
    item.contextValue = ['session', parked ? 'parked' : card.tmuxSession ? 'tmux' : '', card.sessionId && card.cwd ? 'forkable' : '', color ? `color-${color}` : '', unread ? 'unread' : 'read']
      .filter(Boolean)
      .join(' ');
    item.command = { command: 'devdesk.sessions.openCard', title: parked ? 'Resume Claude Session' : 'Open Claude Session', arguments: [node] };
    item.accessibilityInformation = { label: `${label}${unread ? ', unread' : ''}: ${v.title}, ${v.worktree}` };
    return item;
  }

  /** A worktree and the task it was started for; its sessions are nested under it. */
  private worktreeItem(group: WorktreeGroup): vscode.TreeItem {
    const n = group.cards.length;
    const item = new vscode.TreeItem(group.name, n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = group.key;
    const task = group.task ? oneLine(group.task) : '';
    item.description = [task ? truncate(task, 60) : '', n ? `${n} session${n === 1 ? '' : 's'}` : 'no sessions'].filter(Boolean).join(' · ');
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${group.name}**\n\n`);
    if (group.task) tooltip.appendText(`${group.task}\n\n`);
    tooltip.appendText(group.dir ?? 'Sessions outside any worktree');
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(group.isMain ? 'home' : group.dir ? 'git-branch' : 'question');
    item.contextValue = group.dir ? 'worktree launchable' : 'worktree';
    item.accessibilityInformation = { label: `Worktree ${group.name}${task ? `: ${task}` : ''}, ${item.description}` };
    return item;
  }

  /** A subagent, background shell, workflow or workflow phase under a session. */
  private childItem(card: SessionCard, child: SessionChild): vscode.TreeItem {
    const item = new vscode.TreeItem(child.label);
    item.id = `child:${card.id}:${child.id}`;
    if (child.kind === 'more') {
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.tooltip = 'Older finished items are hidden (devdesk.sessions.finishedChildren)';
      item.contextValue = 'child more';
      return item;
    }
    const kind = child.kind === 'agent' && child.detail ? `agent · ${child.detail}` : CHILD_KIND_TEXT[child.kind];
    const command = child.kind === 'shell' && child.detail && child.detail !== child.label ? truncate(child.detail, 60) : '';
    item.description = [kind, child.state === 'running' ? '' : child.state, formatAgo(child.startedAt, Date.now()), command].filter(Boolean).join(' · ');
    const color = CHILD_COLORS[child.state];
    item.iconPath =
      child.state === 'running' ? new vscode.ThemeIcon('loading~spin') : new vscode.ThemeIcon(CHILD_ICONS[child.kind], color ? new vscode.ThemeColor(color) : undefined);
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${child.state.toUpperCase()}** · ${CHILD_KIND_TEXT[child.kind]}${child.background ? ' (background)' : ''}\n\n`);
    tooltip.appendText(`${child.label}\n\n`);
    if (child.detail) tooltip.appendText(`${child.detail}\n\n`);
    if (child.file) tooltip.appendText(child.file);
    item.tooltip = tooltip;
    if (child.children.length) {
      item.collapsibleState = child.state === 'running' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    }
    item.contextValue = `child ${child.kind}`;
    if (child.file) item.command = { command: 'devdesk.sessions.openChild', title: 'Open Transcript or Output', arguments: [child.file] };
    item.accessibilityInformation = { label: `${CHILD_KIND_TEXT[child.kind]} ${child.state}: ${child.label}` };
    return item;
  }

  dispose(): void {
    this.hold.set(false);
    this.subscriptions.forEach((s) => s.dispose());
  }
}
