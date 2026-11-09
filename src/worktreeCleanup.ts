import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { gitRunner } from './core/git';
import { createPriorityLimiter } from './core/limit';
import type { SessionCard } from './core/sessions';
import { type CleanupFacts, cleanupVerdict, type CleanupVerdict, isLockedWorktree, packageFacts } from './core/worktreeCleanup';
import { deletePlan, deleteWorktree } from './core/worktreeDelete';
import { failureSummary } from './core/worktreeTasks';
import { workspaceProvider } from './core/workspaceProvider';
import { discoverFeatures, type Feature } from './core/worktrees';
import { featureDiscovery, workspaceRoot, worktreesCleanup, worktreesDeleteCommand, worktreesGitTimeoutMs } from './config';
import { log } from './log';
import type { SessionsModel } from './sessionsModel';
import { forgetWorktreeSessions, inFeature, sessionsOf } from './worktreeDelete';

interface Checked {
  facts: CleanupFacts;
  verdict: CleanupVerdict;
  cards: SessionCard[];
}

const live = (c: SessionCard) => c.state !== 'parked' && c.state !== 'stopped';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function check(feature: Feature, cards: readonly SessionCard[], now: number): Promise<Checked> {
  const settings = worktreesCleanup();
  const run = gitRunner(worktreesGitTimeoutMs());
  const own = sessionsOf(cards, feature);
  const packages = feature.isMain ? [] : await Promise.all(feature.packages.map((p) => packageFacts(run, p, settings.baseBranches)));
  const facts: CleanupFacts = {
    feature,
    packages,
    locked: [feature.dir, ...feature.packages.map((p) => p.dir)].some(isLockedWorktree),
    liveSessions: own.filter(live).length,
    openHere: (vscode.workspace.workspaceFolders ?? []).some((f) => inFeature(f.uri.fsPath, feature)),
  };
  return { facts, verdict: cleanupVerdict(facts, now, settings.idleDays), cards: own };
}

/** Checks every worktree of the workspace (4 at a time), main left out. */
async function checkAll(model: SessionsModel, root: string): Promise<Checked[]> {
  const [features, cards] = await Promise.all([discoverFeatures(root, featureDiscovery()), model.fresh()]);
  const limit = createPriorityLimiter(4);
  const now = Date.now();
  return Promise.all(features.filter((f) => !f.isMain && deletePlan(root, f)).map((f) => limit(() => check(f, cards, now)).promise));
}

/** The worktrees ready to clean up, for the suggestion; none without a workspace. */
export async function cleanupCandidates(model: SessionsModel): Promise<Feature[]> {
  const root = workspaceRoot();
  if (!root) return [];
  return (await checkAll(model, root)).filter((c) => c.verdict.candidate).map((c) => c.facts.feature);
}

/** Deletes one checked worktree: its folder, then (with `devdesk.worktrees.cleanupDeleteBranch`) a git worktree's branch, then its sessions' records. */
async function removeOne(model: SessionsModel, root: string, c: Checked): Promise<string | undefined> {
  const { feature } = c.facts;
  const plan = deletePlan(root, feature);
  if (!plan) return 'cannot be deleted';
  const result = await deleteWorktree(plan, { force: false, command: worktreesDeleteCommand() });
  if (result.output.trim()) log.info(`clean up worktree ${feature.name}: ${result.output.trim()}`);
  if (existsSync(feature.dir)) return failureSummary(result.output) || 'the command failed';
  const branch = c.facts.packages[0]?.branch;
  if (plan.kind === 'git' && branch && worktreesCleanup().deleteBranch) {
    // Every commit of it is in a base branch (checked just before), so -D loses nothing.
    const out = await gitRunner(worktreesGitTimeoutMs())(['branch', '-D', branch], plan.repo).catch((err: Error) => err.message);
    log.info(`clean up worktree ${feature.name}: git branch -D ${branch}: ${out.trim()}`);
  }
  await forgetWorktreeSessions(model, feature, c.cards);
  return undefined;
}

/**
 * Clean Up Worktrees: lists the worktrees that are finished (no uncommitted changes, every commit in a base branch, no
 * live Claude session, not locked, idle for `devdesk.worktrees.cleanupIdleDays`), all checked, with why; deletes the
 * ones you keep checked, after checking each again. True when it deleted any.
 */
export async function cleanUpWorktrees(model: SessionsModel): Promise<boolean> {
  // A second run would list (and delete) the same worktrees while the first one is still at it.
  if (cleaning) return false;
  cleaning = true;
  try {
    return await cleanUp(model);
  } finally {
    cleaning = false;
  }
}

let cleaning = false;

async function cleanUp(model: SessionsModel): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) return false;
  const checked = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking worktrees…' }, () => checkAll(model, root));
  const ready = checked.filter((c) => c.verdict.candidate);
  const kept = checked.length - ready.length;
  if (!ready.length) {
    void vscode.window.showInformationMessage(
      checked.length
        ? `No worktree is ready to clean up: ${plural(kept, 'worktree')} kept (uncommitted or unmerged work, live sessions, locked or recently active).`
        : 'This workspace has no worktrees.',
    );
    return false;
  }
  type Item = vscode.QuickPickItem & { c: Checked };
  const items: Item[] = ready.map((c) => ({ label: c.facts.feature.name, description: c.verdict.reason, detail: c.facts.feature.dir, picked: true, c }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Clean Up Worktrees: ${plural(ready.length, 'worktree')} ready${kept ? `, ${kept} kept` : ''}`,
    placeHolder: 'Uncheck the ones to keep, then press Enter to delete the others',
    matchOnDescription: true,
  });
  if (!picked?.length) return false;
  const branches = worktreesCleanup().deleteBranch ? ' and their branches' : '';
  const sessions = picked.reduce((n, i) => n + i.c.cards.length, 0);
  const choice = await vscode.window.showWarningMessage(
    `Delete ${plural(picked.length, 'worktree')}${branches}?`,
    {
      modal: true,
      detail: [
        picked.map((i) => i.label).join(', '),
        `Each is deleted like Delete Worktree does (${workspaceProvider ? `${workspaceProvider.deleteDescription} or ` : ''}git worktree remove${branches ? ' and git branch -D' : ', its branch stays'}).`,
        sessions ? `Their ${plural(sessions, 'parked or stopped Claude session')} leave the list. Conversations stay on disk (claude --resume <id>).` : '',
      ].filter(Boolean).join('\n\n'),
    },
    'Delete',
  );
  if (choice !== 'Delete') return false;

  const failed: string[] = [];
  let deleted = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Cleaning up worktrees', cancellable: true }, async (progress, token) => {
    const cards = await model.fresh();
    for (const [i, item] of picked.entries()) {
      if (token.isCancellationRequested) break;
      progress.report({ message: `${item.label} (${i + 1}/${picked.length})`, increment: 100 / picked.length });
      // Something may have changed since the list: a new session, a commit, an edit.
      const again = await check(item.c.facts.feature, cards, Date.now());
      if (!again.verdict.candidate) {
        failed.push(`${item.label}: ${again.verdict.reason}`);
        continue;
      }
      const error = await removeOne(model, root, again);
      if (error) failed.push(`${item.label}: ${error}`);
      else deleted++;
    }
  });
  log.info(`cleaned up ${deleted} worktrees${failed.length ? `; kept ${failed.join('; ')}` : ''}`);
  if (failed.length) void vscode.window.showWarningMessage(`Deleted ${plural(deleted, 'worktree')}. Kept ${failed.length}: ${failed.join('; ')}`);
  else void vscode.window.showInformationMessage(`Deleted ${plural(deleted, 'worktree')}.`);
  return deleted > 0;
}

/**
 * Once per window, a while after it opens: when at least `devdesk.worktrees.cleanupSuggestCount` worktrees are ready
 * to clean up, offers Clean Up Worktrees. It never deletes on its own.
 */
export function suggestCleanup(model: SessionsModel, delayMs = 120_000): vscode.Disposable {
  const timer = setTimeout(() => {
    const { suggestCount } = worktreesCleanup();
    if (!suggestCount) return;
    void cleanupCandidates(model)
      .then(async (ready) => {
        if (ready.length < suggestCount) return;
        const choice = await vscode.window.showInformationMessage(
          `${plural(ready.length, 'worktree')} look finished: merged, no uncommitted changes, idle. Clean them up?`,
          'Review…',
          'Not Now',
        );
        if (choice === 'Review…') await vscode.commands.executeCommand('devdesk.worktrees.cleanUp');
      })
      .catch((err: Error) => log.warn(`cannot check worktrees for clean up: ${err.message}`));
  }, delayMs);
  return { dispose: () => clearTimeout(timer) };
}
