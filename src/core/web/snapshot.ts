import { readInsight, withInsight } from '../insights';
import type { ProcessTable } from '../processes';
import { addSessionChildren, readCardExtras, readClaudeRegistries, sessionCards } from '../sessionCards';
import { ChildrenReader } from '../sessionChildren';
import { addSessionInfo, MetaReader } from '../sessionInfo';
import { cardsInScope, readHookRecords, type SessionCard, TranscriptEnds, withClaudeProcesses } from '../sessions';
import { STATE_INFO } from '../sessionStates';
import { DEFAULT_SERVER, listPanes, listSessions, type TmuxPane, type TmuxRunner } from '../tmux';
import { discoverFeatures, type Feature } from '../worktrees';
import type { DaemonConfig } from './config';

/**
 * The live sessions' cards without VS Code, for the web access daemon: what `SessionsModel.refresh` does up to the
 * cards, through the same functions (`sessionCards`, `addSessionChildren`, `addSessionInfo`), from the same files: the
 * hook records, every Claude account's session registry, Claude's own reports (Program Status), notes and workers. It
 * only reads: parking sessions and removing dead records stay with the extension.
 */

export interface SnapshotConfig
  extends Pick<DaemonConfig, 'stateDir' | 'root' | 'scopeDirs' | 'scope' | 'showAll' | 'discovery' | 'claudeSessionsDirs' | 'hooksQuietMs' | 'insights' | 'tmux'> {}

export interface SnapshotDeps {
  /** The daemon: tmuxRunner(server, { bin, configFile only for cfg.tmux.server }). */
  tmux: (server: string) => TmuxRunner;
  listProcesses: () => Promise<ProcessTable | undefined>;
  /** processAlive */
  alive: (pid: number) => boolean;
}

/** Rediscover the root's worktrees every this many calls of `features()`. */
const REDISCOVER_EVERY = 10;

export class SessionSnapshot {
  private readonly ends = new TranscriptEnds();
  private readonly meta = new MetaReader();
  private readonly children = new ChildrenReader();
  private known?: { root: string | undefined; list: Feature[] };
  private calls = 0;
  private reading?: Promise<SessionCard[]>;

  constructor(
    private readonly cfg: SnapshotConfig,
    private readonly deps: SnapshotDeps,
  ) {}

  /**
   * Live session cards in scope, with Claude names (registry + transcript meta) and insights (askSummary, liveStatus,
   * insightTitle). Calls made while one runs share its result (the readers it keeps are not safe to run twice at once).
   */
  cards(): Promise<SessionCard[]> {
    this.reading ??= this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  /** The root's features (main and worktrees), main first; rediscovered every 10th call or when the root changed. [] without a root. */
  async features(): Promise<Feature[]> {
    const root = this.cfg.root;
    if (!this.known || this.known.root !== root || ++this.calls >= REDISCOVER_EVERY) {
      const list = root ? await discoverFeatures(root, this.cfg.discovery) : [];
      this.known = { root, list: [...list.filter((f) => f.isMain), ...list.filter((f) => !f.isMain)] };
      this.calls = 0;
    }
    return this.known.list;
  }

  /** tmux session names on cfg.tmux.server (for nextSessionName). */
  async sessionNames(): Promise<string[]> {
    return (await listSessions(this.deps.tmux(this.cfg.tmux.server))).map((s) => s.name);
  }

  private async read(): Promise<SessionCard[]> {
    const { cfg, deps } = this;
    const server = cfg.tmux.server;
    const listing: Promise<TmuxPane[]>[] = [listPanes(deps.tmux(server), server)];
    // Showing everything also covers your own (default) tmux server.
    if (cfg.showAll && server !== DEFAULT_SERVER) listing.push(listPanes(deps.tmux(DEFAULT_SERVER), DEFAULT_SERVER));
    const [paneLists, records, procs, registry, extras] = await Promise.all([
      Promise.all(listing),
      readHookRecords(cfg.stateDir, this.ends),
      deps.listProcesses(),
      readClaudeRegistries(cfg.claudeSessionsDirs),
      readCardExtras(cfg.stateDir, deps.alive),
    ]);
    const panes = withClaudeProcesses(paneLists.flat(), procs);
    const features = await this.features();
    // No fork parents and no ended records: only sessions running in tmux show (nothing else can be typed into).
    const all = sessionCards({
      ...extras,
      panes,
      records,
      features,
      alive: deps.alive,
      onlyServer: cfg.showAll ? undefined : server,
      now: Date.now(),
      quietMs: cfg.hooksQuietMs,
    });
    const scoped = cfg.scope === 'workspace' ? cardsInScope(all, cfg.scopeDirs, features) : all;
    const live = scoped.filter((c) => STATE_INFO[c.state].live);
    // Children only for what still runs in the background (shown as such), as the Claude view without its child rows.
    await Promise.all([addSessionChildren(live, this.children, undefined, deps.alive), addSessionInfo(live, registry, this.meta)]);
    if (!cfg.insights) return live;
    return Promise.all(live.map(async (c) => (c.sessionId ? withInsight(c, await readInsight(cfg.stateDir, c.sessionId)) : c)));
  }
}
