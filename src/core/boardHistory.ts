import { parseQuery, type SearchMatch } from './boardSearch';
import { type Excerpt, type HistoryDoc, type HistoryHit, HISTORY_RESULTS_MAX, searchTranscripts } from './historySearch';
import { featureForCwd, type SessionCard } from './sessions';
import { isWithin } from './paths';
import { type Feature, featureDirs } from './worktrees';

// The Claude Board's past sessions (from the history index) as the panel handles them.

const WORKTREE_DIR = /\/(?:\.claude\/)?worktrees\/([^/]+)/;

/**
 * The worktree label of a past session launched in `cwd`: the worktree it is in; for a removed one (no worktree
 * matches, or only main does and the path is under `<main>/worktrees/<name>` or `<main>/.claude/worktrees/<name>`), its
 * `<name>`, so the result still says which one it was.
 */
export function historyWorktree(features: readonly Feature[], cwd: string | undefined): string {
  if (!cwd) return 'no worktree';
  const feature = featureForCwd(features, cwd);
  if (feature && !feature.isMain) return feature.name;
  const dirs = feature ? featureDirs(feature).filter((d) => isWithin(cwd, d)) : [''];
  for (const dir of dirs) {
    const m = WORKTREE_DIR.exec(cwd.slice(dir.length));
    if (m && (!feature || m.index === 0)) return m[1];
  }
  return feature?.name ?? 'no worktree';
}

/** A parked card for past session `doc` in `cwd`, so Resume and Fork go the way they go for a board card. */
export function historyCard(doc: HistoryDoc, cwd: string | undefined, features: readonly Feature[]): SessionCard {
  const feature = cwd ? featureForCwd(features, cwd) : undefined;
  return {
    id: doc.id,
    sessionId: doc.id,
    ...(cwd ? { cwd } : {}),
    state: 'parked',
    detail: '',
    attached: false,
    ...(feature ? { featureName: feature.name, featureDir: feature.dir } : {}),
  };
}

/**
 * A ✨ answer's matches split: the board's sessions stay in `matches`; past sessions (`hits`) go to `historyMatches`,
 * unless they are on the board now (`onBoard`: resumed while the model answered).
 */
export function splitSearchMatches(
  matches: readonly SearchMatch[],
  hits: readonly HistoryHit[],
  onBoard: ReadonlySet<string> = new Set(),
): { matches: SearchMatch[]; historyMatches?: (HistoryHit & { reason: string })[] } {
  const byId = new Map(hits.filter((h) => !onBoard.has(h.id)).map((h) => [h.id, h]));
  const board: SearchMatch[] = [];
  const history: (HistoryHit & { reason: string })[] = [];
  for (const m of matches) {
    const h = byId.get(m.id);
    if (h) history.push({ ...h, reason: m.reason });
    else board.push(m);
  }
  return { matches: board, ...(history.length ? { historyMatches: history } : {}) };
}

/** The board shows the same sessions as before (`previous` undefined: none known yet), so history results still leave out the right ones. */
export function sameIdSet(previous: ReadonlySet<string> | undefined, next: ReadonlySet<string>): boolean {
  if (!previous || previous.size !== next.size) return false;
  for (const id of next) if (!previous.has(id)) return false;
  return true;
}

/** The settings that change what the history index holds (the other `devdesk.boardSearch` ones are the ✨ model's). */
export const HISTORY_SETTINGS = [
  'devdesk.boardSearch.history',
  'devdesk.boardSearch.historyScope',
  'devdesk.boardSearch.historyDays',
  'devdesk.boardSearch.historyDir',
] as const;

/** A board session found in its transcript: its id and where the words are. */
export interface BoardTextHit {
  id: string;
  excerpt?: Excerpt;
}

/**
 * The `historyResults` message, the answer to `historyQuery` number `seq` (posted again, with the same `seq`, when the
 * index changes): past sessions not on the board; `onBoard`, the board's sessions whose transcript has the query's
 * words (their cards show although their own texts do not match); `indexing` while the index is being built; `off`
 * when history search is turned off.
 */
export interface HistoryAnswer {
  type: 'historyResults';
  seq: number;
  query: string;
  results: HistoryHit[];
  onBoard?: BoardTextHit[];
  indexing?: { indexed: number; total: number };
  off?: true;
}

/**
 * The answer to the search box's history query: `off`; no results for a query with no terms (without building the
 * docs); else the matches. A search that throws answers no results (and is logged), so the lane never keeps waiting.
 */
export function historyAnswer(
  q: { query: string; seq: number },
  o: {
    on: boolean;
    status: { indexed: number; total: number; building: boolean };
    docs: () => readonly HistoryDoc[];
    now: number;
    /** The board's sessions: matched for `onBoard`, not listed as past sessions. */
    exclude: ReadonlySet<string>;
    /** The id of the board card of session `sessionId` (a card's id is its session's, unless it was found by tmux alone). */
    cardId?: (sessionId: string) => string;
    warn: (message: string) => void;
  },
): HistoryAnswer {
  const head = { type: 'historyResults' as const, seq: q.seq, query: q.query };
  if (!o.on) return { ...head, results: [], off: true };
  const indexing = o.status.building ? { indexing: { indexed: o.status.indexed, total: o.status.total } } : {};
  let results: HistoryHit[] = [];
  let onBoard: BoardTextHit[] = [];
  if (parseQuery(q.query).length) {
    try {
      const hits = searchTranscripts(o.docs(), q.query, { now: o.now, limit: HISTORY_RESULTS_MAX, onBoard: o.exclude });
      results = hits.past;
      const cardId = o.cardId ?? ((id: string) => id);
      onBoard = hits.board.map((h) => ({ id: cardId(h.id), ...(h.excerpts[0] ? { excerpt: h.excerpts[0] } : {}) }));
    } catch (err) {
      o.warn(`board history: search failed: ${(err as Error).message}`);
    }
  }
  return { ...head, results, ...(onBoard.length ? { onBoard } : {}), ...indexing };
}

/** `previous` with the index's progress now: while it builds and only the progress changed, the search is not run again. */
export function withStatus(previous: HistoryAnswer, status: { indexed: number; total: number; building: boolean }): HistoryAnswer {
  const { indexing: _, ...rest } = previous;
  return { ...rest, ...(status.building ? { indexing: { indexed: status.indexed, total: status.total } } : {}) };
}
