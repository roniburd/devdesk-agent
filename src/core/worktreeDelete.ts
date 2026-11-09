import { join } from 'node:path';
import { type CommandResult, runCommand } from './shellRun';
import { gitRootFor, isGitWorkspace, type Feature } from './worktrees';

/**
 * How a worktree row is deleted: a package workspace's (`<root>/worktrees/<name>`) by `devdesk.worktrees.deleteCommand`,
 * any other (a git repository's linked worktree, a package's Claude Code worktree) by `git worktree remove`, run in its
 * main repository. The workspace root (`main`) is never deleted.
 */
export type DeletePlan = { kind: 'workspace'; root: string; name: string; dir: string } | { kind: 'git'; repo: string; dir: string };

export function deletePlan(root: string, feature: Feature): DeletePlan | undefined {
  if (feature.isMain || feature.dir === root) return undefined;
  if (!isGitWorkspace(root) && feature.dir === join(root, 'worktrees', feature.name)) {
    return { kind: 'workspace', root, name: feature.name, dir: feature.dir };
  }
  const repo = gitRootFor(feature.dir);
  if (!repo || repo === feature.dir) return undefined;
  return { kind: 'git', repo, dir: feature.dir };
}

export type DeleteResult = CommandResult;

/**
 * Deletes the worktree: a package workspace's with `command` (`/bin/sh -c` in the workspace root, with `$DEVDESK_WORKTREE`,
 * `$DEVDESK_WORKTREE_DIR` and `$DEVDESK_FORCE`, `--force` or empty), a git one with `git worktree remove [--force]`.
 * Without `force`, git (and usually the workspace's command) refuse a worktree with uncommitted changes.
 */
export function deleteWorktree(plan: DeletePlan, opts: { force: boolean; command?: string; timeoutMs?: number }): Promise<DeleteResult> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const run = (file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => runCommand(file, args, { cwd, env, timeoutMs: timeout });
  if (plan.kind === 'workspace') {
    return run('/bin/sh', ['-c', opts.command ?? ''], plan.root, {
      DEVDESK_WORKTREE: plan.name,
      DEVDESK_WORKTREE_DIR: plan.dir,
      DEVDESK_FORCE: opts.force ? '--force' : '',
    });
  }
  return run('git', ['worktree', 'remove', ...(opts.force ? ['--force'] : []), plan.dir], plan.repo);
}
