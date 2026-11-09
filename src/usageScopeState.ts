import * as vscode from 'vscode';
import { usageDefaultScope, workspaceRoot } from './config';
import { type Place, placeOf } from './core/usagePlace';
import { parseScope, resolveScope, type UsageScope } from './core/usageScope';

const KEY = 'devdesk.usage.scope';

/**
 * The project (or worktree) whose token usage this window shows, shared by the board's 📊 popup and the Claude Usage
 * page and kept in the window's workspace state. Until one is chosen: `devdesk.usage.defaultScope`.
 */
export class UsageScopeState implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private cached: { root: string; place: Place } | undefined;
  private readonly settings: vscode.Disposable;

  constructor(private readonly memento: vscode.Memento) {
    // A new default changes what a window with no chosen scope shows: the popup and the page follow it at once.
    this.settings = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devdesk.usage.defaultScope') && !parseScope(this.memento.get(KEY))) this.changed.fire();
    });
  }

  /**
   * This window's project as usage places name it (its root classified like a session's folder); none with no folder
   * open. Classified once per root: a folder that becomes a git repository or a package workspace while the window is
   * open stays the folder project until a reload, like the usage days already stored under the old name.
   */
  windowPlace(): Place | undefined {
    const root = workspaceRoot();
    if (!root) return undefined;
    if (this.cached?.root !== root) this.cached = { root, place: placeOf(root) };
    return this.cached.place;
  }

  get(): UsageScope {
    return resolveScope(parseScope(this.memento.get(KEY)), usageDefaultScope(), this.windowPlace());
  }

  async set(scope: UsageScope): Promise<void> {
    await this.memento.update(KEY, scope);
    this.changed.fire();
  }

  /** Forgets the chosen scope, so the window shows `devdesk.usage.defaultScope` again (for the e2e tests). */
  async clear(): Promise<void> {
    await this.memento.update(KEY, undefined);
    this.changed.fire();
  }

  dispose(): void {
    this.settings.dispose();
    this.changed.dispose();
  }
}
