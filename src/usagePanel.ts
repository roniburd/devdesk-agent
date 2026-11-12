import * as vscode from 'vscode';
import { openSettings } from './config';
import { dayKey } from './core/usageHistory';
import { type ScopedPage, scopedPage, type UsageScope } from './core/usageScope';
import { parseUsageMessage, type UsageHostMessage } from './usage/messages';
import type { UsageScopeState } from './usageScopeState';
import { log } from './log';
import { planLimits } from './planLimits';
import type { CountProgress, UsageService } from './usageService';
import { webviewOptions, webviewPage } from './webviewPage';

const USAGE_VIEW_TYPE = 'devdesk.claude.usage';
const TITLE = 'Claude Usage';

/**
 * The stats page (📊 → More…): tokens by day, week and month, with charts, by model and by session, from the usage
 * history, under Claude's plan limits (as in the 📊 popup). One editor tab; opening it again reveals it and counts again.
 */
export class UsagePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: UsageService,
    private readonly scope: UsageScopeState,
  ) {}

  get isOpen(): boolean {
    return !!this.panel;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      void this.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel(USAGE_VIEW_TYPE, TITLE, vscode.ViewColumn.Active, webviewOptions(this.extensionUri));
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'claude.svg');
    this.panel = panel;
    panel.webview.html = webviewPage(panel.webview, this.extensionUri, { css: 'usage.css', js: 'usage.js', title: TITLE, body: BODY });
    this.subscriptions = [
      panel.onDidDispose(() => {
        this.panel = undefined;
        for (const s of this.subscriptions) s.dispose();
        this.subscriptions = [];
      }),
      panel.webview.onDidReceiveMessage((m: unknown) => void this.receive(m)),
      panel.onDidChangeViewState((e) => e.webviewPanel.visible && void this.post()),
      this.service.onProgress((progress) => void this.progressed(progress)),
      // A project chosen here or in the board's 📊 popup: the page shows it.
      this.scope.onDidChange(() => void this.post()),
    ];
  }

  /** Counts again and shows it (a settings change, or the page's refresh). */
  refresh(): void {
    if (this.panel) void this.post();
  }

  /** What the page shows, for the window's usage scope (also for the e2e tests: `scope` instead of the window's). */
  async data(scope?: UsageScope): Promise<ScopedPage> {
    const { days, today, history } = await this.service.snapshot();
    return scopedPage(days, today, history, scope ?? this.scope.get(), this.scope.windowPlace());
  }

  private async receive(raw: unknown): Promise<void> {
    const m = parseUsageMessage(raw);
    if (!m) return;
    if (m.type === 'ready' || m.type === 'refresh') {
      // A count already running (from the board's 📊, or before a reload of the page) shows how far it got.
      const progress = this.service.progress;
      if (progress) await this.progressed({ ...progress, stored: this.service.stored });
      return this.post();
    }
    if (m.type === 'settings') {
      await openSettings('devdesk.usage');
      return;
    }
    if (m.type === 'setupLimits') {
      // Installs DevDesk's status line, which records the plan limits, then shows them (or that none came yet).
      if (await vscode.commands.executeCommand<boolean>('devdesk.usage.installStatusLine')) await this.post();
      return;
    }
    await this.scope.set(m.scope); // posts the page again (onDidChange)
  }

  /** Posts `m` to the page, if it is open. */
  private async postToPage(m: UsageHostMessage): Promise<void> {
    await this.panel?.webview.postMessage(m);
  }

  /** How far the count has got, with the days it stored so far as a page shown until the count ends. */
  private async progressed({ stored, ...progress }: CountProgress): Promise<void> {
    if (!this.panel) return;
    if (stored?.days.length) {
      await this.postToPage({ type: 'partial', page: scopedPage(stored.days, dayKey(Date.now()), stored.history, this.scope.get(), this.scope.windowPlace()), progress });
    } else {
      await this.postToPage({ type: 'progress', progress });
    }
  }

  private async post(): Promise<void> {
    try {
      const page = await this.data();
      // Claude's 5-hour and weekly limits, as the board's 📊 popup shows them (none with devdesk.usage.planLimits off).
      const limits = await planLimits();
      await this.postToPage({ type: 'page', page, limits });
    } catch (err) {
      log.warn(`cannot count token usage: ${(err as Error).message}`);
      await this.postToPage({ type: 'error', message: (err as Error).message });
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/** The page's markup (the tests load it from here, see `test/webviewBody.ts`). */
const BODY = `<header class="bar">
  <h1>${TITLE}</h1>
  <div class="units" role="radiogroup" aria-label="Group by">
    <button role="radio" data-unit="day" aria-checked="true">Day</button>
    <button role="radio" data-unit="week" aria-checked="false">Week</button>
    <button role="radio" data-unit="month" aria-checked="false">Month</button>
  </div>
  <div class="scope">
    <select id="scope-project" aria-label="Project" hidden></select>
    <select id="scope-worktree" aria-label="Worktree" hidden></select>
  </div>
  <span class="spacer"></span>
  <button class="ghost" id="refresh" title="Count again" aria-label="Count again">↻</button>
  <button class="ghost" id="settings" title="Usage history settings" aria-label="Usage history settings">⚙</button>
</header>
<main id="main" aria-live="polite"><p class="muted">Counting tokens…</p></main>`;
