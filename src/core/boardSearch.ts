import { createHash } from 'node:crypto';
import type { BoardData, BoardSession } from './board';
import { promptText } from './insights';
import { parseObject } from './json';
import type { SessionCard } from './sessions';

// Searching the Claude Board's sessions: the as-you-type matcher (media/board.js has a copy; keep them the same, see
// test/boardSearchWebview.test.ts) and, for Enter, the digests, request and answer of the model's search.

/** Lowercase, accents removed (whitespace kept): `foldText` without the collapsing, also used a character at a time. */
export const foldChars = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Lowercase, accents removed, whitespace collapsed: what queries and card texts are compared as. */
export function foldText(s: string): string {
  return foldChars(s).replace(/\s+/g, ' ').trim();
}

/** A card's texts as the matcher reads them: everything, the worktree name, and its lane, look and state. */
export interface SearchFields {
  all: string;
  wt: string;
  is: string;
}

/** One word of a query: `wt:name` looks at the worktree only, `is:state` at the state only, any other word at everything. */
export interface QueryTerm {
  field: keyof SearchFields;
  text: string;
}

/** How many parked sessions `parkedLimit` hides are still sent to the board, to be searched (the newest). */
export const HIDDEN_PARKED_MAX = 150;

export function parseQuery(query: string): QueryTerm[] {
  return foldText(query)
    .split(' ')
    .filter(Boolean)
    .flatMap((word): QueryTerm[] => {
      const m = /^(wt|is):(.*)$/.exec(word);
      if (!m) return [{ field: 'all', text: word }];
      return m[2] ? [{ field: m[1] as 'wt' | 'is', text: m[2] }] : [];
    });
}

/** Every term is a substring of its field; true with no terms. */
export function matchesQuery(fields: SearchFields, terms: readonly QueryTerm[]): boolean {
  return terms.every((t) => fields[t.field].includes(t.text));
}

export function searchFields(o: {
  title: string;
  worktree: string;
  laneTitle: string;
  lookLabel: string;
  state: string;
  model?: string;
  texts: readonly (string | undefined)[];
}): SearchFields {
  const is = foldText(`${o.laneTitle} ${o.lookLabel} ${o.state}`);
  const wt = foldText(o.worktree);
  const all = foldText([o.title, ...o.texts.filter(Boolean), o.worktree, is, o.model ?? ''].join(' '));
  return { all, wt, is };
}

// ---- Enter: the model's search --------------------------------------------------------------------------------

/** What the divider in the board's Done / idle lane says, above its idle cards. */
export const IDLE_DIVIDER = 'Idle / stopped';

/**
 * The lane a card is searched (and told to ✨) by: in the Done / idle lane, its part of it, `Done / to review` above the
 * divider and `Idle / stopped` under it (the lanes they were, so `is:review` and `is:idle` still find them).
 */
export function searchLane(laneId: string, laneTitle: string, idle: boolean | undefined): string {
  if (laneId !== 'review') return laneTitle;
  return idle ? IDLE_DIVIDER : 'Done / to review';
}

/** A session the model may pick: its card as the board shows it, its lane, and the session behind it. */
export interface SearchSession {
  session: BoardSession;
  laneTitle: string;
  card?: SessionCard;
}

/** How many sessions one search sends: the board's cards first, then the hidden parked ones. */
export const SEARCH_SESSIONS_MAX = 300;

export function searchSessions(board: BoardData, cards: readonly SessionCard[]): SearchSession[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lanes = board.lanes.filter((l) => l.id !== 'backlog');
  const of = (list: (l: (typeof lanes)[number]) => readonly BoardSession[]) =>
    lanes.flatMap((l) => list(l).map((session) => ({ session, laneTitle: searchLane(l.id, l.title, session.idle), card: byId.get(session.id) })));
  return [...of((l) => l.sessions), ...of((l) => l.hidden ?? [])].slice(0, SEARCH_SESSIONS_MAX);
}

/** What the model reads about one session: about 600 characters at most. */
export interface SessionDigest {
  id: string;
  title: string;
  worktree: string;
  /** The lane and the look: `Needs you: QUESTION FOR YOU`. */
  state: string;
  /** How long ago it last changed, as the board says it (`5m`, `2d`). */
  ago: string;
  model?: string;
  /** Claude's own recap of the session. */
  recap?: string;
  /** DevDesk's Haiku summary or title. */
  insight?: string;
  /** What Claude asks (Needs you). */
  ask?: string;
  /** The session's prompt, then its latest user prompts. */
  prompts: string[];
  /** Where the query's words are in its whole transcript (a board session's prompts above are only its latest). */
  found?: string;
}

const cut = (s: string | undefined, max: number): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};
const DIGEST = { title: 60, recap: 140, insight: 80, ask: 80, prompt: 60, prompts: 4, found: 160 } as const;

/** The last `n` user prompts in a transcript's lines, oldest first, without repeats (meta lines and tool results skipped). */
export function recentPrompts(lines: readonly string[], n = 3): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const e = parseObject(line) as { type?: unknown; isMeta?: unknown; isSidechain?: unknown; message?: { content?: unknown } } | undefined;
    if (!e || e.type !== 'user' || e.isMeta === true || e.isSidechain === true) continue;
    const p = promptText(e.message?.content);
    if (p && found.at(-1) !== p) found.push(p);
  }
  return found.slice(-n);
}

export function buildDigest(s: SearchSession, prompts: readonly string[], found?: string): SessionDigest {
  const { session: b, card } = s;
  const all = [card?.prompt, ...prompts].map((p) => cut(p, DIGEST.prompt)).filter((p): p is string => !!p);
  const unique = [...new Set(all)];
  const kept = unique.length <= DIGEST.prompts ? unique : [unique[0], ...unique.slice(-(DIGEST.prompts - 1))];
  const digest: SessionDigest = { id: b.id, title: cut(b.title, DIGEST.title) ?? '', worktree: b.worktree, state: `${s.laneTitle}: ${b.lookLabel}`, ago: b.ago, prompts: kept };
  const recap = cut(card?.summary, DIGEST.recap);
  const insight = cut(b.insight || card?.insightTitle, DIGEST.insight);
  const ask = cut(b.ask, DIGEST.ask);
  if (b.model) digest.model = b.model;
  if (recap) digest.recap = recap;
  if (insight) digest.insight = insight;
  if (ask) digest.ask = ask;
  const where = cut(found, DIGEST.found);
  if (where) digest.found = where;
  return digest;
}

/** What the model is told: given in the request to a custom command, as the system prompt to `claude -p`. */
export const SEARCH_PROMPT = [
  'You find Claude Code sessions for a developer on their board of sessions.',
  'The input is JSON: `query` (what they look for), `now` (the current time, ISO 8601) and `sessions`, each with an `id`,',
  'a `title`, its `worktree`, its `state` (the board lane, or for an idle one "Idle / stopped", then how it looks:',
  '"Needs you: QUESTION FOR YOU", "Idle / stopped: PARKED (NOT RUNNING)"), `ago` (how long since it changed: "5m", "3h", "2d"), maybe its `model`, Claude\'s `recap`,',
  'a short `insight`, what Claude `ask`s, `prompts` (what the developer asked, oldest first), and maybe `found` (where the',
  'query\'s words are in its whole conversation: a session with `found` contains them, even when nothing else mentions them).',
  'Pick the sessions the query is about: by meaning, not only by words ("the flaky test one" can match "fix intermittent',
  'failure in ParserTest"), by state ("blocked", "waiting on me", "parked") and by time ("yesterday", "this morning",',
  'using `now` and `ago`).',
  'Answer with JSON only, no prose and no code fence: {"matches":[{"id":"<id from the input>","reason":"<why, at most 12',
  'words>"}],"note":"<optional, one short sentence>"}.',
  'Best matches first. Only ids from the input. When nothing fits, answer {"matches":[]} rather than guess.',
].join(' ');

/** What a search sends to the backend (on stdin). */
export interface SearchRequest {
  /** `SEARCH_PROMPT`, for a custom command (`claude -p` gets it as its system prompt instead). */
  instructions?: string;
  query: string;
  /** The current time, ISO 8601. */
  now: string;
  sessions: SessionDigest[];
}

export function buildRequest(query: string, now: number, digests: SessionDigest[], withInstructions: boolean): SearchRequest {
  return { ...(withInstructions ? { instructions: SEARCH_PROMPT } : {}), query, now: new Date(now).toISOString(), sessions: digests };
}

export interface SearchMatch {
  id: string;
  /** Why the model picked it, in one line (may be empty). */
  reason: string;
}

export interface SearchAnswer {
  matches: SearchMatch[];
  note?: string;
}

const REASON_MAX = 160;

/** The model's answer: matches among `ids` only, each once, reasons one line; undefined when it is not the asked JSON. */
export function parseSearchAnswer(reply: string, ids: ReadonlySet<string>): SearchAnswer | undefined {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  const o = parseObject(reply.slice(start, end + 1));
  if (!o || !Array.isArray(o.matches)) return undefined;
  const seen = new Set<string>();
  const matches: SearchMatch[] = [];
  for (const m of o.matches) {
    if (!m || typeof m !== 'object') continue;
    const { id, reason } = m as Record<string, unknown>;
    if (typeof id !== 'string' || !ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    matches.push({ id, reason: (typeof reason === 'string' && cut(reason, REASON_MAX)) || '' });
  }
  const note = typeof o.note === 'string' ? cut(o.note, REASON_MAX) : undefined;
  return note ? { matches, note } : { matches };
}

/** A search's answer is reused for the same backend (command or model), the same folded query and the same digests. */
export function searchCacheKey(backend: string, query: string, digests: readonly SessionDigest[]): string {
  return createHash('sha1').update(JSON.stringify([backend, foldText(query), digests])).digest('hex');
}
