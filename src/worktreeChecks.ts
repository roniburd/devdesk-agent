import { basename, relative } from 'node:path';
import * as vscode from 'vscode';
import { runBounded } from './core/boundedRun';
import {
  checkKey,
  checksCounts,
  checksHint,
  type ChecksContext,
  type ChecksProvider,
  ChecksUnavailable,
  failingChecks,
  type FetchState,
  type FixItem,
  fixPrompt,
  hasFixes,
  nextFetchAt,
  type PackageStatus,
  type Run,
} from './core/checks';
import { githubChecks } from './core/github';
import { workspaceProvider } from './core/workspaceProvider';
import type { Feature, PackageRepo } from './core/worktrees';
import { checksConfig } from './config';
import { log, registerTimedCommand } from './log';
import type { ReviewComments } from './reviewComments';

/** GitHub's, then the workspace kind's (when it has one). */
export const checksProviders = (): ChecksProvider[] => [githubChecks, ...(workspaceProvider?.checks ? [workspaceProvider.checks] : [])];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A worktree's packages: its git repositories, or the worktree itself when it lists none. */
const packagesOf = (f: Feature): PackageRepo[] => (f.packages.length ? f.packages : [{ name: f.name, dir: f.dir }]);

/** What `askClaude` would send for a worktree: the prompt and how messages name it, or why there is nothing to send. */
export type FixRequest = { prompt: string; what: string } | { message: string };

/**
 * The pull requests (or the workspace kind's change requests) of the worktrees, their failing checks and open review
 * comments: fetched in the background for the worktrees the Worktrees view lists, while it is visible (`refreshDue`,
 * on the view's refresh tick), each at most every `devdesk.checks.refreshMinutes` (waiting longer after failures);
 * and **Ask Claude to Fix Checks**, which fetches them again with the failed logs and sends Claude the prompt
 * (`fixPrompt`) the way review notes go (`ReviewComments.sendPrompt`).
 */
export class WorktreeChecks implements vscode.Disposable {
  private readonly statuses = new Map<string, PackageStatus[]>();
  private readonly fetched = new Map<string, FetchState>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** A worktree's hint changed (the Worktrees view and the board draw it). */
  readonly onDidChange = this.changed.event;
  private sweeping = false;
  /** Providers already logged as unavailable, so a missing `gh` is said once. */
  private readonly saidUnavailable = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Fetches done so far (the tests check the cache holds). */
  fetches = 0;

  constructor(
    private readonly review: ReviewComments,
    private readonly listFeatures: () => Promise<readonly Feature[]>,
    private readonly providers: () => ChecksProvider[] = checksProviders,
    private readonly run: Run = runBounded,
  ) {
    this.subscriptions.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('devdesk.checks')) return;
        // Fetched again on the next tick, with the new settings; while disabled, no hints.
        this.fetched.clear();
        this.changed.fire();
      }),
      registerTimedCommand('devdesk.checks.askClaude', (arg?: unknown) => this.askClaude(arg)),
      registerTimedCommand('devdesk.checks.refresh', async () => {
        this.fetched.clear();
        for (const f of await this.listFeatures()) await this.fetch(f);
      }),
    );
  }

  /** The worktree row's hint (`2 checks failing · 1 comment`); empty when nothing needs fixing or checks are off. */
  hint(dir: string): string {
    return checksConfig().enabled ? checksHint(this.statuses.get(dir) ?? []) : '';
  }

  /** True when the worktree at `dir` has failing checks or open comments. */
  hasFixes(dir: string): boolean {
    return checksConfig().enabled && hasFixes(this.statuses.get(dir) ?? []);
  }

  /** Every worktree's hint, by directory (the tests). */
  hints(): Record<string, string> {
    return Object.fromEntries([...this.statuses.keys()].map((d) => [d, this.hint(d)]).filter(([, h]) => h));
  }

  private context(): ChecksContext {
    const c = checksConfig();
    return { run: this.run, gh: c.gh, timeoutMs: c.timeoutMs, reviewComments: c.reviewComments };
  }

  /**
   * The refresh tick: fetches, one worktree at a time in the background, the checks of `features` (those the view
   * lists) that are due. Returns at once; a sweep still running makes this one do nothing.
   */
  refreshDue(features: readonly Feature[]): void {
    const c = checksConfig();
    if (!c.enabled || c.refreshMs <= 0 || this.sweeping) return;
    const now = Date.now();
    const due = features.filter((f) => nextFetchAt(this.fetched.get(f.dir), c.refreshMs, c.maxBackoffMs) <= now);
    if (!due.length) return;
    this.sweeping = true;
    void (async () => {
      try {
        for (const f of due) await this.fetch(f);
      } finally {
        this.sweeping = false;
      }
    })();
  }

  /** Fetches the worktree's checks now, and keeps them for its hint. */
  async fetch(feature: Feature): Promise<PackageStatus[]> {
    this.fetches++;
    const c = this.context();
    const statuses: PackageStatus[] = [];
    for (const pkg of packagesOf(feature)) {
      const provider = await this.providerFor(pkg.dir, c);
      if (!provider) continue;
      try {
        const checks = await provider.status(pkg.dir, c);
        statuses.push(checks ? { kind: 'change', pkg: pkg.name, pkgDir: pkg.dir, checks } : { kind: 'none', pkg: pkg.name, pkgDir: pkg.dir });
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof ChecksUnavailable) {
          statuses.push({ kind: 'unavailable', pkg: pkg.name, pkgDir: pkg.dir, provider: provider.name, reason: message });
          if (!this.saidUnavailable.has(provider.name)) log.info(`${provider.name} checks: ${message}`);
          this.saidUnavailable.add(provider.name);
        } else {
          statuses.push({ kind: 'error', pkg: pkg.name, pkgDir: pkg.dir, provider: provider.name, message });
          log.warn(`cannot read the ${provider.name} checks of ${pkg.name} in ${feature.name}: ${message}`);
        }
      }
    }
    const failed = statuses.some((s) => s.kind === 'error' || s.kind === 'unavailable');
    const before = this.hint(feature.dir);
    this.statuses.set(feature.dir, statuses);
    this.fetched.set(feature.dir, { at: Date.now(), failures: failed ? (this.fetched.get(feature.dir)?.failures ?? 0) + 1 : 0 });
    const after = this.hint(feature.dir);
    if (after !== before) {
      log.debug(`checks of ${feature.name}: ${after || 'nothing to fix'}`);
      this.changed.fire();
    }
    return statuses;
  }

  private async providerFor(dir: string, c: ChecksContext): Promise<ChecksProvider | undefined> {
    for (const p of this.providers()) {
      if (await p.handles(dir, c).catch(() => false)) return p;
    }
    return undefined;
  }

  /** The prompt asking Claude to fix the worktree's failing checks and open comments, fetched now, with the failed logs. */
  async fixRequest(feature: Feature): Promise<FixRequest> {
    const statuses = await this.fetch(feature);
    const changes = statuses.filter((s) => s.kind === 'change');
    if (!changes.some((s) => hasFixes([s]))) {
      const problem = statuses.find((s) => s.kind === 'error' || s.kind === 'unavailable');
      if (problem?.kind === 'error') return { message: `Cannot read the checks of ${feature.name}: ${problem.message}` };
      if (problem?.kind === 'unavailable') return { message: problem.reason };
      if (!changes.length) return { message: `No open pull request for the branch of ${feature.name}.` };
      const { pending } = checksCounts(changes);
      return { message: `Nothing to fix in ${feature.name}: no failing checks${checksConfig().reviewComments ? ' or open review comments' : ''}${pending ? ` (${plural(pending, 'check')} still running)` : ''}.` };
    }
    const c = checksConfig();
    const ctx = { ...this.context(), maxLines: c.logLines };
    let logsLeft = c.logLines > 0 ? c.maxLogs : 0;
    const items: FixItem[] = [];
    for (const s of changes) {
      const logs = new Map<string, string[]>();
      const provider = await this.providerFor(s.pkgDir, ctx);
      for (const check of failingChecks(s.checks)) {
        if (!provider || logsLeft <= 0) break;
        logsLeft--;
        try {
          const lines = await provider.failureLog(s.pkgDir, check, ctx);
          if (lines.length) logs.set(checkKey(check), lines);
        } catch (err) {
          log.warn(`cannot read the failed log of ${check.name}: ${(err as Error).message}`);
        }
      }
      const pkgPath = relative(feature.dir, s.pkgDir);
      items.push({ pkgPath: pkgPath.startsWith('..') ? '' : pkgPath, checks: s.checks, logs });
    }
    const { failing, comments } = checksCounts(changes);
    const what = [failing ? plural(failing, 'failing check') : '', comments ? plural(comments, 'review comment') : ''].filter(Boolean).join(' and ');
    return { prompt: fixPrompt(items), what };
  }

  /**
   * **Ask Claude to Fix Checks** on a worktree (a Worktrees view row, a worktree directory from the board, or picked):
   * sends the prompt to its idle session, or starts one. Returns where it went, or undefined.
   */
  async askClaude(arg?: unknown): Promise<string | undefined> {
    const feature = await this.featureOf(arg);
    if (!feature) return undefined;
    const request = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Reading the checks of ${feature.name}…` },
      () => this.fixRequest(feature),
    );
    if ('message' in request) {
      void vscode.window.showInformationMessage(request.message);
      return undefined;
    }
    return this.review.sendPrompt(feature, request.prompt, request.what);
  }

  private async featureOf(arg: unknown): Promise<Feature | undefined> {
    const features = await this.listFeatures();
    const node = arg as { feature?: Feature } | undefined;
    if (node && typeof node === 'object' && node.feature?.dir) return features.find((f) => f.dir === node.feature!.dir) ?? node.feature;
    if (typeof arg === 'string') return features.find((f) => f.dir === arg) ?? { name: basename(arg), dir: arg, isMain: false, packages: [] };
    const fixable = features.filter((f) => this.hasFixes(f.dir));
    const choices = fixable.length ? fixable : features;
    if (choices.length === 1) return choices[0];
    return (
      await vscode.window.showQuickPick(
        choices.map((f) => ({ label: f.name, description: this.hint(f.dir) || f.dir, feature: f })),
        { title: 'Ask Claude to fix the checks of which worktree?' },
      )
    )?.feature;
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }
}
