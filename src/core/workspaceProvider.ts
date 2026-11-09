import type { WorkspaceProvider } from './workspaceKind';

/** The package workspace kind DevDesk knows besides git repositories: none, so it works with git repositories and plain folders. */
export const workspaceProvider: WorkspaceProvider | undefined = undefined;
