import { EndedRecords, endedDir, listableEnded } from '../ended';
import { readInsight, withInsight } from '../insights';
import type { ProcessTable } from '../processes';
import { addSessionChildren, readCardExtras, readClaudeRegistries, sessionCards } from '../sessionCards';
import { ChildrenReader } from '../sessionChildren';
import { addSessionInfo, MetaReader } from '../sessionInfo';
import { cardsInScope, readHookRecords, type SessionCard, splitRecords, TranscriptEnds, withClaudeProcesses } from '../sessions';
import { STATE_INFO } from '../sessionStates';
import { DEFAULT_SERVER, listPanes, listSessions, type TmuxPane, type TmuxRunner } from '../tmux';
import { discoverFeatures, type Feature } from '../worktrees';
import type { DaemonConfig } from './config';

/**
 * The live sessions' cards without VS Code, for the web access daemon: what `SessionsModel.refresh` does up to the
 * cards, through the same functions (`sessionCards`, `addSessionChildren`, `addSessionInfo`), from the same files: the
 * hook records, the ended (parked) ones, every Claude account's session registry, Claude's own reports (Program
 * Status), notes and workers. It only reads: parking sessions and removing dead records stay with the extension.
 */

export interface SnapshotConfig
  extends Pick<
    DaemonConfig,
    'stateDir' | 'root' | 'scopeDirs' | 'scope' | 'showAll' | 'discovery' | 'claudeSessionsDirs' | 'hooksQuietMs' | 'insights' | 'tmux' | 'finishedSessions'
  > {}

/** `devdesk.sessions.finishedSessions`' default. */
export const DEFAULT_FINISHED_SESSIONS = 10;

/**
 * The parked cards the list shows: per worktree (featureDir, else cwd), the newest `limit`, as the Claude view lists
 * them before folding the rest into one row.
 */
export function newestParked(parked: readonly SessionCard[], limit: number): SessionCard[] {
  const byPlace = new Map<string, SessionCard[]>();
  const newest = [...parked].sort((a, b) => (b.endedAt ?? b.updatedAt ?? 0) - (a.endedAt ?? a.updatedAt ?? 0));
  for (const c of newest) {
    const key = c.featureDir ?? c.cwd ?? '';
    const list = byPlace.get(key) ?? [];
    if (list.length < limit) list.push(c);
    byPlace.set(key, list);
  }
  const kept = new Set([...byPlace.values()].flat());
  return newest.filter((c) => kept.has(c));
}

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
  private readonly ended = new EndedRecords();
  private known?: { root: string | undefined; list: Feature[] };
  private calls = 0;
  private reading?: Promise<SessionCard[]>;

  constructor(
    private readonly cfg: SnapshotConfig,
    private readonly deps: SnapshotDeps,
  ) {}

  /**
   * Live session cards in scope, and the newest parked ones (newestParked), with Claude names (registry + transcript meta) and insights (askSummary, liveStatus,
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
    const [paneLists, records, ended, procs, registry, extras] = await Promise.all([
      Promise.all(listing),
      readHookRecords(cfg.stateDir, this.ends),
      this.ended.read(endedDir(cfg.stateDir)),
      deps.listProcesses(),
      readClaudeRegistries(cfg.claudeSessionsDirs),
      readCardExtras(cfg.stateDir, deps.alive),
    ]);
    const panes = withClaudeProcesses(paneLists.flat(), procs);
    const features = await this.features();
    // No fork parents: a /fork runs outside tmux, where nothing can be typed into it. Parked sessions show, as in the
    // Claude view, so opening one resumes it.
    const split = splitRecords(records, panes, deps.alive);
    const { listed } = listableEnded(ended.records, new Map(split.live.map((r) => [r.sessionId, r.updatedAt])), ended.exists);
    const all = sessionCards({
      ...extras,
      panes,
      records,
      ended: listed,
      features,
      alive: deps.alive,
      onlyServer: cfg.showAll ? undefined : server,
      now: Date.now(),
      quietMs: cfg.hooksQuietMs,
    });
    const scoped = cfg.scope === 'workspace' ? cardsInScope(all, cfg.scopeDirs, features) : all;
    const live = scoped.filter((c) => STATE_INFO[c.state].live);
    const parked = newestParked(
      scoped.filter((c) => c.state === 'parked'),
      cfg.finishedSessions ?? DEFAULT_FINISHED_SESSIONS,
    );
    const shown = [...live, ...parked];
    // Children only for what still runs in the background (shown as such), as the Claude view without its child rows.
    await Promise.all([addSessionChildren(live, this.children, undefined, deps.alive), addSessionInfo(shown, registry, this.meta)]);
    if (!cfg.insights) return shown;
    return Promise.all(shown.map(async (c) => (c.sessionId ? withInsight(c, await readInsight(cfg.stateDir, c.sessionId)) : c)));
  }
}
