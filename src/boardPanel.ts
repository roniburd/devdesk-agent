import * as vscode from 'vscode';
import { RedrawLog } from './core/boardRedraws';
import { type BacklogItem, besideBoardWidth, buildBoard, type BoardData, launchKey, legacyPrompt } from './core/board';
import { missingWorktree, parseCompose } from './core/composer';
import type { SessionCard } from './core/sessions';
import { truncate } from './core/sessionsView';
import { type ScopedPopover, scopedPopover, type UsageScope } from './core/usageScope';
import type { UsageScopeState } from './usageScopeState';
import type { UsageService } from './usageService';
import { planLimits } from './planLimits';
import type { BacklogStore } from './backlogStore';
import { BoardHistory } from './board/history';
import { BOARD_TITLE, boardHtml } from './board/html';
import { type BoardMessage, type BoardPost, type HostMessage, type PanelMessage, parseBoardMessage } from './board/messages';
import { PanelUi } from './board/panelUi';
import { BoardProjectState } from './board/projectState';
import type { BoardUi, SubmitOutcome } from './board/types';
import { BoardComposer, NO_FOLDER, type StartHow } from './boardComposer';
import {
  boardCardLine, boardCardTitle,
  boardLaneWidth,
  boardOpenWhenEmpty,
  boardOpenWithSidebar,
  boardPromptPlacement,
  openSettings,
  setGlobalSetting,
  boardSessionsBeside,
  sessionsDefaultMode,
  sessionsDimRead,
  sessionsFinishedSessions,
  sessionsTmuxServer,
  sessionsUnreadBadge,
  sessionsRecentlyFinishedMs,
  sessionsSort,
  workspaceRoot,
  claudeAccountOf,
  claudeAccounts,
  claudeDefaultAccount,
} from './config';
import { isClaudeTerminalTab, liveCardTerminal } from './claudeSessions';
import type { TicketLinks } from './ticketLinks';
import { log, noteLatency } from './log';
import { savePastedImage } from './pastedImages';
import type { SessionsModel } from './sessionsModel';
import { forkSession, killSession, openSessionCard } from './sessionsCommands';
import type { SessionsTree } from './sessionsTree';
import type { SessionViewState } from './sessionViewState';
import type { WorktreeTaskStore } from './worktreeSessions';
import { webviewOptions } from './webviewPage';

const BOARD_VIEW_TYPE = 'devdesk.board';
/** The New Session view above the Claude view: the board's prompt box alone (`boardHtml`'s compact page). */
export const SIDE_VIEW_ID = 'devdesk.sessions.prompt';
/** Model, tree and backlog changes often come together: post the board once for them. */
const POST_DELAY_MS = 50;

/** A prompt for later leaves the lane once what it ran is done: a session started, a command sent or run (the box empties). */
const ranOutcome = (outcome: SubmitOutcome) => outcome.clear && !outcome.error;

/** Board messages handled without waiting on the user (no dialog or picker), whose slow moments are worth logging. */
const UNATTENDED: ReadonlySet<BoardMessage['type']> = new Set(['ready', 'open', 'complete', 'usage', 'usageScope', 'sidebar']);

/** A tab showing the board's webview. */
const isBoardTab = (t: vscode.Tab) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(BOARD_VIEW_TYPE);

/**
 * A webview showing the board's prompt box: the board's tab, or the New Session view (`side`). Each has its own notice
 * and box (`ui`), and gets the answers to what it sent; both get the composer's choices.
 */
class Surface {
  webview: vscode.Webview | undefined;
  visible = false;
  /** The last board message posted to it, so an unchanged one is not posted (and re-rendered) again. */
  lastPosted: string | undefined;
  /** A composed prompt is being started or saved: a second Enter waits for it. */
  composing = false;
  /** The prompt box as the composer's handlers change it. */
  readonly ui: PanelUi;

  constructor(readonly side: boolean, beforeChoice: () => void) {
    // A setChoice may name a row the composer just added (`/model <id>`): the board with it goes first, not after the delay.
    this.ui = new PanelUi((m) => {
      if (m.type === 'setChoice') beforeChoice();
      this.post(m);
    });
  }

  post(m: PanelMessage): void {
    void this.webview?.postMessage(m);
  }
}

/**
 * The Claude Board: a composer that starts new Claude sessions, prompts saved for
 * later, and every Claude session the Claude view lists as swim lanes by state, in one editor tab. Opens by command,
 * from the Claude view's title bar, the first time the sidebar shows (`devdesk.board.openWithSidebar`), and
 * (`devdesk.board.openWhenEmpty`) whenever the editor area is left empty.
 */

export class BoardPanel implements vscode.Disposable, vscode.WebviewPanelSerializer, vscode.WebviewViewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private panelSubscriptions: vscode.Disposable[] = [];
  private postTimer: NodeJS.Timeout | undefined;
  private checks: { hint(dir: string): string } | undefined;
  private tickets: TicketLinks | undefined;
  /** Holds the model while the board is visible. */
  private readonly hold: { set(want: boolean): void };
  /** The session the last posted board marked as in front (`BoardSession.focused`). */
  private postedFocused: string | undefined;
  /** When the last board was posted, to log how long the webview took to show it. */
  private postedAt = 0;
  /** Prompts for later being started, so a double click does not start two sessions (and their cards say so). */
  private starting = new Set<string>();
  /** What to put in the composer once the webview is ready (`devdesk.board.addTask` before the board was open). */
  private pendingFocus: { text?: string; later?: boolean } | undefined;
  /** `focusPrompt` opened the board: its webview, once ready, puts the keyboard in the prompt box. */
  private pendingEnter = false;
  /** The webview's redraws, summed up in the log once a minute. */
  private readonly redraws = new RedrawLog(Date.now());
  /** The webview's last reported width (CSS px). */
  private width = 0;
  private readonly composer: BoardComposer;
  /** What the prompt box keeps for this project folder (choices, draft, earlier prompts, filter and search). */
  private readonly kept: BoardProjectState;
  /** The board's tab, and the New Session view above the Claude view. */
  private readonly boardSurface = new Surface(false, () => this.post());
  private readonly sideSurface = new Surface(true, () => this.post());
  /** The board's prompt box as the composer's handlers change it. */
  private readonly ui = this.boardSurface.ui;
  private readonly subscriptions: vscode.Disposable[];
  /** The Claude view has been shown in this window (`sidebarShown`). */
  private sidebarSeen = false;
  /** The New Session view, once VS Code has shown it. */
  private sideView: vscode.WebviewView | undefined;
  /** Past sessions (Claude's transcripts): the search box's history results, the ✨ search, Resume and Fork. */
  private readonly history: BoardHistory;
  /** How many times a webview loaded the board (said `ready`), for tests. */
  private webviewLoads = 0;
  /** How many times the board was told to put the keyboard in its prompt box (`enter`), for tests. */
  private promptEnters = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: SessionsModel,
    private readonly tree: SessionsTree,
    private readonly viewState: SessionViewState,
    private readonly backlog: BacklogStore,
    tasks: WorktreeTaskStore,
    globalState: vscode.Memento,
    workspaceState: vscode.Memento,
    private readonly usageService: UsageService,
    private readonly usageScope: UsageScopeState,
  ) {
    this.hold = this.model.holder();
    this.composer = new BoardComposer(model, tree, viewState, tasks, globalState);
    this.kept = new BoardProjectState(workspaceState);
    // A session the box starts with its terminal open, or one a command opens (D), opens beside the board.
    this.composer.beforeOpen = () => this.roomFor(undefined);
    this.composer.sessions.beforeOpen = (card) => this.roomFor(card);
    this.history = new BoardHistory({
      model,
      tree,
      isOpen: () => !!this.panel,
      post: (m) => this.postToWebview(m),
      notice: (notice) => this.ui.notice(notice),
      roomFor: (card) => this.roomFor(card),
      board: () => this.data(),
    });
    this.subscriptions = [
      this.composer,
      // The CLI listed its models (or a model was typed): the pill offers them.
      this.composer.onDidChange(() => this.schedulePost()),
      vscode.window.registerWebviewPanelSerializer(BOARD_VIEW_TYPE, this),
      // Kept while hidden (the Claude view collapsed or another container shown), so what is typed stays as it is.
      vscode.window.registerWebviewViewProvider(SIDE_VIEW_ID, this, { webviewOptions: { retainContextWhenHidden: true } }),
      model.onDidChange(() => this.schedulePost()),
      tree.onDidChangeTreeData(() => this.schedulePost()),
      backlog.onDidChange(() => this.schedulePost()),
      // The card of the Claude terminal in front is marked.
      vscode.window.onDidChangeActiveTerminal(() => this.frontMayHaveChanged()),
      // The scope is the window's, shared with the Claude Usage page: an open 📊 popup follows a choice made there
      // (the webview ignores usage while its popup is closed).
      usageScope.onDidChange(() => this.postUsage().catch((err: Error) => log.warn(`cannot count token usage: ${err.message}`))),
      // A popup waiting for a count shows how far it has got (the webview ignores it otherwise).
      usageService.onProgress(({ stored: _stored, ...progress }) => this.panel && this.postToWebview({ type: 'usageProgress', progress })),
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        // Closing the board itself as the last tab must not bring it straight back.
        if (!e.closed.some(isBoardTab)) this.openIfEmpty();
        // Another tab in front may be another session's Claude terminal.
        this.frontMayHaveChanged();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.frontMayHaveChanged()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // The board shows sessions with the devdesk.sessions settings (modes, idle and stuck times, unread order).
        if (e.affectsConfiguration('devdesk.sessions')) {
          this.schedulePost();
          // The Claude CLI (or its arguments) may be another one now: ask it again for its `/` list.
          this.composer.clearCommands();
        }
        // The account pill and the cards' account labels (devdesk.claude.accounts, defaultAccount).
        if (e.affectsConfiguration('devdesk.claude')) {
          this.schedulePost();
          this.composer.clearCommands();
        }
        if (!e.affectsConfiguration('devdesk.board')) return;
        this.schedulePost();
        this.openIfEmpty();
      }),
      { dispose: () => clearTimeout(this.postTimer) },
      this.history,
    ];
  }

  /** Opens the board in the active editor group, or reveals it. */
  open(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(BOARD_VIEW_TYPE, BOARD_TITLE, { viewColumn: vscode.ViewColumn.Active, preserveFocus }, this.options());
    this.attach(panel);
  }

  /**
   * `devdesk.board.focusPrompt` (→ from the Claude view, Ctrl+Cmd+B): opens the board when it is closed, brings it to
   * the front and puts the keyboard in its prompt box.
   */
  async focusPrompt(): Promise<void> {
    if (!this.panel) {
      this.pendingEnter = true;
      this.open();
      return;
    }
    // ← just focused the Claude view: VS Code moves the keyboard to the row last, and would take it back from the board.
    await this.tree.focusSettled();
    if (!this.panel) return;
    this.panel.reveal(undefined, false);
    this.postEnter();
  }

  /** Opens the board when `openWhenEmpty` is on and no editor group has a tab. */
  openIfEmpty(): void {
    if (!boardOpenWhenEmpty() || this.panel) return;
    if (vscode.window.tabGroups.all.some((g) => g.tabs.length)) return;
    this.open(true);
  }

  /**
   * The Claude view was just shown: the first time in this window (`devdesk.board.openWithSidebar`), the board opens
   * too, and takes the focus, so the sidebar starts on it.
   */
  sidebarShown(): void {
    if (this.sidebarSeen || !boardOpenWithSidebar()) return;
    this.sidebarSeen = true;
    if (!this.panel) this.open();
  }

  /** Restores the board after a window reload. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    if (this.panel) {
      panel.dispose();
      return;
    }
    panel.webview.options = this.options();
    this.attach(panel);
  }

  /**
   * `retainContextWhenHidden`: a Claude terminal opened in the board's editor group hides the board, and closing it
   * would otherwise load the webview again from scratch (its HTML, script and styles, over Remote-SSH on a dev
   * desktop), then wait for its `ready` and the board, before anything shows.
   */
  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return webviewOptions(this.extensionUri, { retainContextWhenHidden: true });
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.title = BOARD_TITLE;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'board.svg');
    panel.webview.html = boardHtml(panel.webview, this.extensionUri, boardPromptPlacement());
    this.boardSurface.webview = panel.webview;
    this.boardSurface.lastPosted = undefined;
    this.panelSubscriptions = [
      this.history.opened(() => !!this.panel?.visible),
      panel.webview.onDidReceiveMessage((m) => void this.handle(m, this.boardSurface)),
      panel.onDidChangeViewState(() => this.syncAcquire()),
      panel.onDidDispose(() => {
        for (const d of this.panelSubscriptions) d.dispose();
        this.panelSubscriptions = [];
        this.panel = undefined;
        this.boardSurface.webview = undefined;
        this.boardSurface.composing = false;
        this.history.release();
        // A board opened again starts with an empty box.
        this.ui.dismissed();
        this.syncAcquire();
      }),
    ];
    this.syncAcquire();
  }

  /** Shows the New Session view: the board's prompt box alone, above the Claude view. */
  resolveWebviewView(view: vscode.WebviewView): void {
    const side = this.sideSurface;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = boardHtml(view.webview, this.extensionUri, 'top', true);
    side.webview = view.webview;
    side.lastPosted = undefined;
    const subscriptions = [
      view.webview.onDidReceiveMessage((m) => void this.handle(m, side)),
      view.onDidChangeVisibility(() => this.syncAcquire()),
    ];
    view.onDidDispose(() => {
      for (const d of subscriptions) d.dispose();
      side.webview = undefined;
      side.composing = false;
      side.ui.dismissed();
      this.sideView = undefined;
      this.syncAcquire();
    });
    this.sideView = view;
    this.syncAcquire();
  }

  /** The sessions model polls while the board or the New Session view is visible. */
  private syncAcquire(): void {
    this.boardSurface.visible = !!this.panel?.visible;
    this.sideSurface.visible = !!this.sideView?.visible;
    const want = this.boardSurface.visible || this.sideSurface.visible;
    this.hold.set(want);
    if (want) this.schedulePost();
  }

  private schedulePost(): void {
    if (!(this.panel?.visible || this.sideView?.visible) || this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.post();
    }, POST_DELAY_MS);
  }

  /** Tabs or the active terminal changed: posts again only when another session's Claude terminal is in front now. */
  private frontMayHaveChanged(): void {
    if (this.viewState.frontCard()?.id !== this.postedFocused) this.schedulePost();
  }

  /**
   * The Claude account of a card's session when there are several accounts and it is not the default one: from its
   * transcript, else the one the board started it in.
   */
  private accountOf(): ((card: SessionCard) => string | undefined) | undefined {
    if (claudeAccounts().length < 2) return undefined;
    const fallback = claudeDefaultAccount().name;
    const launched = this.composer.launchedAccountNames(this.model.current);
    return (card) => {
      const account = claudeAccountOf(card.transcriptPath)?.name ?? (card.tmuxSession ? launched.get(launchKey(card.tmuxServer, card.tmuxSession)) : undefined);
      return account && account !== fallback ? account : undefined;
    };
  }

  /** The board as the webview shows it (`focused`: the session whose Claude terminal is in front). */
  data(focused = this.viewState.frontCard()?.id): BoardData {
    return buildBoard(this.model.current, this.backlog.all(), {
      view: this.viewState.viewContext(),
      colors: this.viewState.sessionColors,
      focused,
      vscodeServer: sessionsTmuxServer(),
      defaultMode: sessionsDefaultMode().name,
      starting: this.starting,
      models: this.composer.modelRows(),
      launchedModels: this.composer.launchedModels(this.model.current),
      accountOf: this.accountOf(),
      parkedLimit: sessionsFinishedSessions(),
      sort: sessionsSort(),
      recentMs: sessionsRecentlyFinishedMs(),
      cardTitle: boardCardTitle(),
      checks: (dir) => this.checks?.hint(dir) ?? '',
      ticket: (card) => this.tickets?.chip(this.tickets.forCard(card)),
    });
  }

  /** Where the cards' ticket chips come from (`TicketLinks`). */
  setTickets(tickets: TicketLinks): void {
    this.tickets = tickets;
    this.composer.ticketPrompt = (dir, prompt) => tickets.promptFor(dir, prompt);
    this.subscriptions.push(tickets.onDidChange(() => this.schedulePost()));
  }

  /** Where the cards' checks hints come from (`WorktreeChecks`): a card whose worktree has failing checks offers Fix checks. */
  setChecks(checks: { hint(dir: string): string; onDidChange: vscode.Event<void> }): void {
    this.checks = checks;
    this.subscriptions.push(checks.onDidChange(() => this.schedulePost()));
  }

  /** What the e2e tests look at and drive (spread into `testApi`, under these names). */
  testHooks() {
    return {
      /** Whether the Claude Board's tab is open, and what it shows. */
      boardOpen: () => !!this.panel,
      /** How many times the board's webview loaded (a hidden board keeps its webview, so showing it again loads none). */
      boardWebviewLoads: () => this.webviewLoads,
      /** How many times the board was told to focus its prompt box. */
      boardPromptEnters: () => this.promptEnters,
      /** The next showing of the Claude view opens the board again (`devdesk.board.openWithSidebar`). */
      boardForgetSidebarShown: () => {
        this.sidebarSeen = false;
      },
      boardData: () => this.data(),
      ...this.history.testHooks(),
      /** The board composer's choices, and a message as if its webview sent it. */
      boardComposer: async () => {
        await this.model.loadFeatures();
        return this.composer.info();
      },
      boardMessage: (m: unknown) => this.handle(m, this.boardSurface),
      /** Whether the New Session view has its webview, a message as if it sent it, and what it was posted since the last call. */
      sidePromptShown: () => !!this.sideSurface.webview,
      sidePromptMessage: (m: unknown) => this.handle(m, this.sideSurface),
      sidePromptUi: (): { messages: HostMessage[]; actions: { id: string; label: string }[] } => ({ messages: this.sideSurface.ui.takeRecorded(), actions: this.sideSurface.ui.actionIds }),
      /** What the board's prompt box keeps for this project folder (as posted to a webview that loads), and the file of its prompts for later. */
      boardKept: () => this.kept.restore(),
      boardBacklogFile: () => this.backlog.file,
      boardForgetKept: () => this.kept.forget(),
      /**
       * The prompt box messages (notice, setChoice, openPicker, clearBox, composed) posted since the last call and the
       * shown notice's action ids (click one with `boardMessage({ type: 'noticeAction', id })`), and what a submitted text
       * is classified as.
       */
      boardUi: (): { messages: HostMessage[]; actions: { id: string; label: string }[] } => ({ messages: this.ui.takeRecorded(), actions: this.ui.actionIds }),
      boardClassify: async (text: string, where = 'main') => {
        await this.model.loadFeatures();
        return this.composer.classify(text, where);
      },
      /** The `/` menu's rows for a query (`stacked`: after other commands; `kind: '@'`: the file menu's). */
      boardComplete: async (query: string, options: { where?: string; stacked?: boolean; kind?: '/' | '@' } = {}) => {
        await this.model.loadFeatures();
        return this.composer.complete(options.kind ?? '/', query, options.where ?? 'main', { stacked: options.stacked });
      },
      boardMakeRoomBeside: () => this.makeRoomBeside(),
      /** What the board's 📊 popover shows, for the window's scope or `scope`. */
      boardUsage: (scope?: UsageScope) => this.usage(scope),
    };
  }

  /** Posts to the board's tab. */
  private postToWebview(m: PanelMessage): void {
    this.boardSurface.post(m);
  }

  /** Posts the board and the composer's choices to each webview they changed for since its last post (every model poll asks). */
  private post(): void {
    const readStyle = { dimRead: sessionsDimRead(), badge: sessionsUnreadBadge() };
    const composer = this.panel || this.sideSurface.webview ? this.composer.info() : undefined;
    if (!composer) return;
    if (this.sideSurface.webview) {
      // The prompt box alone: no lanes to show.
      const message: BoardPost = { type: 'board', loaded: this.model.isLoaded, board: { lanes: [], needYou: 0, working: 0, worktrees: [] }, composer, readStyle, cardLine: false };
      const text = JSON.stringify(message);
      if (text !== this.sideSurface.lastPosted) {
        this.sideSurface.lastPosted = text;
        this.sideSurface.post(message);
      }
    }
    if (!this.panel) return;
    // A session resumed or forked from the history is on the board now: it leaves the history results.
    this.history.boardChanged();
    const start = Date.now();
    const focused = this.viewState.frontCard()?.id;
    const message: BoardPost = { type: 'board', loaded: this.model.isLoaded, board: this.data(focused), composer, readStyle, cardLine: boardCardLine() };
    const text = JSON.stringify(message);
    if (text === this.boardSurface.lastPosted) return;
    this.boardSurface.lastPosted = text;
    this.postedFocused = focused;
    this.postedAt = Date.now();
    log.debug(`board: built in ${this.postedAt - start}ms, ${Math.round(text.length / 1024)}KB`);
    noteLatency('board build', this.postedAt - start);
    this.postToWebview({ ...message, postedAt: this.postedAt });
  }

  private postEnter(): void {
    this.promptEnters++;
    this.postToWebview({ type: 'enter' });
  }

  private postFocus(focus: Omit<Extract<PanelMessage, { type: 'focus' }>, 'type'>): void {
    this.postToWebview({ type: 'focus', ...focus });
  }

  private async handle(raw: unknown, from: Surface): Promise<void> {
    const m = parseBoardMessage(raw);
    if (!m) return;
    if (m.type === 'rendered') {
      if (from.side) return;
      // `postedAt` is this host's clock, sent back as is: the delay is the message's trip plus the webview's render.
      const trip = m.postedAt === this.postedAt ? Date.now() - m.postedAt : undefined;
      noteLatency('board webview render', m.ms);
      if (trip !== undefined) noteLatency('board post to render', trip);
      const summary = this.redraws.add({ scriptMs: m.script ?? m.ms, frameMs: m.ms, rebuilt: m.rebuilt ?? m.cards, cards: m.cards }, Date.now());
      if (summary) log.info(summary);
      const script = m.script !== undefined ? ` (script ${m.script}ms, ${m.rebuilt ?? '?'} rebuilt)` : '';
      return log.debug(`board: webview rendered ${m.cards} cards in ${m.ms}ms${script}${trip !== undefined ? `, ${trip}ms after it was posted` : ''}`);
    }
    const start = Date.now();
    try {
      await (from.side ? this.dispatchSide(m, from) : this.dispatch(m));
    } finally {
      if (m.type !== 'size' && m.type !== 'keep') log.debug(`${from.side ? 'new session view' : 'board'} message ${m.type}: ${Date.now() - start}ms`);
      if (UNATTENDED.has(m.type)) noteLatency(`board message ${m.type}`, Date.now() - start);
    }
  }

  private async dispatch(m: BoardMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.webviewLoads++;
          // A new (or reloaded) webview has nothing yet: what the box keeps for this project folder first.
          this.boardSurface.lastPosted = undefined;
          this.postToWebview({ type: 'restore', ...this.kept.restore() });
          // Without worktrees the board still shows (the composer offers main until the model finds them).
          await this.model.loadFeatures().catch((err: Error) => log.warn(`cannot list worktrees for the board: ${err.message}`));
          this.post();
          // Ask Claude for its `/` list now: it takes a few seconds, and the first `/` should not wait.
          void this.composer.commands('main');
          // A new webview (after a window reload) has lost the notice too (the trust warning shows as the session opens).
          this.ui.replay();
          if (this.pendingFocus) this.postFocus(this.pendingFocus);
          else if (this.pendingEnter) this.postEnter();
          this.pendingFocus = undefined;
          this.pendingEnter = false;
          return;
        case 'size':
          this.width = m.width;
          return;
        case 'keep': {
          const { type: _type, ...patch } = m;
          return await this.kept.keep(patch);
        }
        case 'usage': {
          // A count already running (started by an earlier click, or the Claude Usage page) shows how far it got.
          const progress = this.usageService.progress;
          if (progress) this.postToWebview({ type: 'usageProgress', progress });
          return this.postToWebview({ type: 'usage', usage: await this.usage(), limits: await planLimits() });
        }
        case 'usageScope':
          return await this.usageScope.set(m.scope); // posts the popup again (onDidChange)
        case 'usageMore':
          return void (await vscode.commands.executeCommand('devdesk.claude.showUsage'));
        case 'setupLimits':
          if (await vscode.commands.executeCommand<boolean>('devdesk.usage.installStatusLine')) await this.postUsage();
          return;
        case 'settings':
          return void (await openSettings('devdesk.board'));
        case 'toggleCardLine':
          // The board shows the change once the setting's change posts it again.
          return void (await setGlobalSetting('board.cardLine', !boardCardLine()));
        case 'sidebar':
          return void (await this.tree.focus(m.id ? this.model.find(m.id) : undefined));
        case 'openTicket':
          return void (await vscode.commands.executeCommand('devdesk.tickets.open', { sessionId: m.id }));
        case 'fixChecks': {
          const dir = this.model.find(m.id)?.featureDir;
          if (dir) await vscode.commands.executeCommand('devdesk.checks.askClaude', dir);
          return;
        }
        case 'open':
          return await this.withCard(m.id, async (card) => {
            await this.roomFor(card);
            await openSessionCard(this.tree, card);
          });
        case 'fork':
          return await this.withCard(m.id, (card) => forkSession(this.model, this.tree, card));
        case 'end':
          return await this.withCard(m.id, (card) => killSession(this.model, card));
        case 'start':
        case 'plan':
        case 'spec':
        case 'draft': {
          const how = m.type;
          return await this.withPrompt(m.id, (item) => this.start(item.id, how));
        }
        case 'edit':
          return await this.withPrompt(m.id, (item) => this.postFocus({ text: item.prompt, choice: item.choice ?? {}, editing: item.id }));
        case 'delete':
          return await this.withPrompt(m.id, (item) => this.remove(item.id, item.prompt));
        case 'compose':
          return await this.compose(m.raw, m.replaces, this.boardSurface);
        case 'complete': {
          // Where the session runs (an existing worktree, or a new one's package) comes from the worktrees.
          await this.model.loadFeatures();
          const items = await this.composer.complete(m.kind, m.query, m.where, { stacked: m.stacked });
          this.postToWebview({ type: 'completions', kind: m.kind, seq: m.seq, items });
          return;
        }
        case 'attach': {
          await this.model.loadFeatures();
          const text = await this.composer.attach(m.where);
          if (text) this.postToWebview({ type: 'insert', text });
          return;
        }
        case 'pasteImage':
          return this.postToWebview({ type: 'insert', text: await savePastedImage(m.mime, m.data) });
        case 'noticeAction':
          return await this.ui.runAction(m.id);
        case 'noticeDismissed':
          return this.ui.dismissed();
        case 'removeAddDir':
          return this.composer.removeLaunchDir(m.dir);
        case 'forgetTypedModels':
          return this.composer.forgetCustomModels();
        case 'search':
          return await this.history.runSearch(m.query);
        case 'cancelSearch':
          return this.history.cancelSearch();
        case 'historyQuery':
          return this.history.setQuery(m.query, m.seq);
        case 'resumeHistory':
          return await this.history.resume(m.id);
        case 'forkHistory':
          return await this.history.fork(m.id, !!m.inMain);
        case 'copyHistoryId':
          await vscode.env.clipboard.writeText(m.id);
          return this.ui.notice({ text: `Copied the session id ${m.id}`, tone: 'info' });
      }
    } catch (err) {
      log.warn(`board action ${m.type} failed: ${(err as Error).message}`);
      void vscode.window.showErrorMessage(`Claude Board: ${(err as Error).message}`);
    }
  }

  /**
   * What the New Session view's box sends: the prompt box's own messages (it has no lanes, search or 📊), answered in
   * that view.
   */
  private async dispatchSide(m: BoardMessage, side: Surface): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          side.lastPosted = undefined;
          side.post({ type: 'restore', ...this.kept.restore(true) });
          await this.model.loadFeatures().catch((err: Error) => log.warn(`cannot list worktrees for the New Session view: ${err.message}`));
          this.post();
          void this.composer.commands('main');
          side.ui.replay();
          return;
        case 'keep': {
          const { type: _type, ...patch } = m;
          return await this.kept.keep(patch, true);
        }
        case 'settings':
          return void (await openSettings('devdesk.board'));
        case 'sidebar':
          return void (await this.tree.focus(m.id ? this.model.find(m.id) : undefined));
        case 'compose':
          return await this.compose(m.raw, undefined, side);
        case 'complete': {
          await this.model.loadFeatures();
          const items = await this.composer.complete(m.kind, m.query, m.where, { stacked: m.stacked });
          return side.post({ type: 'completions', kind: m.kind, seq: m.seq, items });
        }
        case 'attach': {
          await this.model.loadFeatures();
          const text = await this.composer.attach(m.where);
          if (text) side.post({ type: 'insert', text });
          return;
        }
        case 'pasteImage':
          return side.post({ type: 'insert', text: await savePastedImage(m.mime, m.data) });
        case 'noticeAction':
          return await side.ui.runAction(m.id);
        case 'noticeDismissed':
          return side.ui.dismissed();
        case 'removeAddDir':
          return this.composer.removeLaunchDir(m.dir);
        case 'forgetTypedModels':
          return this.composer.forgetCustomModels();
        default:
          // The board's lanes, search and 📊 are not in this view.
          return;
      }
    } catch (err) {
      log.warn(`New Session view action ${m.type} failed: ${(err as Error).message}`);
      void vscode.window.showErrorMessage(`New Claude Session: ${(err as Error).message}`);
    }
  }

  /** Runs `fn` on the board's card `id`, if it is still there. */
  private async withCard(id: string, fn: (card: SessionCard) => Promise<unknown>): Promise<void> {
    const card = this.model.find(id);
    if (card) await fn(card);
  }

  /** Runs `fn` on prompt for later `id`, if it is still there and not being started. */
  private async withPrompt(id: string, fn: (item: BacklogItem) => unknown): Promise<void> {
    const item = this.backlog.find(id);
    if (item && !this.starting.has(item.id)) await fn(item);
  }

  /**
   * Runs the composed text (`BoardComposer.submit`: a session, or what its command does), or saves it for later; tells
   * the webview whether to clear the box.
   */
  private async compose(raw: unknown, replaces: string | undefined, from: Surface): Promise<void> {
    // The webview sends one at a time (it waits for `composed`); another one meanwhile is dropped.
    if (from.composing) return;
    from.composing = true;
    const ui = from.ui;
    let outcome: SubmitOutcome = { clear: true };
    let error: string | undefined;
    try {
      await this.model.loadFeatures();
      // The box's model may be one of the CLI's rows, not listed yet (a reload, or the CLI's settings changed).
      const model = (raw as { model?: unknown } | undefined)?.model;
      await this.composer.modelsListed(typeof model === 'string' ? model : undefined);
      const allowed = this.composer.allowed();
      const request = parseCompose(raw, allowed);
      const missing = missingWorktree(raw, allowed);
      if (!request) error = 'Type a prompt first.';
      else if (missing) error = `The worktree ${missing} is not there any more: pick where it starts.`;
      else {
        const { prompt, later, ...choice } = request;
        const edited = replaces ? this.backlog.find(replaces) : undefined;
        // Saving an edited prompt for later keeps its place; running it (a session started, a command sent or done)
        // removes it, as a card's Start does.
        if (later && edited) await this.backlog.update(edited.id, prompt, choice);
        else if (later) await this.backlog.add(prompt, choice);
        else {
          ui.clearNotice();
          outcome = await this.composer.submit(prompt, choice, edited ? this.backlogUi(edited.id, { fromBox: true }, ui) : ui);
          if (edited && ranOutcome(outcome)) await this.backlog.remove(edited.id);
        }
      }
    } catch (err) {
      error = (err as Error).message;
      log.warn(`board compose failed: ${error}`);
    } finally {
      from.composing = false;
    }
    ui.composed(error ? { clear: false, error } : outcome);
  }

  /**
   * `devdesk.board.addTask`: with text (a string, or `{ title, notes? }` from before prompts), saves it as a prompt for
   * later; without, opens the board with the composer focused in Save for later.
   */
  async addTask(arg?: unknown): Promise<void> {
    const o = arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : undefined;
    const text = legacyPrompt(typeof arg === 'string' ? arg : o?.title, o?.notes);
    if (text) {
      await this.backlog.add(text);
      return;
    }
    if (!workspaceRoot()) {
      void vscode.window.showInformationMessage(NO_FOLDER);
      return;
    }
    const focus = { later: true };
    if (this.panel) this.postFocus(focus);
    else this.pendingFocus = focus;
    this.open();
  }

  private async remove(id: string, prompt: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(`Delete the prompt "${truncate(prompt.split('\n')[0], 60)}"?`, { modal: true }, 'Delete');
    if (choice === 'Delete') await this.backlog.remove(id);
  }

  /** Starts a prompt for later; it leaves the lane once the session started. Re-read first: another window may have started it. */
  private async start(id: string, how: StartHow): Promise<void> {
    this.starting.add(id);
    this.schedulePost();
    try {
      await this.model.loadFeatures();
      await this.backlog.reload();
      const item = this.backlog.find(id);
      if (item && (await this.composer.startSaved(item, how, this.backlogUi(id, { fromBox: false })))) await this.backlog.remove(id);
    } finally {
      this.starting.delete(id);
      this.schedulePost();
    }
  }

  /**
   * The box for the handlers of prompt for later `id`: a notice button that runs later (Send as text anyway, Try again)
   * takes the prompt out of the lane once it ran (`ranOutcome`), and empties the box only when the box held the prompt
   * (`fromBox`; a card's Start leaves what is typed in the box alone).
   */
  private backlogUi(id: string, how: { fromBox: boolean }, ui = this.ui): BoardUi {
    return {
      notice: (notice) =>
        ui.notice({
          ...notice,
          actions: notice.actions?.map((action) => ({
            label: action.label,
            run: async () => {
              const outcome = await action.run();
              if (outcome && ranOutcome(outcome)) await this.backlog.remove(id);
              return outcome && !how.fromBox ? { ...outcome, clear: false } : outcome;
            },
          })),
        }),
      clearNotice: () => ui.clearNotice(),
      setChoice: (patch) => ui.setChoice(patch),
      openPicker: (picker) => ui.openPicker(picker),
      clearBox: (started) => ui.clearBox(started),
    };
  }

  /** Before a session's terminal opens from the board: room beside it, unless a terminal is already open for it. */
  private async roomFor(card: SessionCard | undefined): Promise<void> {
    // A terminal already open for it shows where it is.
    if (card && (await liveCardTerminal(card))) return;
    await this.makeRoomBeside();
  }

  /**
   * Before a session's terminal opens from the board: when the board has the editor area to itself and no Claude
   * terminal is open in an editor group, and the area is wide enough (`devdesk.board.sessionsBeside`), splits it: the
   * full board (every lane `devdesk.board.laneWidth` wide) on the left, the rest for the terminal on the right, which
   * becomes the active group so the terminal opens there. Later ones open where it is.
   */
  private async makeRoomBeside(): Promise<boolean> {
    const groups = vscode.window.tabGroups.all;
    if (!this.panel?.visible || groups.length !== 1 || groups[0].tabs.some(isClaudeTerminalTab)) return false;
    const board = besideBoardWidth(this.width, boardSessionsBeside(), boardLaneWidth());
    if (board === undefined) return false;
    log.info(`opening the session beside the Claude Board: board ${board}px of ${Math.round(this.width)}px`);
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: board }, { size: this.width - board }] });
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    return true;
  }

  /** The 📊 popover again, for the window's scope now (the webview shows it only while its popup is open). */
  private async postUsage(): Promise<void> {
    if (!this.panel) return;
    this.postToWebview({ type: 'usage', usage: await this.usage(), limits: await planLimits() });
  }

  /**
   * The 📊 popover for the window's usage scope (or `scope`, for the tests), with the projects to choose from: tokens
   * used today, this week and in the last 30 days, by Claude sessions and (for all projects) by DevDesk's insights.
   */
  private async usage(scope?: UsageScope): Promise<ScopedPopover> {
    const { days, today } = await this.usageService.snapshot();
    return scopedPopover(days, today, scope ?? this.usageScope.get(), this.usageScope.windowPlace());
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.subscriptions) d.dispose();
    this.hold.set(false);
  }
}
