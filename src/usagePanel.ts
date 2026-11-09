import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { openSettings } from './config';
import { dayKey } from './core/usageHistory';
import { parseScope, type ScopedPage, scopedPage, type UsageScope } from './core/usageScope';
import type { UsageScopeState } from './usageScopeState';
import { log } from './log';
import type { CountProgress, UsageService } from './usageService';

const USAGE_VIEW_TYPE = 'devdesk.claude.usage';
const TITLE = 'Claude Usage';

/**
 * The stats page (📊 → More…): tokens by day, week and month, with charts, by model and by session, from the usage
 * history. One editor tab; opening it again reveals it and counts again.
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
    const panel = vscode.window.createWebviewPanel(USAGE_VIEW_TYPE, TITLE, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'claude.svg');
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
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

  private async receive(m: unknown): Promise<void> {
    const type = m && typeof m === 'object' ? (m as { type?: unknown }).type : undefined;
    if (type === 'ready' || type === 'refresh') {
      // A count already running (from the board's 📊, or before a reload of the page) shows how far it got.
      const progress = this.service.progress;
      if (progress) await this.progressed({ ...progress, stored: this.service.stored });
      return this.post();
    }
    if (type === 'settings') {
      await openSettings('devdesk.usage');
      return;
    }
    if (type === 'setScope') {
      const scope = parseScope((m as { scope?: unknown }).scope);
      if (scope) await this.scope.set(scope); // posts the page again (onDidChange)
    }
  }

  /** How far the count has got, with the days it stored so far as a page shown until the count ends. */
  private async progressed({ stored, ...progress }: CountProgress): Promise<void> {
    const webview = this.panel?.webview;
    if (!webview) return;
    if (stored?.days.length) {
      await webview.postMessage({ type: 'partial', page: scopedPage(stored.days, dayKey(Date.now()), stored.history, this.scope.get(), this.scope.windowPlace()), progress });
    } else {
      await webview.postMessage({ type: 'progress', progress });
    }
  }

  private async post(): Promise<void> {
    try {
      const page = await this.data();
      await this.panel?.webview.postMessage({ type: 'page', page });
    } catch (err) {
      log.warn(`cannot count token usage: ${(err as Error).message}`);
      await this.panel?.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('usage.css')}">
<title>${TITLE}</title>
</head>
<body>
<header class="bar">
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
<main id="main" aria-live="polite"><p class="muted">Counting tokens…</p></main>
<script nonce="${nonce}" src="${media('usage.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
