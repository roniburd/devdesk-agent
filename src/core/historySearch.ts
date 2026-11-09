import type { SessionDigest } from './boardSearch';
import { foldChars, foldText, parseQuery, type QueryTerm } from './boardSearch';
import { entryInScope, entryTitle, type HistoryEntry, launchCwd } from './historyIndex';
import { formatAgo } from './sessionsView';
import { clip as cut } from './text';

export const HISTORY_RESULTS_MAX = 20;
export const HISTORY_CANDIDATES_MAX = 40;
const EXCERPT_CHARS = 160;
const EXCERPTS_MAX = 3;
const K1 = 1.2;
const B = 0.75;
const WEIGHTS = { title: 3, prompts: 2, files: 2, replies: 1 } as const;
type Field = keyof typeof WEIGHTS;
const WEEK = 7 * 86_400_000;

export interface HistoryDoc {
  id: string;
  /** The transcript it was read from. */
  path: string;
  entry: HistoryEntry;
  title: string;
  worktree: string;
  /** `worktree` folded, for `wt:`. */
  worktreeFolded: string;
  at: number;
  fields: Record<Field, string>;
}

export function buildDocs(
  transcripts: readonly { path: string; entry: HistoryEntry }[],
  o: { root?: string; realRoot?: string; scope: 'workspace' | 'all'; worktreeOf: (cwd: string | undefined) => string },
): HistoryDoc[] {
  const byId = new Map<string, { path: string; entry: HistoryEntry }>();
  for (const t of transcripts) {
    const e = t.entry;
    if (!e.sessionId || !entryInScope(e, o.root, o.scope, o.realRoot)) continue;
    const had = byId.get(e.sessionId);
    if (!had || (e.lastAt ?? 0) >= (had.entry.lastAt ?? 0)) byId.set(e.sessionId, t);
  }
  return [...byId.values()].map(({ path, entry: e }) => {
    const title = entryTitle(e);
    const worktree = o.worktreeOf(launchCwd(e));
    return { id: e.sessionId!, path, entry: e, title, worktree, worktreeFolded: foldText(worktree), at: e.lastAt ?? e.firstAt ?? 0, fields: fieldsOf(e, title) };
  });
}

/** Each entry's folded fields: the index keeps an unchanged transcript's entry, so a rebuild folds only the changed ones. */
const folded = new WeakMap<HistoryEntry, Record<Field, string>>();
function fieldsOf(e: HistoryEntry, title: string): Record<Field, string> {
  let f = folded.get(e);
  if (!f) {
    const text = (role: 'user' | 'claude') => foldText(e.turns.filter((t) => t.role === role).map((t) => t.text).join('\n'));
    f = { title: foldText(`${title} ${e.recap ?? ''}`), prompts: text('user'), files: foldText(e.files.join(' ')), replies: text('claude') };
    folded.set(e, f);
  }
  return f;
}

/** Folds `s` like `foldText` (without collapsing whitespace), keeping where each folded character came from. */
export function foldWithMap(s: string): { folded: string; map: number[] } {
  // Plain ASCII keeps its length when lowercased: the map is the identity.
  if (!/[^\x00-\x7f]/.test(s)) {
    const identity: number[] = [];
    for (let k = 0; k < s.length; k++) identity.push(k);
    return { folded: s.toLowerCase(), map: identity };
  }
  const parts: string[] = [];
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = foldChars(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    parts.push(f);
    i += ch.length;
  }
  return { folded: parts.join(''), map };
}

/** Occurrences counted per field: BM25 has long saturated by then, and a common word costs no full scan. */
const TF_MAX = 16;

const count = (hay: string, needle: string): number => {
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0 && n < TF_MAX; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
};

const FIELDS = Object.keys(WEIGHTS) as Field[];
const lengths = new WeakMap<Record<Field, string>, number>();
const weightedLength = (d: HistoryDoc) => {
  let n = lengths.get(d.fields);
  if (n === undefined) {
    n = FIELDS.reduce((sum, f) => sum + WEIGHTS[f] * d.fields[f].length, 0);
    lengths.set(d.fields, n);
  }
  return n;
};

/** BM25F scorer; each document is scanned once per term, and the counts serve both the document frequency and the score. */
function scorer(docs: readonly HistoryDoc[], terms: readonly string[], now: number) {
  const n = docs.length || 1;
  const avg = docs.reduce((s, d) => s + weightedLength(d), 0) / n || 1;
  const tfs = new Map<HistoryDoc, number[]>();
  const df = terms.map(() => 0);
  for (const d of docs) {
    const row = terms.map((t, i) => {
      const tf = FIELDS.reduce((sum, f) => sum + WEIGHTS[f] * count(d.fields[f], t), 0);
      if (tf) df[i]++;
      return tf;
    });
    tfs.set(d, row);
  }
  const idf = df.map((c) => Math.log(1 + (n - c + 0.5) / (c + 0.5)));
  const score = (d: HistoryDoc): number => {
    const len = weightedLength(d);
    const row = tfs.get(d);
    let s = 0;
    if (row) {
      row.forEach((tf, i) => {
        if (tf) s += idf[i] * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avg)));
      });
    }
    const age = Math.max(0, now - d.at);
    return s * (1 + 0.5 * Math.exp(-age / WEEK));
  };
  /** Per term, whether the document contains it in any field. */
  const has = (d: HistoryDoc) => (tfs.get(d) ?? []).map((tf) => tf > 0);
  return { score, has };
}

const facetOk = (d: HistoryDoc, terms: readonly QueryTerm[]) =>
  terms.every((t) => (t.field === 'wt' ? d.worktreeFolded.includes(t.text) : t.field === 'is' ? 'history'.includes(t.text) : true));

/** `i`, or one before it when `i` would split a surrogate pair. */
const pairStart = (text: string, i: number) => (i > 0 && i < text.length && /[\uDC00-\uDFFF]/.test(text[i]) && /[\uD800-\uDBFF]/.test(text[i - 1]) ? i - 1 : i);

const NON_ASCII = /[^\x00-\x7f]/;

/** Up to `EXCERPTS_MAX` windows of about `EXCERPT_CHARS` around matches, prompts first, with the matches' spans. */
function excerpts(e: HistoryEntry, words: readonly string[]): Excerpt[] {
  const out: Excerpt[] = [];
  const turns = [...e.turns.filter((t) => t.role === 'user'), ...e.turns.filter((t) => t.role === 'claude')];
  for (const turn of turns) {
    if (out.length >= EXCERPTS_MAX || !words.length) break;
    // Plain ASCII folds to its lowercase: a turn with none of the words is skipped before it is folded.
    if (!NON_ASCII.test(turn.text)) {
      const lower = turn.text.toLowerCase();
      if (!words.some((w) => lower.includes(w))) continue;
    }
    const text = turn.text.replace(/\s+/g, ' ').trim();
    const { folded, map } = foldWithMap(text);
    const first = Math.min(...words.map((w) => folded.indexOf(w)).filter((i) => i >= 0));
    if (!Number.isFinite(first)) continue;
    // The window's ends never split a surrogate pair (an emoji).
    const startOrig = pairStart(text, Math.max(0, map[first] - Math.floor(EXCERPT_CHARS / 3)));
    const endOrig = pairStart(text, Math.min(text.length, startOrig + EXCERPT_CHARS));
    const lead = startOrig > 0 ? '…' : '';
    const tail = endOrig < text.length ? '…' : '';
    out.push({ text: `${lead}${text.slice(startOrig, endOrig)}${tail}`, spans: spansIn(text, folded, map, words, startOrig, endOrig, lead.length) });
  }
  return out;
}

/**
 * Where `words` match in `text` (through its `folded` form and `map` back), as spans of the window `[start, end)`
 * shifted by `shift`; overlapping matches (`auth` in `authentication`) keep the first, longest one.
 */
function spansIn(text: string, folded: string, map: readonly number[], words: readonly string[], start: number, end: number, shift: number): [number, number][] {
  const spans: [number, number][] = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) {
      const s = map[at];
      const lastFolded = at + w.length - 1;
      let e = map[lastFolded] + (text.codePointAt(map[lastFolded])! > 0xffff ? 2 : 1);
      // The accents folded away after the match are part of it (`e` + U+0301).
      while (e < text.length && /[\u0300-\u036f]/.test(text[e])) e++;
      if (s >= start && e <= end) spans.push([s - start + shift, e - start + shift]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept: [number, number][] = [];
  for (const sp of spans) if (sp[0] >= (kept[kept.length - 1]?.[1] ?? 0)) kept.push(sp);
  return kept;
}

export interface Excerpt {
  text: string;
  /** `[start, end)` of each match in `text`. */
  spans: [number, number][];
}

export interface HistoryHit {
  id: string;
  title: string;
  worktree: string;
  ago: string;
  at: number;
  excerpts: Excerpt[];
  files: string[];
}

const hit = (d: HistoryDoc, words: readonly string[], now: number): HistoryHit => ({
  id: d.id,
  title: d.title,
  worktree: d.worktree,
  ago: formatAgo(d.at, now),
  at: d.at,
  excerpts: excerpts(d.entry, words),
  files: d.entry.files.slice(-5),
});

/** The `limit` best-scored of `pool` (ties: the newest), as hits with excerpts of `words`. */
function top(pool: readonly HistoryDoc[], score: (d: HistoryDoc) => number, limit: number, words: readonly string[], now: number): { hit: HistoryHit; doc: HistoryDoc }[] {
  return pool
    .map((d) => ({ d, s: score(d) }))
    .sort((a, b) => b.s - a.s || b.d.at - a.d.at)
    .slice(0, limit)
    .map(({ d }) => ({ hit: hit(d, words, now), doc: d }));
}

/** The typed query's matches: past sessions (`past`, newest first) and the board's sessions (`board`, best first). */
export interface TranscriptHits {
  past: HistoryHit[];
  board: HistoryHit[];
}

/**
 * The search box's matches in the transcripts: every word of the query in a session's prompts, replies, files or title.
 * Past sessions are the ones not in `onBoard` (at most `limit`, and the `wt:`/`is:` words apply); the board's sessions
 * are matched on the words only, as their cards apply `wt:` and `is:` (to the board's lane and look, not `history`).
 */
export function searchTranscripts(docs: readonly HistoryDoc[], query: string, o: { now: number; limit: number; onBoard: ReadonlySet<string> }): TranscriptHits {
  const terms = parseQuery(query);
  if (!terms.length) return { past: [], board: [] };
  // A word typed twice counts once (and costs one scan).
  const words = [...new Set(terms.filter((t) => t.field === 'all').map((t) => t.text))];
  // Scored over all the docs: the document frequencies and the average length are the whole history's.
  const { score, has } = scorer(docs, words, o.now);
  const all = (d: HistoryDoc) => has(d).every(Boolean);
  const pool = docs.filter((d) => !o.onBoard.has(d.id) && facetOk(d, terms) && all(d));
  // No words (only `wt:` or `is:`): the cards' own fields decide, every board session would "match" here.
  const onBoard = words.length && o.onBoard.size ? docs.filter((d) => o.onBoard.has(d.id) && all(d)) : [];
  const past = top(pool, score, o.limit, words, o.now)
    .map((c) => c.hit)
    .sort((a, b) => b.at - a.at);
  return { past, board: top(onBoard, score, onBoard.length, words, o.now).map((c) => c.hit) };
}

/** What the ✨ model is given from the transcripts: past sessions to pick from, and where the board's sessions match. */
export interface SearchCandidates {
  /** The best matches of the query's words (any of them), then the newest others; each with its doc. */
  past: { hit: HistoryHit; doc: HistoryDoc }[];
  /** The board's sessions (`onBoard`) with any of the words, best first (at most `limit`): id → their best excerpt. */
  board: Map<string, string>;
}

export function searchCandidates(docs: readonly HistoryDoc[], query: string, o: { now: number; limit: number; onBoard: ReadonlySet<string> }): SearchCandidates {
  const terms = parseQuery(query);
  const words = [...new Set(terms.filter((t) => t.field === 'all' && t.text.length >= 3).map((t) => t.text))];
  const pool = docs.filter((d) => !o.onBoard.has(d.id) && facetOk(d, terms));
  const { score, has } = scorer(docs, words, o.now);
  const any = (d: HistoryDoc) => has(d).some(Boolean);
  const matched = top(pool.filter(any), score, o.limit, words, o.now);
  const taken = new Set(matched.map((c) => c.doc.id));
  const newest = pool.filter((d) => !taken.has(d.id)).sort((a, b) => b.at - a.at).slice(0, o.limit - matched.length).map((d) => ({ hit: hit(d, [], o.now), doc: d }));
  const board = new Map<string, string>();
  const live = words.length && o.onBoard.size ? docs.filter((d) => o.onBoard.has(d.id) && any(d)) : [];
  for (const { hit: h } of top(live, score, o.limit, words, o.now)) {
    const text = h.excerpts[0]?.text;
    if (text) board.set(h.id, text);
  }
  return { past: [...matched, ...newest], board };
}

/** What the ✨ model reads about a past session: about 600 characters, as a board digest. */
export function historyDigest(h: HistoryHit, d: HistoryDoc): SessionDigest {
  const prompts = d.entry.turns.filter((t) => t.role === 'user').map((t) => t.text);
  const picked = prompts.length <= 3 ? prompts : [prompts[0], ...prompts.slice(-2)];
  const digest: SessionDigest = {
    id: h.id,
    title: cut(h.title, 60) ?? '',
    worktree: h.worktree,
    state: 'History: ended',
    ago: h.ago,
    prompts: picked.map((p) => cut(p, 70)).filter((p): p is string => !!p),
  };
  const recap = cut(d.entry.recap, 120);
  if (recap) digest.recap = recap;
  const insight = cut(h.excerpts[0]?.text, 160);
  if (insight) digest.insight = insight;
  if (h.files.length) digest.ask = cut(`Files: ${h.files.map((f) => f.split('/').pop()).join(', ')}`, 100);
  return digest;
}
