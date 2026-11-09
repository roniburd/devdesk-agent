import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { endedDir, removeEndedRecord } from './core/ended';
import type { SessionCard } from './core/sessions';
import { sessionName } from './core/tmux';
import { deletePlan, deleteWorktree } from './core/worktreeDelete';
import { failureSummary } from './core/worktreeTasks';
import { isWithin } from './core/paths';
import { type Feature, featureDirs } from './core/worktrees';
import { endTmuxSession } from './claudeSessions';
import { sessionsStateDir, workspaceRoot, worktreesDeleteCommand } from './config';
import type { FeatureNode } from './featuresTree';
import { workspaceProvider } from './core/workspaceProvider';
import { log } from './log';
import type { SessionsModel } from './sessionsModel';

const inFeature = (path: string | undefined, f: Feature) => !!path && featureDirs(f).some((d) => isWithin(path, d));

/** The Claude sessions of the worktree: running, stopped or parked, the ones DevDesk lists for it. */
function sessionsOf(cards: readonly SessionCard[], feature: Feature): SessionCard[] {
  return cards.filter((c) => c.featureDir === feature.dir || inFeature(c.cwd, feature));
}

/**
 * Deletes a worktree row of the Worktrees view, after asking: ends its Claude sessions (their tmux sessions), deletes
 * the folder (`devdesk.worktrees.deleteCommand` for a package workspace's, `git worktree remove` for a git worktree) and removes its sessions from the
 * Claude view. Their conversations stay in Claude Code's transcripts. With uncommitted changes, asks again to force it.
 * True when the worktree is gone.
 */
export async function deleteWorktreeRow(model: SessionsModel, node: FeatureNode | undefined): Promise<boolean> {
  const feature = node?.kind === 'feature' ? node.feature : undefined;
  const root = workspaceRoot();
  const plan = feature && root ? deletePlan(root, feature) : undefined;
  if (!feature || !plan) {
    if (feature) void vscode.window.showInformationMessage(`${feature.name} is the workspace itself, not a worktree: it cannot be deleted here.`);
    return false;
  }
  if ((vscode.workspace.workspaceFolders ?? []).some((f) => inFeature(f.uri.fsPath, feature))) {
    void vscode.window.showWarningMessage(`This window has a folder of worktree ${feature.name} open. Delete it from a window opened on the workspace.`);
    return false;
  }
  const cards = sessionsOf(await model.fresh(), feature);
  const running = cards.filter((c) => c.state !== 'parked' && c.tmuxSession);
  const outside = cards.filter((c) => c.state !== 'parked' && !c.tmuxSession);
  const sessionsLine = cards.length
    ? `Its ${cards.length} Claude session${cards.length === 1 ? '' : 's'} leave${cards.length === 1 ? 's' : ''} the list` +
      (running.length ? `; ${running.length} running ${running.length === 1 ? 'is' : 'are'} ended` : '') +
      '. Conversations stay on disk (claude --resume <id>).'
    : 'It has no Claude sessions.';
  const how = plan.kind === 'workspace' ? (workspaceProvider?.deleteDescription ?? 'devdesk.worktrees.deleteCommand') : 'git worktree remove (its branch stays)';
  const choice = await vscode.window.showWarningMessage(
    `Delete worktree "${feature.name}"?`,
    {
      modal: true,
      detail: [
        `Deletes ${feature.dir} with ${how}.`,
        sessionsLine,
        outside.length ? `${outside.length} session${outside.length === 1 ? ' runs' : 's run'} outside tmux: stop ${outside.length === 1 ? 'it' : 'them'} yourself.` : '',
      ].filter(Boolean).join('\n\n'),
    },
    'Delete',
  );
  if (choice !== 'Delete') return false;

  log.info(`deleting worktree ${feature.name} (${feature.dir}): ${cards.length} sessions`);
  const run = (force: boolean) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deleting worktree ${feature.name}…` }, () =>
      deleteWorktree(plan, { force, command: worktreesDeleteCommand() }),
    );
  let result = await run(false);
  if (result.output.trim()) log.info(`delete worktree ${feature.name}: ${result.output.trim()}`);
  if (!result.ok && existsSync(feature.dir)) {
    const force = await vscode.window.showWarningMessage(
      `Worktree "${feature.name}" was not deleted.`,
      { modal: true, detail: `${failureSummary(result.output) || 'The command failed.'}\n\nForce Delete discards its uncommitted changes.` },
      'Force Delete',
    );
    if (force !== 'Force Delete') return false;
    result = await run(true);
    if (result.output.trim()) log.info(`force delete worktree ${feature.name}: ${result.output.trim()}`);
  }
  const gone = !existsSync(feature.dir);
  if (!gone) {
    void vscode.window.showErrorMessage(`Could not delete worktree ${feature.name}: ${failureSummary(result.output) || 'the command failed'} (full output in the DevDesk log)`);
    return false;
  }
  // Only once the folder is gone: a refusal (uncommitted changes, Force Delete cancelled) leaves its sessions running.
  const tmux: [string, string | undefined][] = [[sessionName(feature), undefined], ...cards.flatMap((c): [string, string | undefined][] => (c.tmuxSession ? [[c.tmuxSession, c.tmuxServer]] : []))];
  await Promise.all(tmux.map(([name, server]) => endTmuxSession(name, server).catch(() => undefined)));

  // Their tmux sessions are gone, so they would be listed as parked or stopped: forget them (their folder is gone too).
  const ended = endedDir(sessionsStateDir());
  const forget = () => Promise.all(cards.map((c) => (c.sessionId ? removeEndedRecord(ended, c.sessionId) : undefined)));
  await forget();
  model.rediscover();
  await model.refresh();
  // A session's hook may write its ended record a moment after its tmux session ends.
  setTimeout(() => void forget().then(() => model.refresh()), 3000);
  return true;
}
