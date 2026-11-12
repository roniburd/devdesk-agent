import type { ChecksProvider } from './checks';
import type { TicketProvider } from './tickets';
import type { WebProviderDefaults } from './web/config';

/**
 * A kind of package workspace, beyond plain git repositories: a root holding git packages under `<root>/src/<package>`
 * and its own worktrees under `<root>/worktrees/<name>`, made and deleted by shell commands. Which kind DevDesk knows
 * (if any) is set in `workspaceProvider.ts`; without one, DevDesk works with git repositories and plain folders only.
 * No `vscode`: it runs in the usage worker too.
 */
export interface WorkspaceProvider {
  /** The kind's name, as the usage views and messages show it (`<label> workspace`). */
  readonly label: string;
  /** True when `dir` is such a workspace's root or one of its worktrees (or looks like one). */
  isWorkspace(dir: string): boolean;
  /** `devdesk.worktrees.createCommand` when empty: makes `<root>/worktrees/$DEVDESK_WORKTREE`, run in the root. */
  readonly defaultCreateCommand: string;
  /** `devdesk.worktrees.deleteCommand` when empty: deletes worktree `$DEVDESK_WORKTREE` (`$DEVDESK_FORCE`), run in the root. */
  readonly defaultDeleteCommand: string;
  /** How the delete confirmation describes deleting one of its worktrees. */
  readonly deleteDescription: string;
  /** Where the change requests and checks of its packages come from, besides GitHub (see `checks.ts`). */
  readonly checks?: ChecksProvider;
  /** Issue trackers DevDesk links tickets of, besides the public ones (see `tickets.ts`), asked before them. */
  readonly tickets?: readonly TicketProvider[];
  /** Web access defaults: the tunnel command used when `devdesk.web.tunnelCommand` is empty, and the identity header its proxy sets. */
  readonly web?: WebProviderDefaults;
}
