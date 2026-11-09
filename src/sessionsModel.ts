import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { findDescendant, listProcesses } from './core/processes';
import { endedDir, listableEnded, readEndedRecords, removeEndedRecord, writeEndedRecord } from './core/ended';
import { parkable, parkPlan, type ParkPolicy } from './core/park';
import { cardsWithProgramStatus, programStatusDirIn, readProgramStatuses } from './core/programStatus';
import { cardsWithNotes, notesDirIn, readNotes, staleNotes } from './core/devdeskCli';
import { cardsWithWorkers, readMailboxes, workersDirIn } from './core/workers';
import { ChildrenReader, runningBackground } from './core/sessionChildren';
import { claudeTitle, ForkParentReader, MetaReader, parkedJob, readRegistry, type RegistryEntry, registryFor, userNamed } from './core/sessionInfo';
import { buildSessionCards, cardsInScope, isClaudeCommand, type HookRecord, parseHookRecord, processAlive, readHookRecords, type SessionCard, splitRecords, TranscriptEnds } from './core/sessions';
import { transitionsToWaiting } from './core/sessionsView';
import { DEFAULT_SERVER, killSessionArgs, listPanes, serverOf, sessionName, sessionsOf, type TmuxPane, type TmuxRunner, type TmuxSession } from './core/tmux';
import { discoverFeatures, type Feature } from './core/worktrees';
import { applyInsight } from './core/insights';
import { type PendingTurn, withPendingTurns, withRecords } from './core/livePatches';
import { insightsDir, readInsight } from './insightsWorker';
import { log, noteLatency, stepTimer, track } from './log';

/** File events within this long of each other cause one refresh. */
const DEBOUNCE_MS = 300;
/** Fire onDidChange at least this often even when nothing changed, so "ago" labels stay fresh. */
const MAX_QUIET_MS = 60_000;
/** Rediscover feature worktrees every this many refreshes (also on restart and when a new cc- session is unmatched). */
const REDISCOVER_EVERY = 10;
/** A refresh that takes this long or longer logs how long each step took (at debug level). */
const SLOW_REFRESH_MS = 250;
/** Parking is checked at most this often. */
const PARK_CHECK_MS = 60_000;

/**
 * Moves the state file of a session whose Claude process is gone to the ended sessions (crashed when it was mid-turn),
 * unless it was rewritten for a live process.
 */
async function removeDead(dir: string, record: HookRecord): Promise<void> {
  const path = join(dir, `${record.sessionId}.json`);
  try {
    const now = parseHookRecord(await readFile(path, 'utf8'));
    if (!now || now.pid !== record.pid || (now.pid !== undefined && processAlive(now.pid))) return;
    const midTurn = now.state === 'working' || now.state === 'waiting' || now.state === 'blocked';
    await writeEndedRecord(endedDir(dir), now, midTurn ? 'crashed' : 'exited').catch((err) =>
      log.warn(`cannot keep ended session ${now.sessionId}: ${(err as Error).message}`),
    );
    await unlink(path);
  } catch {
    // Already gone or unreadable: nothing to clean up.
  }
}

/** Where the sessions model reads from and how; each is asked again when used, so setting changes apply. */
export interface SessionsModelOptions {
  stateDir: () => string;
  /** The workspace root whose worktrees sessions are matched against. */
  root: () => string | undefined;
  pollMs: () => number;
  /** How long a hooked working or waiting session's record may go unchanged before Claude's own report replaces it (0: never). */
  hooksQuietMs: () => number;
  /** DevDesk's tmux server (`-L` name). */
  tmuxServer: () => string;
  /** List every Claude session on the machine, not only those on DevDesk's tmux server. */
  showAll: () => boolean;
  /** List only the sessions working in this workspace (its root or one of its worktrees), not every folder's. */
  workspaceOnly: () => boolean;
  /** How many finished subagents, shells and workflows to list per level; undefined lists none. */
  finishedChildren: () => number | undefined;
  /** Options for discovering worktrees (whether Claude Code worktrees count). */
  discovery: () => { claudeWorktrees?: boolean };
  /** Where Claude Code lists its running sessions and their names; undefined skips them. */
  claudeSessionsDir: () => string | undefined;
  /** Runs tmux on a server, with the configured binary. */
  tmux: (server: string) => TmuxRunner;
  /** Where Claude Code keeps its background jobs (a /fork runs as one); undefined skips forks outside tmux. */
  claudeJobsDir: () => string | undefined;
  /** When to park DevDesk sessions (see `parkPlan`), but for low memory. */
  parkPolicy: () => Omit<ParkPolicy, 'lowMemory'>;
  /** Park one more idle session while less than this percent of memory is free; 0 never. */
  parkBelowFreePercent: () => number;
  /** Percent of memory free now; undefined if unknown. */
  freeMemoryPercent: () => Promise<number | undefined>;
  /** Put DevDesk's Haiku insights (`<state dir>/insights`) on the cards. */
  insights: () => boolean;
}

/** Current Claude session cards. Runs (watch + poll) only while someone has acquired it. */
export class SessionsModel implements vscode.Disposable {
  private cards: SessionCard[] = [];
  private loaded = false;
  /** Stopped sessions that crashed. */
  private crashed = new Set<string>();
  private users = 0;
  private generation = 0;
  private watcher: FSWatcher | undefined;
  private insightsWatcher: FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private running = false;
  private rerun = false;
  /** `fresh` callers waiting for the refresh that started after they asked. */
  private waiters: (() => void)[] = [];
  /**
   * Hook records read as their files changed, by session id, each with the `recordReads` count when read: shown on the
   * cards (`withRecords`) until a refresh that started reading the state files after them.
   */
  private records = new Map<string, { record: HookRecord; read: number }>();
  private recordReads = 0;
  /** Sessions the board started on a prompt, shown as working until Claude reports the turn (`withPendingTurns`). */
  private pendingTurns: PendingTurn[] = [];
  private lastKey: string | undefined;
  private lastFired = 0;
  private features: { root: string | undefined; list: Feature[]; unmatched: Set<string> } | undefined;
  /** Bumped by rediscover(), so a discovery that started before it does not put back the old list. */
  private rediscoveries = 0;
  private refreshesSinceDiscover = 0;
  private lastParkCheck = 0;
  /** Whether the user has read what a session shows (`setReadCheck`); until told, nothing counts as read. */
  private isRead: (card: SessionCard) => boolean = () => false;
  /** Transcripts of sessions the view did not list, read before parking them (`withChildren`). */
  private readonly parkChildrenReader = new ChildrenReader();
  /** How each record's transcript ends, re-read only when the transcript changed. */
  private readonly transcriptEnds = new TranscriptEnds();
  /**
   * Session transcripts scanned so far; kept across refreshes (and stops: paths are absolute, and a file that shrank is
   * read again) so each one reads only what was appended.
   */
  private readonly childrenReader = new ChildrenReader();
  /** Session transcripts' titles and recaps, read incrementally the same way. */
  private readonly metaReader = new MetaReader();
  /** Which session each background job was forked from; never changes, so kept for the extension's lifetime. */
  private readonly forkParentReader = new ForkParentReader();
  private readonly changed = new vscode.EventEmitter<SessionCard[]>();
  private readonly waiting = new vscode.EventEmitter<SessionCard[]>();
  readonly onDidChange = this.changed.event;
  readonly onDidStartWaiting = this.waiting.event;

  constructor(private readonly o: SessionsModelOptions) {}

  /** The worktrees (and main) sessions were last matched against. */
  get featureList(): readonly Feature[] {
    return this.features?.list ?? [];
  }

  /**
   * The worktrees (and main), discovering them now when no refresh has yet (the board's composer needs them before
   * the first poll); shares the cache refreshes use.
   */
  async loadFeatures(): Promise<readonly Feature[]> {
    const root = this.o.root();
    const cached = this.features;
    if (cached && cached.root === root) return cached.list;
    const asked = this.rediscoveries;
    const list = await this.discover(root);
    // Keep it unless the cache changed meanwhile (a refresh found newer ones, or rediscover() asked for a new look).
    if (this.features === cached && this.rediscoveries === asked && this.o.root() === root) this.features = { root, list, unmatched: new Set() };
    return list;
  }

  private async discover(root: string | undefined): Promise<Feature[]> {
    return root ? discoverFeatures(root, this.o.discovery()) : [];
  }

  /** Rediscovers worktrees on the next refresh (one was just created). */
  rediscover(): void {
    this.rediscoveries++;
    this.features = undefined;
  }

  get current(): SessionCard[] {
    return this.cards;
  }

  /** The first refresh since starting has finished. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** The current card with this id, if any (webview messages carry ids, which are checked against this). */
  find(id: unknown): SessionCard | undefined {
    return typeof id === 'string' ? this.cards.find((c) => c.id === id) : undefined;
  }

  acquire(): void {
    if (this.users++ === 0) this.start();
  }

  /** A hold its owner turns on and off (a view while it is visible): acquires on, releases off, and nothing twice. */
  holder(): { set(want: boolean): void } {
    let held = false;
    return {
      set: (want) => {
        if (want === held) return;
        held = want;
        if (want) this.acquire();
        else this.release();
      },
    };
  }

  /**
   * The cards as they are now: waits for a refresh that starts after this call (holding the model meanwhile), for a
   * list that includes a session started a moment ago.
   */
  async fresh(): Promise<SessionCard[]> {
    this.acquire();
    try {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        void this.refresh();
      });
    } finally {
      this.release();
    }
    return this.cards;
  }

  release(): void {
    if (this.users > 0 && --this.users === 0) this.stop();
  }

  /** Re-reads settings (state dir, poll interval) by restarting the watcher and timer while running. */
  restart(): void {
    if (this.users === 0) return;
    this.stop();
    this.start();
  }

  private start(): void {
    void this.startWatcher(this.generation);
    this.poll = setInterval(() => void this.refresh(), this.o.pollMs());
    void this.refresh();
  }

  private stop(): void {
    this.generation++;
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.insightsWatcher?.close();
    this.poll = this.debounce = this.watcher = this.insightsWatcher = undefined;
    this.loaded = false;
    this.lastKey = undefined;
    this.records.clear();
    this.features = undefined;
  }

  /** The session each record outside tmux was forked from (a /fork runs as a background job), by session id. */
  private async forkParents(records: readonly HookRecord[], registry: readonly RegistryEntry[]): Promise<Map<string, string>> {
    const parents = new Map<string, string>();
    const dir = this.o.claudeJobsDir();
    if (!dir) return parents;
    await Promise.all(
      records
        .filter((r) => !r.tmuxPane && !r.tmuxSession)
        .map(async (r) => {
          const jobId = registryFor(registry, r.sessionId, r.pid)?.jobId;
          const parent = jobId ? await this.forkParentReader.read(dir, jobId) : undefined;
          if (parent) parents.set(r.sessionId, parent);
        }),
    );
    return parents;
  }

  /** Names, recaps and start times from Claude Code's own session registry and transcripts. */
  private async addInfo(cards: SessionCard[], registry: readonly RegistryEntry[]): Promise<void> {
    const useInsights = this.o.insights();
    await Promise.all(
      cards.map(async (card) => {
        const own = card.sessionId || card.pid !== undefined ? registryFor(registry, card.sessionId, card.pid) : undefined;
        // Attached to a background job: its conversation (name, recap) is what the terminal shows.
        const job = parkedJob(registry, own);
        const entry = job ?? own;
        const transcript = job && card.transcriptPath ? join(dirname(card.transcriptPath), `${job.sessionId}.jsonl`) : card.transcriptPath;
        const meta = transcript ? await this.metaReader.read(transcript) : undefined;
        const name = claudeTitle(entry, meta);
        if (name) card.name = name;
        if (userNamed(entry, meta)) card.nameByUser = true;
        if (meta?.summary) {
          card.summary = meta.summary;
          if (meta.summaryAt !== undefined) card.summaryAt = meta.summaryAt;
        }
        const startedAt = entry?.startedAt ?? meta?.startedAt;
        if (startedAt !== undefined) card.startedAt = startedAt;
        if (useInsights && card.sessionId) applyInsight(card, await readInsight(this.o.stateDir(), card.sessionId));
      }),
    );
    this.metaReader.prune();
  }

  /**
   * Lists what each session spun off, from its transcript, when the view shows it (`devdesk.sessions.showChildren`),
   * and marks every live session that still runs something in the background (`runsInBackground`), which shows as
   * waiting on background work either way.
   */
  private async addChildren(cards: SessionCard[]): Promise<void> {
    const shown = this.o.finishedChildren();
    const finishedLimit = shown ?? 0;
    await Promise.all(
      cards.map(async (card) => {
        if (!card.transcriptPath) return;
        const live = card.pid !== undefined && card.state !== 'stopped' && card.state !== 'parked' && processAlive(card.pid);
        // Nothing to list, nor anything that can still run.
        if (shown === undefined && !live) return;
        const children = await this.childrenReader.read(card.transcriptPath, { finishedLimit, live, since: card.sessionStartedAt });
        if (shown !== undefined && children.length) card.children = children;
        if (live && runningBackground(children)) card.runsInBackground = true;
      }),
    );
    this.childrenReader.prune();
  }

  /** The workspace root as configured and with symlinks resolved (a session's cwd is the real path); none without a folder. */
  private async scopeDirs(): Promise<string[]> {
    const root = this.o.root();
    if (!root) return [];
    const real = await realpath(root).catch(() => root);
    return real === root ? [root] : [root, real];
  }

  /** Cached features; rediscovered periodically, when the root changes, or when a new cc- session has no feature. */
  private async featuresFor(tmux: readonly TmuxSession[], generation: number): Promise<Feature[]> {
    const root = this.o.root();
    const cached = this.features;
    const known = cached ? new Set(cached.list.map(sessionName)) : undefined;
    const unmatched = tmux.map((s) => s.name).filter((n) => n.startsWith('cc-') && !known?.has(n));
    const stale =
      !cached ||
      cached.root !== root ||
      ++this.refreshesSinceDiscover >= REDISCOVER_EVERY ||
      unmatched.some((n) => !cached.unmatched.has(n));
    if (!stale) return cached.list;
    const list = await this.discover(root);
    const names = new Set(list.map(sessionName));
    if (generation === this.generation) {
      this.features = { root, list, unmatched: new Set(unmatched.filter((n) => !names.has(n))) };
      this.refreshesSinceDiscover = 0;
    }
    return list;
  }

  private async startWatcher(generation: number): Promise<void> {
    const dir = this.o.stateDir();
    this.watcher = await this.watchDir(dir, generation, (name) => {
      // The hook writes a `.tmp` file, then renames it over the state file: only the rename matters.
      if (name?.endsWith('.tmp')) return;
      this.schedule();
      // A session's state file: its card changes now, before the refresh.
      if (name?.endsWith('.json')) void this.readRecord(join(dir, name), generation);
    });
    if (generation !== this.generation) return;
    // New insights show without waiting for the poll (else on the next poll).
    this.insightsWatcher = await this.watchDir(insightsDir(dir), generation, (name) => {
      if (!name || name.endsWith('.json')) this.schedule();
    });
  }

  /**
   * Watches `dir` (created if missing), calling `onEvent` with each changed file name; undefined when it cannot, or when
   * stopped or restarted meanwhile (so no watcher leaks). A watcher that fails closes, leaving polling.
   */
  private async watchDir(dir: string, generation: number, onEvent: (name: string | undefined) => void): Promise<FSWatcher | undefined> {
    try {
      await mkdir(dir, { recursive: true });
      if (generation !== this.generation) return undefined;
      const watcher = watch(dir, (_event, name) => onEvent(name ? String(name) : undefined));
      watcher.on('error', () => {
        log.warn(`watcher for ${dir} failed; continuing with polling only`);
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
        if (this.insightsWatcher === watcher) this.insightsWatcher = undefined;
      });
      return watcher;
    } catch (err) {
      log.warn(`cannot watch ${dir}: ${(err as Error).message}; polling only`);
      return undefined;
    }
  }

  /** Shows what the hook record at `path` says on its session's card at once (the refresh that follows confirms it). */
  private async readRecord(path: string, generation: number): Promise<void> {
    const record = parseHookRecord(await readFile(path, 'utf8').catch(() => ''));
    if (!record || generation !== this.generation) return;
    // Reads of one file can finish out of order: keep the newest record.
    const known = this.records.get(record.sessionId);
    if (known && known.record.updatedAt >= record.updatedAt) return;
    this.records.set(record.sessionId, { record, read: ++this.recordReads });
    this.publish();
  }

  /**
   * Shows the card of tmux session `session` on `server`, which was just started on `prompt`, as working on it while
   * Claude starts, until Claude reports the turn.
   */
  expectTurn(server: string, session: string, prompt: string): void {
    this.pendingTurns = [...this.pendingTurns.filter((p) => p.server !== server || p.session !== session), { server, session, prompt, at: Date.now() }];
    this.publish();
  }

  /** Applies the hook records read since the last refresh and the pending turns to the current cards, and tells listeners. */
  private publish(): void {
    if (!this.loaded || this.users === 0) return;
    this.commit(this.cards, Date.now());
  }

  /**
   * Makes `cards`, with the hook records read since the last refresh and the pending turns applied, the current cards,
   * and tells listeners: what changed, then which sessions started waiting (none on the first load).
   */
  private commit(cards: SessionCard[], now: number): void {
    const seeded = withPendingTurns(withRecords(cards, this.readRecords()), this.pendingTurns, now);
    this.pendingTurns = seeded.pending;
    const next = seeded.cards;
    if (next === this.cards) return;
    const newlyWaiting = this.loaded ? transitionsToWaiting(this.cards, next) : [];
    this.cards = next;
    this.loaded = true;
    this.fire(next, now);
    if (newlyWaiting.length) this.waiting.fire(next.filter((c) => newlyWaiting.includes(c.id)));
  }

  private readRecords(): Map<string, HookRecord> {
    return new Map([...this.records].map(([id, r]) => [id, r.record]));
  }

  /** Tells listeners about `cards` when they changed, or when nothing has been said for a while. */
  private fire(cards: SessionCard[], now: number): void {
    const key = JSON.stringify(cards);
    if (key !== this.lastKey || now - this.lastFired >= MAX_QUIET_MS) {
      this.lastKey = key;
      this.lastFired = now;
      this.changed.fire(cards);
    }
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    if (this.users === 0) return; // stopped: never fire events or set a baseline
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    const generation = this.generation;
    // Records read before this refresh reads the state files: it reads them as new or newer.
    const reads = this.recordReads;
    const done = track('sessions refresh');
    const steps = stepTimer();
    try {
      const dir = this.o.stateDir();
      const server = this.o.tmuxServer();
      const showAll = this.o.showAll();
      const listing: Promise<TmuxPane[]>[] = [listPanes(this.o.tmux(server), server)];
      // Showing everything also covers your own (default) tmux server.
      if (showAll && server !== DEFAULT_SERVER) listing.push(listPanes(this.o.tmux(DEFAULT_SERVER), DEFAULT_SERVER));
      const registryDir = this.o.claudeSessionsDir();
      const [paneLists, records, ended, procs, registry, statuses, notes, mailboxes] = await Promise.all([
        Promise.all(listing),
        readHookRecords(dir, this.transcriptEnds),
        readEndedRecords(endedDir(dir)),
        listProcesses(),
        registryDir ? readRegistry(registryDir) : Promise.resolve([]),
        // Claude's own reports (OSC 7501) for sessions run under the Program Status relay: a state for those without
        // hooks, and for hooked ones where the hooks lag or went quiet (statusMerge.ts).
        readProgramStatuses(programStatusDirIn(dir), processAlive),
        // Notes Claude set on its cards (`devdesk note`), by pane.
        readNotes(notesDirIn(dir)),
        // Coordinator and worker sessions (`devdesk worker`): which card works for which.
        readMailboxes(workersDirIn(dir)),
      ]);
      steps.mark('list');
      const tmuxPanes = paneLists.flat();
      // tmux names the foreground process group leader, so `claude; exec $SHELL` shows as a shell: look at the tree.
      const panes = procs
        ? tmuxPanes.map((p) => {
            const claudePid = p.pid ? findDescendant(procs, p.pid, isClaudeCommand) : undefined;
            return p.pid ? { ...p, claude: claudePid !== undefined, ...(claudePid !== undefined ? { claudePid } : {}) } : p;
          })
        : tmuxPanes;
      if (generation !== this.generation) return; // stopped or restarted mid-refresh; discard stale result
      steps.mark('processes');
      const features = await this.featuresFor(sessionsOf(panes.filter((p) => serverOf(p) === server)), generation);
      if (generation !== this.generation) return;
      steps.mark('worktrees');
      const forkParents = showAll ? new Map<string, string>() : await this.forkParents(records, registry);
      if (generation !== this.generation) return;
      steps.mark('forks');
      const split = splitRecords(records, panes, processAlive);
      const { listed, stale } = listableEnded(ended, new Map(split.live.map((r) => [r.sessionId, r.updatedAt])));
      const all = cardsWithWorkers(
        cardsWithNotes(
          cardsWithProgramStatus(buildSessionCards(panes, records, features, processAlive, showAll ? undefined : server, forkParents, listed), statuses, {
            now: Date.now(),
            quietMs: this.o.hooksQuietMs(),
          }),
          notes,
        ),
        mailboxes,
      );
      // The dead record that shows a crash is deleted below: keep the mark while the session stays stopped.
      for (const c of all) if (c.state === 'stopped' && this.crashed.has(c.id)) c.crashed = true;
      this.crashed = new Set(all.filter((c) => c.crashed).map((c) => c.id));
      const next = this.o.workspaceOnly() ? cardsInScope(all, await this.scopeDirs(), features) : all;
      if (generation !== this.generation) return;
      steps.mark('cards');
      await Promise.all([this.addChildren(next), this.addInfo(next, registry)]);
      steps.mark('transcripts');
      if (generation !== this.generation) return;
      for (const r of split.dead) void removeDead(dir, r);
      // Running again (resumed by an older hook script, which leaves the ended record), or nothing left to resume.
      for (const r of stale) void removeEndedRecord(endedDir(dir), r.sessionId);
      // Notes of panes that are gone, on the servers just listed.
      const listedPanes = new Map(listing.map((_, i) => [i === 0 ? server : DEFAULT_SERVER, paneLists[i].map((p) => p.paneId)] as const));
      for (const name of staleNotes(notes.keys(), listedPanes)) void unlink(join(notesDirIn(dir), name)).catch(() => undefined);
      // Every session, also those of other workspaces: a window that lists them may not be open.
      void this.park(all, records, server);
      // What changed since the state files were read, and the sessions just started: as `publish` showed them.
      const now = Date.now();
      for (const [id, r] of this.records) if (r.read <= reads) this.records.delete(id);
      this.commit(next, now);
      steps.mark('listeners');
      noteLatency('sessions refresh', steps.total());
      if (steps.total() >= SLOW_REFRESH_MS) log.debug(`sessions refresh: ${steps.total()}ms (${steps.describe()}), ${this.cards.length} sessions`);
    } catch (err) {
      log.warn(`sessions refresh failed: ${(err as Error).message}`);
    } finally {
      done();
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        if (this.users > 0) void this.refresh();
      }
      // Who waits for a refresh started after they asked: this one, unless they asked while it ran (the rerun is theirs).
      if (!this.running) this.wake();
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Tells parking which sessions the user has read: finished ones they have read park sooner (`parkPlan`). */
  setReadCheck(isRead: (card: SessionCard) => boolean): void {
    this.isRead = isRead;
  }

  /**
   * Parks the DevDesk sessions `parkPlan` picks: keeps each one's record as ended, then kills its tmux session, which
   * ends Claude. Its row stays; opening it resumes the conversation.
   */
  private async park(cards: readonly SessionCard[], records: readonly HookRecord[], server: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastParkCheck < PARK_CHECK_MS) return;
    this.lastParkCheck = now;
    const policy = this.o.parkPolicy();
    if (!(policy.anyMs > 0)) return;
    const below = this.o.parkBelowFreePercent();
    const free = below > 0 ? await this.o.freeMemoryPercent() : undefined;
    const { checked, original } = await this.withChildren(cards, server);
    const read = (c: SessionCard) => this.isRead(original.get(c) ?? c);
    const plan = parkPlan(checked, now, { ...policy, lowMemory: free !== undefined && free < below }, server, read);
    const dir = this.o.stateDir();
    let parked = 0;
    for (const { card, reason } of plan) {
      const why =
        reason === 'memory' ? `memory is low (${free?.toFixed(0)}% free)` : reason === 'limit' ? `more than ${policy.maxLive} sessions run` : reason === 'read' ? 'finished and read' : 'inactive';
      try {
        if (card.state !== 'parked') {
          const record = records.find((r) => r.sessionId === card.sessionId);
          if (!record) continue;
          await writeEndedRecord(endedDir(dir), record, 'parked', now);
        }
        await this.o.tmux(server)(killSessionArgs(card.tmuxSession!));
        parked++;
        log.info(`parked Claude session ${card.sessionId} (tmux ${card.tmuxSession}, ${why}), inactive since ${new Date(card.updatedAt ?? 0).toISOString()}`);
      } catch (err) {
        log.warn(`cannot park Claude session ${card.sessionId}: ${(err as Error).message}`);
      }
    }
    if (parked) this.schedule();
  }

  /**
   * `cards`, with what each parkable one spun off read from its transcript when the view did not list it (another
   * workspace's session, or `devdesk.sessions.showChildren` off), so one still running a subagent or shell is never
   * parked. The listed cards are not changed: `checked` has copies, and `original` maps each copy back.
   */
  private async withChildren(cards: readonly SessionCard[], server: string): Promise<{ checked: SessionCard[]; original: Map<SessionCard, SessionCard> }> {
    const finishedLimit = this.o.finishedChildren() ?? 0;
    const original = new Map<SessionCard, SessionCard>();
    const checked = await Promise.all(
      cards.map(async (card) => {
        if (card.children !== undefined || !card.transcriptPath || !parkable(card, server)) return card;
        const live = card.pid !== undefined && processAlive(card.pid);
        const children = await this.parkChildrenReader.read(card.transcriptPath, { finishedLimit, live, since: card.sessionStartedAt });
        if (!children.length) return card;
        const copy = { ...card, children };
        original.set(copy, card);
        return copy;
      }),
    );
    this.parkChildrenReader.prune();
    return { checked, original };
  }

  dispose(): void {
    this.wake();
    this.users = 0;
    this.stop();
    this.changed.dispose();
    this.waiting.dispose();
  }
}
