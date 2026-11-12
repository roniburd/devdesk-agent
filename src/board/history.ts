import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { BoardSearch } from '../boardSearch';
import { HISTORY_SETTINGS, type HistoryAnswer, historyAnswer, historyCard, historyWorktree, sameIdSet, splitSearchMatches, withStatus } from '../core/boardHistory';
import { searchSessions } from '../core/boardSearch';
import type { BoardData } from '../core/board';
import { launchCwd } from '../core/historyIndex';
import { buildDocs, type HistoryDoc, type HistoryHit, HISTORY_CANDIDATES_MAX, historyDigest, searchCandidates } from '../core/historySearch';
import type { SessionCard } from '../core/sessions';
import type { Feature } from '../core/worktrees';
import {
  boardSearchCommand,
  boardSearchHistory,
  boardSearchHistoryDays,
  boardSearchHistoryDirs,
  boardSearchHistoryMaxSessions,
  boardSearchHistorySaveMs,
  boardSearchHistoryScope,
  boardSearchModel,
  boardSearchTimeoutMs,
  insightsClaude,
  sessionsStateDir,
  workspaceRoot,
} from '../config';
import { HistoryIndexer } from '../historyIndexer';
import { log, track } from '../log';
import { forkSession, openSessionCard, type SessionRowSelector } from '../sessionsCommands';
import type { SessionsModel } from '../sessionsModel';
import type { PanelMessage } from './messages';
import type { Notice } from './types';

/** How often the history index looks for new transcripts while the board is visible. */
const HISTORY_REFRESH_MS = 60_000;

type SearchResult = Extract<PanelMessage, { type: 'searchResult' }>;

/** What the board history needs from the board panel. */
export interface BoardHistoryHost {
  readonly model: SessionsModel;
  /** The Claude view, to select the row of a session opened from the board. */
  readonly tree: SessionRowSelector;
  /** The board's tab is open: history results are posted only then. */
  isOpen(): boolean;
  post(m: PanelMessage): void;
  notice(notice: Notice): void;
  /** Before a session's terminal opens from the board (room beside it). */
  roomFor(card: SessionCard): Promise<void>;
  /** The board as the webview shows it, for the ✨ search. */
  board(): BoardData;
}

/** The last history results posted while the board was open, to tell whether a progress report can repeat them. */
interface Answered {
  /** The board's session ids the results left out: a session joining or leaving the board answers again. */
  excluded: Set<string>;
  /** The docs the results were searched in (undefined: none were built). */
  docs: HistoryDoc[] | undefined;
}

/**
 * The Claude Board's past sessions (Claude's transcripts): the search box's history results, the ✨ search over the
 * board's sessions and the past ones most like the query, and a history result's Resume and Fork.
 */
export class BoardHistory implements vscode.Disposable {
  private readonly search = new BoardSearch({
    model: boardSearchModel,
    command: boardSearchCommand,
    claude: insightsClaude,
    timeoutMs: boardSearchTimeoutMs,
  });
  private readonly index = new HistoryIndexer({
    enabled: boardSearchHistory,
    scope: boardSearchHistoryScope,
    days: boardSearchHistoryDays,
    maxSessions: boardSearchHistoryMaxSessions,
    saveIntervalMs: boardSearchHistorySaveMs,
    root: workspaceRoot,
    projectsDir: boardSearchHistoryDirs,
    stateDir: sessionsStateDir,
    warn: (m) => log.warn(m),
    info: (m) => log.info(m),
    track,
  });
  /** The history's docs and what they were built from (the index's revision): rebuilt only when one of those changed (about 250 ms per 1 000). */
  private docsCache: { docs: HistoryDoc[]; revision: number; features: readonly Feature[]; root?: string; realRoot?: string; scope: 'workspace' | 'all' } | undefined;
  /** The last `historyQuery`, answered again (same `seq`) when the index changes. */
  private query: { query: string; seq: number } | undefined;
  private answered: Answered | undefined;
  /** The last history results posted (for tests). */
  private lastResults: HistoryAnswer | undefined;
  /** The last ✨ search answer posted (for tests). */
  private lastSearchResult: SearchResult | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly host: BoardHistoryHost) {
    this.subscriptions = [
      { dispose: () => this.search.cancel() },
      this.index,
      // New entries: the search box's results again; progress while it indexes: only the progress, unless the docs changed.
      this.index.onDidChange(() => this.answer(this.index.status().building)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Only with the board open (opening it refreshes), and only for what changes the index, not the ✨ model.
        if (!host.isOpen() || !HISTORY_SETTINGS.some((key) => e.affectsConfiguration(key))) return;
        void this.refresh(true);
        // Now, not when a run in flight ends: history turned off empties the lane, a new scope filters it.
        this.answer();
      }),
    ];
  }

  /** The board opened: looks for new transcripts now, then once a minute while `visible`. */
  opened(visible: () => boolean): vscode.Disposable {
    void this.refresh();
    const timer = setInterval(() => {
      if (visible()) void this.refresh();
    }, HISTORY_REFRESH_MS);
    return { dispose: () => clearInterval(timer) };
  }

  /** The board closed: the index and its docs can be about 100 MB, so a board opened again loads them again. */
  release(): void {
    this.search.cancel();
    this.query = undefined;
    this.answered = undefined;
    this.index.release();
    this.docsCache = undefined;
  }

  /** The search box's `historyQuery`: answered now and again as the index changes (an empty query: none to answer). */
  setQuery(query: string, seq: number): void {
    if (!query) {
      this.query = undefined;
      return;
    }
    this.query = { query, seq };
    // At most once a minute; what it finds answers the query again.
    void this.refresh();
    this.answer();
  }

  /** The board is posted: a session resumed or forked from the history is on it now, so it leaves the history results. */
  boardChanged(): void {
    if (this.query && !sameIdSet(this.answered?.excluded, this.boardSessionIds())) this.answer();
  }

  /**
   * The ✨ search: the board's sessions (hidden parked ones too) and, with history on, the past sessions most like the
   * query to the model; posts its answer unless superseded.
   */
  async runSearch(query: string): Promise<void> {
    let outcome: Awaited<ReturnType<typeof this.search.search>>;
    let hits: HistoryHit[] = [];
    try {
      const docs = boardSearchHistory() ? this.docs() : [];
      const { past, board } = docs.length ? searchCandidates(docs, query, { now: Date.now(), limit: HISTORY_CANDIDATES_MAX, onBoard: this.boardSessionIds() }) : { past: [], board: new Map<string, string>() };
      hits = past.map((c) => c.hit);
      const extra = past.map((c) => historyDigest(c.hit, c.doc));
      // Where the board's sessions have the query's words in their whole transcripts, by card id.
      const cardId = this.cardIdOf();
      const found = new Map([...board].map(([id, text]) => [cardId(id), text]));
      outcome = await this.search.search(query, searchSessions(this.host.board(), this.host.model.current), extra, found);
    } catch (err) {
      // Never leave the webview's spinner on.
      log.warn(`board search failed: ${(err as Error).message}`);
      outcome = { error: (err as Error).message };
    }
    if (!outcome) return;
    // A candidate resumed while the model answered is on the board now: it is a board match, not a past session.
    const answer = 'error' in outcome ? outcome : { ...outcome, ...splitSearchMatches(outcome.matches, hits, this.boardSessionIds()) };
    const message: SearchResult = { type: 'searchResult', query, ...answer };
    this.lastSearchResult = message;
    this.host.post(message);
  }

  cancelSearch(): void {
    this.search.cancel();
  }

  /** A history result's Resume: the past session as a parked card, resumed in its folder like one on the board. */
  async resume(id: string): Promise<void> {
    const doc = this.doc(id);
    if (!doc || this.transcriptGone(doc)) return;
    const cwd = launchCwd(doc.entry);
    if (!cwd || !existsSync(cwd)) return this.folderGone(id);
    const card = historyCard(doc, cwd, this.host.model.featureList);
    await this.host.roomFor(card);
    await openSessionCard(this.host.tree, card);
  }

  /** A history result's Fork: a new session from the past one, in its folder, or (`inMain`) in the workspace root. */
  async fork(id: string, inMain: boolean): Promise<void> {
    const doc = this.doc(id);
    if (!doc || this.transcriptGone(doc)) return;
    const cwd = inMain ? workspaceRoot() : launchCwd(doc.entry);
    // No folder open (history scope `all`): there is no main to fork in.
    if (inMain && !cwd) return this.host.notice({ text: 'No workspace folder is open, so there is no main to fork it in.', tone: 'warning' });
    if (!inMain && (!cwd || !existsSync(cwd))) return this.folderGone(id);
    await forkSession(this.host.model, this.host.tree, historyCard(doc, cwd, this.host.model.featureList));
  }

  /** What the e2e tests look at (spread into `testApi`). */
  testHooks() {
    return {
      /** The last ✨ search answer the board posted. */
      boardSearchResult: () => this.lastSearchResult,
      /** How far the board's history index is, a refresh of it now, and the last history results the board posted. */
      boardHistoryStatus: () => this.index.status(),
      boardHistoryRefresh: () => this.refresh(true),
      boardHistoryResults: () => this.lastResults,
    };
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }

  /** Looks for new transcripts (at most once a minute unless `force`); a failure is logged, never thrown. */
  private refresh(force = false): Promise<void> {
    return this.index.refresh(force).catch((err: Error) => log.warn(`board history: cannot index the transcripts: ${err.message}`));
  }

  /**
   * Answers the last `historyQuery` (with its `seq`) from the index as it is now. `progress`: the index reported its
   * progress, so when the docs and the board's sessions are the ones last searched, only the progress is posted again.
   */
  private answer(progress = false): void {
    const q = this.query;
    if (!q || !this.host.isOpen()) return;
    const excluded = this.boardSessionIds();
    const status = this.index.status();
    const prev = this.lastResults;
    let message: HistoryAnswer;
    let docs: HistoryDoc[] | undefined;
    if (progress && prev && this.answersAgain(q, prev, excluded)) {
      message = withStatus(prev, status);
      docs = this.answered?.docs;
    } else {
      const cardId = this.cardIdOf();
      message = historyAnswer(q, { on: boardSearchHistory(), status, docs: () => (docs = this.docs()), now: Date.now(), exclude: excluded, cardId, warn: (m) => log.warn(m) });
    }
    this.answered = { excluded, docs };
    this.lastResults = message;
    this.host.post(message);
  }

  /** `prev` answered this query, with history on, over the same board sessions and the same docs: only its progress needs posting. */
  private answersAgain(q: { query: string; seq: number }, prev: HistoryAnswer, excluded: Set<string>): boolean {
    const a = this.answered;
    if (prev.seq !== q.seq || prev.query !== q.query || prev.off || !boardSearchHistory()) return false;
    return !!a && sameIdSet(a.excluded, excluded) && !!a.docs && a.docs === this.docs();
  }

  /** The id of the board card of a session on the board, by its session id. */
  private cardIdOf(): (sessionId: string) => string {
    const byId = new Map(this.host.model.current.filter((c) => c.sessionId).map((c) => [c.sessionId!, c.id]));
    return (id) => byId.get(id) ?? id;
  }

  /** The sessions on the board: history results leave them out. */
  private boardSessionIds(): Set<string> {
    return new Set(this.host.model.current.map((c) => c.sessionId).filter((id): id is string => !!id));
  }

  /** The history's searchable docs, built again only when the index's entries, the worktrees, the root or the scope changed. */
  private docs(): HistoryDoc[] {
    const revision = this.index.revision;
    const features = this.host.model.featureList;
    const root = workspaceRoot();
    const realRoot = this.index.realRoot;
    const scope = boardSearchHistoryScope();
    const c = this.docsCache;
    if (c && c.revision === revision && c.features === features && c.root === root && c.realRoot === realRoot && c.scope === scope) return c.docs;
    const worktreeOf = (cwd: string | undefined) => historyWorktree(features, cwd);
    const docs = buildDocs(this.index.transcripts(), { root, realRoot, scope, worktreeOf });
    this.docsCache = { docs, revision, features, root, realRoot, scope };
    return docs;
  }

  private doc(id: string): HistoryDoc | undefined {
    return this.docs().find((d) => d.id === id);
  }

  /** Its folder is gone: offer to fork the past session in the workspace root instead. */
  private folderGone(id: string): void {
    this.host.notice({
      text: 'Its folder is gone: fork it in main?',
      tone: 'warning',
      actions: [
        { label: 'Fork in main', run: () => this.fork(id, true) },
        { label: 'Cancel', run: () => undefined },
      ],
    });
  }

  /** The past session's transcript was deleted since it was indexed: Claude could not resume it, so say so instead. */
  private transcriptGone(doc: HistoryDoc): boolean {
    if (existsSync(doc.path)) return false;
    this.host.notice({ text: 'Its transcript is gone (deleted, or cleaned up by Claude Code), so it cannot be resumed or forked.', tone: 'warning' });
    // Indexed again, the result goes.
    void this.refresh(true);
    return true;
  }
}
