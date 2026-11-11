import * as vscode from 'vscode';
import { type WebPanelAction, type WebPanelRow, webPanelRows } from './core/web/panel';
import type { WebStatus } from './core/web/webState';
import { log } from './log';
import type { WebAccess } from './webAccess';

/**
 * The Web Access view (`devdesk.web`): whether the daemon runs, its URLs, tunnel, who may use it, and which version
 * started it, with Start, Restart, Stop and Settings in its title bar. It redraws on each WebAccess refresh (web.json
 * changes, and every 10 s), and only reads the daemon's details while it is visible.
 */

const COMMAND: Record<WebPanelAction, string> = {
  start: 'devdesk.web.start',
  restart: 'devdesk.web.restart',
  restartTunnel: 'devdesk.web.restartTunnel',
  copyUrl: 'devdesk.web.copyUrl',
  copyLocal: 'devdesk.web.copyLocalUrl',
  openLog: 'devdesk.web.openLog',
  settings: 'devdesk.web.openSettings',
};

class WebAccessTree implements vscode.TreeDataProvider<WebPanelRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  rows: WebPanelRow[] = [];

  set(rows: WebPanelRow[]): void {
    if (JSON.stringify(rows) === JSON.stringify(this.rows)) return;
    this.rows = rows;
    this.emitter.fire();
  }

  getChildren(row?: WebPanelRow): WebPanelRow[] {
    return row ? [] : this.rows;
  }

  getTreeItem(row: WebPanelRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon, row.color ? new vscode.ThemeColor(row.color) : undefined);
    item.contextValue = row.contextValue;
    if (row.action) item.command = { command: COMMAND[row.action], title: row.label };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Creates the view; `rows()` gives what it shows (for the e2e tests: it draws only while visible). */
export function registerWebAccessView(ctx: vscode.ExtensionContext, web: WebAccess): { rows: () => WebPanelRow[]; view: vscode.TreeView<WebPanelRow>; drawn: () => Promise<void> } {
  const tree = new WebAccessTree();
  const view = vscode.window.createTreeView('devdesk.web', { treeDataProvider: tree });
  let drawing = Promise.resolve();
  const draw = (status: WebStatus) => {
    void vscode.commands.executeCommand('setContext', 'devdesk.web.running', status.kind !== 'off');
    if (!view.visible) return;
    drawing = drawing
      .then(async () => {
        const details = await web.details(status);
        tree.set(webPanelRows({ status, ...details, script: web.script, now: Date.now() }));
        view.description = status.kind === 'off' ? 'off' : status.kind === 'tunnel-down' ? 'tunnel down' : 'on';
      })
      .catch((err) => log.warn(`web access view: ${(err as Error).message}`));
  };
  ctx.subscriptions.push(
    tree,
    view,
    web.onDidRefresh(draw),
    view.onDidChangeVisibility(() => view.visible && void web.refresh()),
  );
  void web.refresh();
  return { rows: () => tree.rows, view, drawn: () => drawing };
}
