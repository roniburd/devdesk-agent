import { availableParallelism, loadavg } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { BaseCache, type BaseRef, type DiffMode, type FileChange, gitRunner, listChanges, resolveBase } from './core/git';
import { backgroundGitProcesses } from './core/gitProcesses';
import { idleReloadsPerTick, oldestFirst } from './core/idleReloads';
import { gitFingerprint, withMainline } from './core/gitRefs';
import { type Activity, packageForPath } from './core/worktreeSignals';
import { createPriorityLimiter } from './core/limit';
import { getPooled, LoadCache } from './core/loadCache';
import { featureForCwd } from './core/sessions';
import { listSessions, sessionLabel, sessionName, type TmuxSession } from './core/tmux';
import {
  featureDiscovery,
  sessionsTmux,
  worktreesActiveReloadMs,
  worktreesGitTimeoutMs,
  worktreesIdleReloadMs,
  worktreesMaxGitProcesses,
  worktreesPrefetch,
  worktreesRefreshSeconds,
  worktreesShowCleanPackages,
  worktreesShowSessions,
} from './config';
import { discoverFeatures, isPlainFolder, sameFeature, type Feature, type PackageRepo } from './core/worktrees';
import { log, timed, track } from './log';
import type { SessionNode } from './sessionsTree';

/** The Claude view's rows, which the Worktrees view also lists under each worktree (`devdesk.worktrees.showSessions`). */
export interface SessionRows {
  rowsForWorktree(dir: string): SessionNode[];
  getChildren(node: SessionNode): SessionNode[];
  getTreeItem(node: SessionNode): vscode.TreeItem;
}

export type FeatureNode = { kind: 'feature'; feature: Feature; session?: TmuxSession };
export type PackageNode = {
  kind: 'package';
  feature: Feature;
  pkg: PackageRepo;
  base?: BaseRef;
  changes: FileChange[];
  error?: string;
};
export type FileNode = { kind: 'file'; feature: Feature; pkg: PackageRepo; base: BaseRef; change: FileChange };
export type MessageNode = { kind: 'message'; id: string; label: string };
/** A Claude view row (session, its subagents and shells, `N earlier finished`), listed under its worktree. */
export type Node = FeatureNode | PackageNode | FileNode | MessageNode | SessionNode;
const SESSION_KINDS = new Set<Node['kind']>(['session', 'child', 'more', 'worktree', 'hooks']);
const isSessionNode = (node: Node): node is SessionNode => SESSION_KINDS.has(node.kind);

/** Changed files, commits not on mainline (uncommitted mode) or an error: listed even when clean packages are hidden. */
const hasChanges = (p: PackageNode) => p.changes.length > 0 || !!p.base?.ahead || p.error !== undefined;

/** Change signals within this long of each other cause one load. */
const CHANGE_DEBOUNCE_MS = 1000;

const lookKey = (look: { description: string; contextValue: string }) => `${look.description}\0${look.contextValue}`;
/** What a worktree row shows of its tmux session. */
const sessionKey = (s: TmuxSession | undefined) => (s ? `${s.name}\0${s.command}` : '');

/** True when the root rows are the same worktrees (with the same packages) and messages, in the same order. */
function sameRows(a: readonly Node[], b: readonly Node[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      if (x.kind === 'feature') return y.kind === 'feature' && sameFeature(x.feature, y.feature);
      return x.kind === 'message' && y.kind === 'message' && x.id === y.id && x.label === y.label;
    })
  );
}

/** When a package's last load started, and its git fingerprint (HEAD, index, mainline) read just before. */
type LoadInfo = { startedAt: number; fingerprint: string | undefined };

/** The Worktrees view: main and each worktree, their packages' changes against mainline (or uncommitted), and optionally their sessions. */
export class FeaturesTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | Node[] | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  mode: DiffMode = 'branch';
  /**
   * One pool for the whole view, at most `devdesk.worktrees.maxGitProcesses` git processes at once: those of an expanded
   * worktree load first and may use all of them; background loads use half, or a quarter while the machine is busy.
   */
  private readonly gitPool = createPriorityLimiter(
    () => worktreesMaxGitProcesses(),
    () => backgroundGitProcesses(worktreesMaxGitProcesses(), loadavg()[0], availableParallelism()),
  );
  /** Background loads still waiting for a slot, by package key: expanding their worktree moves them to the front. */
  private readonly promotions = new Map<string, () => void>();
  /**
   * Each package's changes, shared by every getChildren until the next refresh(): a refresh that only updates labels
   * (refreshLabels), or one fired while the last is still loading, reuses them instead of running git again.
   */
  private readonly packages = new LoadCache<PackageNode>();
  /** Each package's merge-base, kept while HEAD and mainline stay where they were; cleared by refresh(). */
  private readonly bases = new BaseCache();
  /**
   * The root rows as last listed for `root`: getChildren(root) returns them at once, so redrawing the rows never runs
   * discovery or tmux again (and never shows the view's progress bar). refresh() clears them.
   */
  private listed: { root: string; nodes: Node[] } | undefined;
  /** The worktree rows among `listed`, the same objects VS Code was given, so they can be redrawn one by one. */
  private featureNodes: FeatureNode[] = [];
  /** Bumped by refresh(): a discovery that started before it does not put back its older rows. */
  private structureGen = 0;
  private discovery: { gen: number; promise: Promise<boolean> } | undefined;
  /** Each worktree row's description and context value as last drawn, by directory: refreshLabels redraws the others. */
  private readonly drawn = new Map<string, string>();
  private tmuxListing: Promise<void> | undefined;
  private tmuxAgain = false;
  /** getTreeItem calls so far; `watchEventLoop` logs how many came in each 10 s. */
  treeItemCalls = 0;
  /** Root loads that had to wait for a discovery (the first one, and those after refresh()). */
  rootDiscoveries = 0;
  /** Package loads that ran git so far (a test checks that a refresh with nothing changed runs none). */
  gitLoads = 0;
  /** When each package's current load started, and its repository's git fingerprint then, by package key. */
  private readonly loadInfo = new Map<string, LoadInfo>();
  /** Worktree rows expanded in the view, by directory: they reload after `activeReloadSeconds`. */
  private readonly expanded = new Set<string>();
  /** How active each worktree's Claude sessions are, by directory (`busy` ones reload after `activeReloadSeconds`). */
  private activity: ReadonlyMap<string, Activity> = new Map();
  /** Whether loading now is worth it (the view is visible and in front); changes found meanwhile load on the next tick. */
  private active: () => boolean = () => true;
  /** Rows with changed packages waiting to be redrawn, and the timer that does it (signals come in bursts). */
  private readonly pendingRows = new Set<FeatureNode>();
  private pendingTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly root: () => string | undefined,
    /** Short state text (`? needs input`) of each worktree's most urgent Claude session, by worktree directory. */
    private readonly sessionState: () => ReadonlyMap<string, string> = () => new Map(),
    private readonly sessions?: SessionRows,
  ) {}

  /** Redraws the worktree rows' sessions (when listed), without listing the worktrees or running git again. */
  refreshSessions(): void {
    if (worktreesShowSessions() && this.sessions) this.redraw(this.featureNodes);
  }

  /** Re-reads everything: lists the worktrees again (the view shows its progress bar meanwhile) and runs git again. */
  refresh(): void {
    this.packages.invalidate();
    this.loadInfo.clear();
    this.bases.clear();
    this.structureGen++;
    this.listed = undefined;
    this.featureNodes = [];
    this.changed.fire(undefined);
  }

  /**
   * The timer's refresh: loads again only the packages that changed, under the rows as they are, and looks for added
   * or removed worktrees in the background (redrawing the whole view only when there are some). A package changed when
   * its git fingerprint (HEAD, index, mainline) did since its last load, or that load is older than
   * `activeReloadSeconds` (an expanded worktree, or one a session is busy in) or `idleReloadMinutes` (the others, only
   * the oldest few per tick: `idleReloadsPerTick`), for edits git has not seen. Settles once that work is done (the git pool is idle), so the next one can wait for it.
   */
  async refreshChanges(): Promise<void> {
    if (!this.listed) return this.refresh();
    const now = Date.now();
    const activeMs = worktreesActiveReloadMs();
    const idleMs = worktreesIdleReloadMs();
    // Rows marked changed while the view was in the background, then those whose packages changed since their load.
    const changed = new Set<FeatureNode>([...this.pendingRows].filter((n) => this.featureNodes.includes(n)));
    this.pendingRows.clear();
    const reload = (node: FeatureNode, key: string, info: LoadInfo) => {
      // A load that started meanwhile already sees the change.
      if (this.loadInfo.get(key) !== info) return;
      this.drop(key);
      changed.add(node);
    };
    // Idle packages due only for their timed reload: all loaded by the same prefetch, they come due together.
    const due: { node: FeatureNode; key: string; info: LoadInfo; startedAt: number }[] = [];
    let idle = 0;
    await Promise.all(
      this.featureNodes.flatMap((node) =>
        node.feature.packages.map(async (pkg) => {
          const key = this.packageKey(node.feature, pkg);
          const info = this.loadInfo.get(key);
          if (!info) return; // never loaded, or already dropped: the prefetch, or expanding the worktree, loads it
          const active = this.isActive(node.feature);
          if (!active) idle++;
          const ttl = active ? activeMs : idleMs;
          const old = ttl > 0 && now - info.startedAt >= ttl;
          if (old && active) return reload(node, key, info);
          if ((await gitFingerprint(pkg.dir, this.bases.upstream(pkg.dir))) !== info.fingerprint) return reload(node, key, info);
          if (old) due.push({ node, key, info, startedAt: info.startedAt });
        }),
      ),
    );
    const dueNow = oldestFirst(due, idleReloadsPerTick(idle, worktreesRefreshSeconds() * 1000, idleMs));
    for (const d of dueNow) reload(d.node, d.key, d.info);
    if (dueNow.length) log.debug(`auto-refresh: ${dueNow.length} of ${due.length} idle packages due for their timed reload`);
    if (changed.size) log.debug(`auto-refresh: ${[...changed].map((n) => n.feature.name).join(', ')} changed`);
    this.redraw([...changed]);
    const prefetch = worktreesPrefetch() ? this.prefetch(this.featureNodes.map((n) => n.feature)) : Promise.resolve();
    const discovery = this.discover().then(
      (found) => {
        if (found) this.changed.fire(undefined);
      },
      (err: Error) => log.warn(`cannot list the worktrees again: ${err.message}`),
    );
    await Promise.all([prefetch, discovery]);
    await this.gitPool.idle();
  }

  /** Settles once no package load is running or waiting for a git slot. */
  async loadsDone(): Promise<void> {
    await this.gitPool.idle();
    await this.packages.allSettled();
  }

  /** The view's state the tree can't see itself: whether loading now is worth it. */
  setActive(active: () => boolean): void {
    this.active = active;
  }

  /** A worktree row was expanded or collapsed. */
  setExpanded(dir: string, expanded: boolean): void {
    if (expanded) this.expanded.add(dir);
    else this.expanded.delete(dir);
  }

  /** How active each worktree's Claude sessions are now. */
  setActivity(activity: ReadonlyMap<string, Activity>): void {
    this.activity = activity;
  }

  private isActive(feature: Feature): boolean {
    return this.expanded.has(feature.dir) || this.activity.get(feature.dir) === 'busy';
  }

  /** Files changed at `paths` (saved in VS Code, or edited by Claude): their packages load again. */
  touchPaths(paths: readonly string[]): void {
    if (!paths.length) return;
    const owners = new Map<string, { node: FeatureNode; pkg: PackageRepo }>();
    const realDirs = new Map<string, string>();
    for (const node of this.featureNodes) {
      for (const pkg of node.feature.packages) owners.set(pkg.dir, { node, pkg });
      if (node.feature.realDir) realDirs.set(node.feature.realDir, node.feature.dir);
    }
    const dirs = [...owners.keys()];
    for (const path of paths) {
      const dir = packageForPath(path, dirs, realDirs);
      const owner = dir ? owners.get(dir) : undefined;
      if (owner) this.markChanged(owner.node, [owner.pkg]);
    }
  }

  /** Anything in the worktree at `dir` may have changed (a Claude turn ended): its packages load again. */
  touchWorktree(dir: string): void {
    const node = this.featureNodes.find((n) => n.feature.dir === dir || n.feature.realDir === dir);
    if (node) this.markChanged(node, node.feature.packages);
  }

  private markChanged(node: FeatureNode, pkgs: readonly PackageRepo[]): void {
    for (const pkg of pkgs) this.drop(this.packageKey(node.feature, pkg));
    this.pendingRows.add(node);
    // Signals come in bursts (a save, then a Claude edit of the same file): one load for them all.
    this.pendingTimer ??= setTimeout(() => {
      this.pendingTimer = undefined;
      if (!this.active()) return; // kept in pendingRows: the next tick, once the view is back, loads them
      const rows = [...this.pendingRows].filter((n) => this.featureNodes.includes(n));
      this.pendingRows.clear();
      log.debug(`changed: ${rows.map((n) => n.feature.name).join(', ')}`);
      this.redraw(rows);
      if (worktreesPrefetch()) void this.prefetch(rows.map((n) => n.feature));
    }, CHANGE_DEBOUNCE_MS);
  }

  private drop(key: string): void {
    this.packages.drop(key);
    this.loadInfo.delete(key);
  }

  /** Redraws the worktree rows whose state text, changes summary or Claude session changed, with the packages as loaded. */
  refreshLabels(): void {
    this.redraw(this.featureNodes.filter((n) => this.drawn.get(n.feature.dir) !== lookKey(this.featureLook(n))));
    void this.refreshTmux();
  }

  /** Redraws every worktree row and its children (whether its sessions are listed changed), with the packages as loaded. */
  refreshRows(): void {
    this.redraw(this.featureNodes);
  }

  private redraw(nodes: FeatureNode[]): void {
    if (nodes.length) this.changed.fire(nodes);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return timed('getChildren(root)', () => this.rootRows());
    if (isSessionNode(node)) return this.sessions?.getChildren(node) ?? [];
    if (node.kind === 'feature') {
      return timed(`getChildren(feature ${node.feature.name})`, () => this.featureChildren(node));
    }
    if (node.kind === 'package' && node.base) {
      log.debug(`getChildren(package ${node.feature.name}/${node.pkg.name}): ${node.changes.length} files`);
      return this.fileRows(node);
    }
    return [];
  }

  /** Needed by TreeView.reveal (the Personal Stacks view reveals features, which are root items). */
  getParent(node: Node): Node | undefined {
    if (node.kind === 'package') return this.featureNodes.find((n) => n.feature.dir === node.feature.dir) ?? { kind: 'feature', feature: node.feature };
    // A file row's package, as loaded (the row only shows once it is): needed to reveal a file row.
    if (node.kind === 'file') return this.packages.peek(this.packageKey(node.feature, node.pkg));
    return undefined;
  }

  /** The worktree row of the worktree at (or containing) `dir`, listing the worktrees first if the view hasn't yet. */
  async featureRow(dir: string): Promise<FeatureNode | undefined> {
    await this.getChildren();
    const exact = this.featureNodes.find((n) => n.feature.dir === dir || n.feature.realDir === dir);
    if (exact) return exact;
    const feature = featureForCwd(this.featureNodes.map((n) => n.feature), dir);
    return feature && this.featureNodes.find((n) => n.feature === feature);
  }

  /**
   * The worktree's packages with changed files in the current mode, by name: loaded again now (ahead of background
   * loads), since an edit git has not seen yet changes no fingerprint. Its row is redrawn with them.
   */
  async changedPackages(node: FeatureNode): Promise<PackageNode[]> {
    for (const pkg of node.feature.packages) this.drop(this.packageKey(node.feature, pkg));
    const packages = await Promise.all(node.feature.packages.map((pkg) => this.cachedPackage(node.feature, pkg)));
    this.redraw([node]);
    return packages.filter((p) => p.base && p.changes.length).sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
  }

  /** A package's file rows, as getChildren lists them. */
  fileRows(node: PackageNode): FileNode[] {
    const base = node.base;
    return base ? node.changes.map((change): FileNode => ({ kind: 'file', feature: node.feature, pkg: node.pkg, base, change })) : [];
  }

  private async featureChildren(node: FeatureNode): Promise<Node[]> {
    const sessions = worktreesShowSessions() && this.sessions ? this.sessions.rowsForWorktree(node.feature.dir) : [];
    return [...sessions, ...(await this.packageRows(node))];
  }

  private async packageRows(node: FeatureNode): Promise<Node[]> {
    const packages = await Promise.all(this.packagesOrLast(node));
    const byName = (a: PackageNode, b: PackageNode) => a.pkg.name.localeCompare(b.pkg.name);
    if (worktreesShowCleanPackages()) return packages.sort((a, b) => Number(hasChanges(b)) - Number(hasChanges(a)) || byName(a, b));
    const changed = packages.filter(hasChanges).sort(byName);
    if (changed.length || !packages.length) return changed;
    const n = packages.length;
    return [{ kind: 'message', id: `clean:${node.feature.dir}`, label: `No changes (${n} package${n === 1 ? '' : 's'} clean)` }];
  }

  /**
   * The worktree's packages, each as loaded now or, while it loads again (it changed, its load got old, a refresh),
   * as last loaded: the row shows at once instead of waiting for git, and is redrawn once those loads are done.
   */
  private packagesOrLast(node: FeatureNode): Promise<PackageNode>[] {
    const reloading: Promise<PackageNode>[] = [];
    const packages = node.feature.packages.map((pkg) => {
      const key = this.packageKey(node.feature, pkg);
      const load = this.cachedPackage(node.feature, pkg);
      const last = this.packages.isFresh(key) ? undefined : this.packages.peek(key);
      if (!last) return load;
      reloading.push(load);
      return Promise.resolve(last);
    });
    if (reloading.length) {
      void Promise.all(reloading).then(
        () => this.featureNodes.includes(node) && this.redraw([node]),
        () => undefined,
      );
    }
    return packages;
  }

  private packageKey(feature: Feature, pkg: PackageRepo, mode: DiffMode = this.mode): string {
    return `${mode}:${feature.dir}:${pkg.dir}`;
  }

  /**
   * The package's changes as loaded since the last refresh(), loading them if needed: in the background (prefetching)
   * after every foreground load, or ahead of all background loads, promoting a queued prefetch of the same package.
   */
  private cachedPackage(feature: Feature, pkg: PackageRepo, background = false): Promise<PackageNode> {
    const key = this.packageKey(feature, pkg);
    const queued = Date.now();
    const start = <R>(task: () => Promise<R>): Promise<R> => {
      const job = this.gitPool(async () => {
        if (this.promotions.get(key) === job.promote) this.promotions.delete(key);
        return task();
      }, background);
      if (background) this.promotions.set(key, job.promote);
      return job.promise;
    };
    // Refreshed while waiting for a slot: getPooled shares the newer load instead of running git for an outdated request.
    const promise = getPooled(this.packages, key, start, async () => {
      // Read before git runs: a change made while it runs shows as a new fingerprint on the next tick.
      const upstream = this.bases.upstream(pkg.dir);
      const info = { startedAt: Date.now(), fingerprint: await gitFingerprint(pkg.dir, upstream) };
      this.loadInfo.set(key, info);
      this.gitLoads++;
      const started = Date.now();
      const done = track(`git ${feature.name}/${pkg.name}`);
      const result = await this.loadPackage(feature, pkg).finally(done);
      // The first load finds the mainline: add its commit, or the next tick would see a "change" and load it again.
      const found = upstream === undefined ? this.bases.getBase(pkg.dir)?.upstreamSha : undefined;
      if (found && info.fingerprint !== undefined) info.fingerprint = withMainline(info.fingerprint, found);
      log.debug(`  ${feature.name}/${pkg.name}${background ? ' (prefetch)' : ''}: waited ${started - queued}ms, git ${Date.now() - started}ms, ${result.changes.length} changes${result.error ? `, error ${result.error}` : ''}`);
      return result;
    });
    if (!background) this.promotions.get(key)?.();
    return promise;
  }

  /** `3 changed` or `clean` once every package of the worktree has been loaded (prefetched or expanded) in this mode. */
  private changesSummary(feature: Feature): string {
    const loaded = feature.packages.map((pkg) => this.packages.peek(this.packageKey(feature, pkg)));
    if (!loaded.length || loaded.some((p) => p === undefined)) return '';
    const changed = loaded.filter((p) => p && hasChanges(p)).length;
    return changed ? `${changed} changed` : 'clean';
  }

  /**
   * Loads every worktree's packages in the background, so expanding one shows its changes at once, and redraws the
   * rows (their `N changed`) when that changed what they show.
   */
  private async prefetch(features: readonly Feature[]): Promise<void> {
    const summary = () => features.map((f) => this.changesSummary(f)).join('|');
    const before = summary();
    await Promise.all(features.flatMap((f) => f.packages.map((p) => this.cachedPackage(f, p, true))));
    if (summary() !== before) this.refreshLabels();
  }

  private async rootRows(): Promise<Node[]> {
    const root = this.root();
    if (!root) {
      this.listed = undefined;
      this.featureNodes = [];
      return [{ kind: 'message', id: 'no-workspace', label: 'Open a folder' }];
    }
    // A refresh() or a change of root while listing starts another discovery; give up after a few.
    for (let i = 0; i < 3 && this.listed?.root !== root; i++) {
      this.rootDiscoveries++;
      await this.discover();
    }
    if (worktreesPrefetch() && this.featureNodes.length) void this.prefetch(this.featureNodes.map((n) => n.feature));
    return this.listed?.nodes ?? [];
  }

  /** Lists the worktrees and their tmux sessions once at a time; true when that changed the rows (`listed`). */
  private discover(): Promise<boolean> {
    const gen = this.structureGen;
    if (this.discovery?.gen === gen) return this.discovery.promise;
    const promise = this.listRoot().then((next) => gen === this.structureGen && next !== undefined && this.apply(next));
    const entry = { gen, promise };
    this.discovery = entry;
    const clear = () => {
      if (this.discovery === entry) this.discovery = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async listRoot(): Promise<{ root: string; nodes: Node[]; sessions: TmuxSession[] } | undefined> {
    const root = this.root();
    if (!root) return undefined;
    const [features, sessions] = await Promise.all([discoverFeatures(root, featureDiscovery()), listSessions(sessionsTmux())]);
    // A plain folder (neither a package workspace nor a git repository) is main alone: its row opens its sessions.
    const plain = isPlainFolder(root);
    if (!plain && features.every((f) => f.packages.length === 0)) {
      return { root, nodes: [{ kind: 'message', id: 'empty', label: `No git packages found under ${root}/src` }], sessions };
    }
    const byName = new Map(sessions.map((s) => [s.name, s]));
    const rows = features.map((feature): FeatureNode => ({ kind: 'feature', feature, session: byName.get(sessionName(feature)) }));
    if (plain) return { root, nodes: [...rows, { kind: 'message', id: 'plain', label: 'Not a git repository: no worktrees or changes to list' }], sessions };
    return { root, nodes: rows, sessions };
  }

  /**
   * Keeps the rows as they are when the same worktrees were found (redrawing those whose session changed), else takes
   * the new ones; true when it took them.
   */
  private apply(next: { root: string; nodes: Node[]; sessions: TmuxSession[] }): boolean {
    if (this.listed && this.listed.root === next.root && sameRows(this.listed.nodes, next.nodes)) {
      this.redraw(this.updateSessions(next.sessions));
      return false;
    }
    this.listed = { root: next.root, nodes: next.nodes };
    this.featureNodes = next.nodes.filter((n): n is FeatureNode => n.kind === 'feature');
    this.drawn.clear();
    const features = this.featureNodes.map((n) => n.feature);
    const keep = new Set(features.flatMap((f) => f.packages.flatMap((p) => [this.packageKey(f, p, 'branch'), this.packageKey(f, p, 'uncommitted')])));
    this.packages.retain(keep);
    for (const key of this.loadInfo.keys()) if (!keep.has(key)) this.loadInfo.delete(key);
    return true;
  }

  /** Lists the tmux sessions again (once at a time) and redraws the rows whose session started, ended or changed. */
  private refreshTmux(): Promise<void> {
    if (this.tmuxListing) {
      this.tmuxAgain = true;
      return this.tmuxListing;
    }
    const listing = (async () => {
      do {
        this.tmuxAgain = false;
        const sessions = await listSessions(sessionsTmux()).catch((err: Error) => {
          log.debug(`tmux sessions for the Worktrees view: ${err.message}`);
          return undefined;
        });
        if (sessions) this.redraw(this.updateSessions(sessions));
      } while (this.tmuxAgain);
    })();
    this.tmuxListing = listing;
    const clear = () => {
      if (this.tmuxListing === listing) this.tmuxListing = undefined;
    };
    listing.then(clear, clear);
    return listing;
  }

  /** Puts `sessions` on the worktree rows; the rows whose session changed. */
  private updateSessions(sessions: readonly TmuxSession[]): FeatureNode[] {
    const byName = new Map(sessions.map((s) => [s.name, s]));
    const changed: FeatureNode[] = [];
    for (const node of this.featureNodes) {
      const session = byName.get(sessionName(node.feature));
      if (sessionKey(session) === sessionKey(node.session)) continue;
      node.session = session;
      changed.push(node);
    }
    return changed;
  }

  private async loadPackage(feature: Feature, pkg: PackageRepo): Promise<PackageNode> {
    try {
      const git = gitRunner(worktreesGitTimeoutMs() || undefined);
      const base = await resolveBase(git, pkg.dir, this.mode, this.bases);
      return { kind: 'package', feature, pkg, base, changes: await listChanges(git, pkg.dir, base.ref) };
    } catch (err) {
      return { kind: 'package', feature, pkg, changes: [], error: (err as Error).message.split('\n')[0] };
    }
  }

  /** A worktree row's description (its Claude state, then `N changed`) and context value. */
  private featureLook(node: FeatureNode): { description: string; contextValue: string } {
    const session = this.sessionState().get(node.feature.dir) ?? sessionLabel(node.session);
    return {
      description: [session, this.changesSummary(node.feature)].filter(Boolean).join(' · '),
      // `feature.session` while its own Claude session runs; `deletable` for a worktree (not the workspace itself).
      contextValue: `${node.session ? 'feature.session' : 'feature'}${node.feature.isMain ? '' : ' deletable'}`,
    };
  }

  getTreeItem(node: Node): vscode.TreeItem {
    this.treeItemCalls++;
    if (isSessionNode(node)) return this.sessions?.getTreeItem(node) ?? new vscode.TreeItem('');
    switch (node.kind) {
      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.id = node.id;
        return item;
      }
      case 'feature': {
        const item = new vscode.TreeItem(node.feature.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `feature:${node.feature.dir}`;
        const look = this.featureLook(node);
        this.drawn.set(node.feature.dir, lookKey(look));
        item.description = look.description;
        item.tooltip = node.feature.dir;
        item.contextValue = look.contextValue;
        item.iconPath = new vscode.ThemeIcon(node.feature.isMain ? 'home' : 'git-branch');
        return item;
      }
      case 'package': {
        const count = node.changes.length;
        const ahead = node.base?.ahead;
        const item = new vscode.TreeItem(
          node.pkg.name,
          count ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `package:${node.pkg.dir}`;
        item.description = node.error
          ? `error: ${node.error}`
          : (count ? `${count} file${count === 1 ? '' : 's'} vs ${node.base?.label}` : 'clean') +
            (ahead ? ` · ${ahead} commit${ahead === 1 ? '' : 's'} not on mainline` : '');
        item.iconPath = new vscode.ThemeIcon('package');
        item.contextValue = 'package';
        return item;
      }
      case 'file': {
        const { change } = node;
        const item = new vscode.TreeItem(change.path, vscode.TreeItemCollapsibleState.None);
        item.id = `file:${node.pkg.dir}:${change.status}:${change.path}`;
        item.description = change.oldPath ? `${change.status} ← ${change.oldPath}` : change.status;
        item.resourceUri = vscode.Uri.file(join(node.pkg.dir, change.path));
        item.command = { command: 'devdesk.openDiff', title: 'Open Diff', arguments: [node] };
        return item;
      }
    }
  }
}
