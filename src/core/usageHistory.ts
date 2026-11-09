import { parseObject } from './json';
import { formatTokens, parseLedgerLine, type Tokens, type UsageScan } from './usage';
import { DEVDESK, devdeskPlace, MAIN, OTHER, type Place, type PlaceKind, placeResolver, projectLabels, projectTitle, unknownPlace } from './usagePlace';

/**
 * Token usage by day, kept past Claude Code's transcript cleanup in `<state dir>/usage-history.jsonl`: one line per
 * finished day (today is always counted live), pruned to `devdesk.usage.historyDays` days and
 * `devdesk.usage.historyMaxMB` bytes. Pure: the reading and writing is in `usageService.ts`.
 */

export interface SessionDay extends Tokens {
  sessionId: string;
  /** The session's name when the day was counted (the session may be gone later). */
  name: string;
}

export interface DayUsage {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
  sessions: Tokens;
  /**
   * Tokens by model, largest first: the sessions' models, and DevDesk's own calls as `<model> (DevDesk)` (counted in
   * `devdesk`, not `sessions`), so a Haiku that only DevDesk used shows up too.
   */
  byModel: { model: string; tokens: Tokens }[];
  /** The day's sessions by total, largest first: the top ones, then {@link OTHER} for the rest. */
  bySession: SessionDay[];
  devdesk: Tokens & { failed: number };
  /**
   * Tokens by place, largest first: the top {@link TOP_PLACES_PER_DAY}, then {@link OTHER}; DevDesk's calls are the
   * place {@link DEVDESK}. Undefined: a day stored before places were counted and not counted again yet; `'unknown'`: one
   * that could not be. Read it through {@link placesOf}.
   */
  byPlace?: PlaceDay[] | 'unknown';
}

/** A day's usage in one place (project and worktree): its tokens, models and top sessions. */
export interface PlaceDay extends Place {
  tokens: Tokens;
  byModel: { model: string; tokens: Tokens }[];
  /** The place's sessions by total: the top ones, then {@link OTHER}. */
  bySession: SessionDay[];
}

/** The session id of a day's sessions past its top ones, summed (and the project of its places past the top ones). */
export { OTHER };
/** Marks DevDesk's own calls in a day's models. */
const DEVDESK_MODEL_SUFFIX = '(DevDesk)';
/** Sessions kept by name for a day; the rest are summed as {@link OTHER}. */
const TOP_SESSIONS_PER_DAY = 20;
/** Places kept for a day; the rest are summed as {@link OTHER}. */
const TOP_PLACES_PER_DAY = 30;
/** Sessions kept by name for each of a day's places. */
const TOP_SESSIONS_PER_PLACE = 5;

export const noTokens = (): Tokens => ({ total: 0, cached: 0, requests: 0 });
export const addTokens = (t: Tokens, e: Tokens) => {
  t.total += e.total;
  t.cached += e.cached;
  t.requests += e.requests;
};
const addKey = (m: Map<string, Tokens>, key: string, one: Tokens) => {
  let t = m.get(key);
  if (!t) m.set(key, (t = noTokens()));
  addTokens(t, one);
};
const modelsOf = (m: ReadonlyMap<string, Tokens>) => [...m].map(([model, tokens]) => ({ model, tokens: { ...tokens } })).sort((x, y) => y.tokens.total - x.tokens.total);
const isDevdeskModel = (model: string) => model.endsWith(` ${DEVDESK_MODEL_SUFFIX}`);
const pad = (v: number) => String(v).padStart(2, '0');
const parts = (key: string) => key.split('-').map(Number) as [number, number, number];

/** The local date `ms` is in, `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight starting a day. */
export function dayStart(key: string): number {
  const [y, m, d] = parts(key);
  return new Date(y, m - 1, d).getTime();
}

/** The day `n` days after (or before, negative) `key`. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = parts(key);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

/** The Monday starting the week a day is in. */
export function weekOf(key: string): string {
  const [y, m, d] = parts(key);
  const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return addDays(key, -weekday);
}

/** The first day of the month a day is in. */
const monthOf = (key: string): string => `${key.slice(0, 7)}-01`;

/** `63M (55%)`: cached tokens with their share of the total. */
export function formatShare(cached: number, total: number): string {
  if (!total) return formatTokens(cached);
  return `${formatTokens(cached)} (${Math.round((100 * cached) / total)}%)`;
}

/** Keeps a day's top sessions, summing the rest as {@link OTHER}. */
function capSessions(list: SessionDay[], top: number): SessionDay[] {
  const sorted = [...list].sort((a, b) => b.total - a.total);
  if (sorted.length <= top) return sorted;
  const kept = sorted.slice(0, top);
  const rest = sorted.slice(top);
  const other: SessionDay = { sessionId: OTHER, name: '', ...noTokens() };
  for (const s of rest) addTokens(other, s);
  other.name = `${rest.length} other sessions`;
  return [...kept, other];
}

const byTotal = (a: PlaceDay, b: PlaceDay) => b.tokens.total - a.tokens.total;

/**
 * Keeps a day's top places, summing the rest as one {@link OTHER} place (its sessions as one). DevDesk's place is
 * always kept (counted in `top`), so that a project scope, {@link OTHER} included, never holds DevDesk's calls.
 */
function capPlaces(list: PlaceDay[], top: number): PlaceDay[] {
  const devdesk = list.filter((p) => p.project === DEVDESK);
  const sorted = list.filter((p) => p.project !== DEVDESK).sort(byTotal);
  const n = Math.max(0, top - devdesk.length);
  const kept = [...sorted.slice(0, n), ...devdesk].sort(byTotal);
  if (sorted.length <= n) return kept;
  const rest = sorted.slice(n);
  const tokens = noTokens();
  const models = new Map<string, Tokens>();
  for (const p of rest) {
    addTokens(tokens, p.tokens);
    for (const m of p.byModel) addKey(models, m.model, m.tokens);
  }
  const sessions: SessionDay = { sessionId: OTHER, name: `${rest.length} other projects' sessions`, ...tokens };
  return [...kept, { project: OTHER, kind: 'folder', worktree: MAIN, tokens, byModel: modelsOf(models), bySession: [sessions] }];
}

/**
 * A day's places: as counted, else (a day stored before places were) its sessions' usage as the Unknown project and
 * DevDesk's calls as {@link DEVDESK}.
 */
export function placesOf(d: DayUsage): PlaceDay[] {
  if (Array.isArray(d.byPlace)) return d.byPlace;
  const out: PlaceDay[] = [];
  if (d.sessions.requests) {
    out.push({ ...unknownPlace(), tokens: { ...d.sessions }, byModel: d.byModel.filter((m) => !isDevdeskModel(m.model)), bySession: d.bySession });
  }
  if (d.devdesk.requests) {
    const { failed: _failed, ...tokens } = d.devdesk;
    out.push({ ...devdeskPlace(), tokens, byModel: d.byModel.filter((m) => isDevdeskModel(m.model)), bySession: [] });
  }
  return out;
}

/**
 * A day stored before places were counted (`old`), after counting it again from what is left of its transcripts and of
 * DevDesk's ledger (`recount`): its sessions, and DevDesk's calls, each from the recount when it found as many
 * requests, else as stored (part of the transcripts is gone, or the ledger was trimmed). A day whose sessions could not
 * be recounted keeps them all in the Unknown project, marked `byPlace: 'unknown'` so it is not recounted again.
 */
export function upgradeDay(old: DayUsage, recount: DayUsage | undefined): DayUsage {
  if (!recount || recount.sessions.requests < old.sessions.requests) return { ...old, byPlace: 'unknown' };
  if (recount.devdesk.requests >= old.devdesk.requests) return { ...recount, day: old.day };
  return {
    day: old.day,
    sessions: recount.sessions,
    byModel: [...recount.byModel.filter((m) => !isDevdeskModel(m.model)), ...old.byModel.filter((m) => isDevdeskModel(m.model))].sort((a, b) => b.tokens.total - a.tokens.total),
    bySession: recount.bySession,
    devdesk: old.devdesk,
    byPlace: withDevdeskOf(placesOf(recount), placesOf(old)),
  };
}

/**
 * A day's places (`places`, capped) with DevDesk's place taken from `from` instead (the cap never sums it into
 * {@link OTHER}), the places capped again.
 */
function withDevdeskOf(places: PlaceDay[], from: PlaceDay[]): PlaceDay[] {
  let other: PlaceDay | undefined;
  const kept: PlaceDay[] = [];
  for (const p of places) {
    if (p.project === OTHER) other = p;
    else if (p.project !== DEVDESK) kept.push(p);
  }
  const devdesk = from.filter((p) => p.project === DEVDESK);
  kept.sort(byTotal);
  const over = kept.splice(Math.max(0, TOP_PLACES_PER_DAY - devdesk.length));
  kept.push(...devdesk);
  kept.sort(byTotal);
  if (over.length) {
    const folded = capPlaces(over, 0)[0];
    if (other) {
      // The places past the cap join the ones the recount already summed (its session line keeps their count).
      const models = new Map(other.byModel.map((m) => [m.model, { ...m.tokens }]));
      for (const m of folded.byModel) addKey(models, m.model, m.tokens);
      const tokens = { ...other.tokens };
      addTokens(tokens, folded.tokens);
      const sessions = other.bySession.length ? other.bySession.map((s) => ({ ...s })) : [{ ...folded.bySession[0], ...noTokens() }];
      addTokens(sessions[sessions.length - 1], folded.tokens);
      other = { ...other, tokens, byModel: modelsOf(models), bySession: sessions };
    } else other = folded;
  }
  return other && other.tokens.requests ? [...kept, other] : kept;
}

interface PlaceAcc {
  place: Place;
  tokens: Tokens;
  models: Map<string, Tokens>;
  sessions: Map<string, Tokens>;
}

interface DayAcc {
  sessions: Tokens;
  models: Map<string, Tokens>;
  bySession: Map<string, Tokens>;
  devdesk: Tokens & { failed: number };
  places: Map<string, PlaceAcc>;
}

/**
 * Sums usage by local day, from `since` up to (not including) `until`: transcripts as they are read (each request
 * counted once even when a fork or resume copied it into another transcript) and DevDesk's ledger. Reports which days
 * each addition changed, so a caller can store days as they end. `placeFor`: the place of a request's `cwd`
 * (`placeResolver()`: from the disk).
 */
export class DayCounter {
  private readonly days = new Map<string, DayAcc>();
  private readonly seen = new Set<string>();
  private readonly titles = new Map<string, string>();

  constructor(
    private readonly since: number,
    private readonly until = Infinity,
    private readonly placeFor: (cwd: string | undefined) => Place = placeResolver(),
  ) {}

  private acc(key: string): DayAcc {
    let a = this.days.get(key);
    if (!a) this.days.set(key, (a = { sessions: noTokens(), models: new Map(), bySession: new Map(), devdesk: { ...noTokens(), failed: 0 }, places: new Map() }));
    return a;
  }

  private addPlace(a: DayAcc, place: Place, model: string, sessionId: string | undefined, one: Tokens): void {
    const key = `${place.project}\n${place.worktree}`;
    let p = a.places.get(key);
    if (!p) a.places.set(key, (p = { place, tokens: noTokens(), models: new Map(), sessions: new Map() }));
    addTokens(p.tokens, one);
    addKey(p.models, model, one);
    if (sessionId) addKey(p.sessions, sessionId, one);
  }

  private inRange(at: number): boolean {
    return at >= this.since && at < this.until;
  }

  /** Adds a transcript of session `sessionId`; returns the days it changed. */
  addScan(sessionId: string, scan: UsageScan): Set<string> {
    const changed = new Set<string>();
    if (scan.title && !this.titles.has(sessionId)) this.titles.set(sessionId, scan.title);
    for (const [id, e] of scan.entries) {
      if (!this.inRange(e.at) || this.seen.has(id)) continue;
      this.seen.add(id);
      const one = { total: e.total, cached: e.cached, requests: 1 };
      const key = dayKey(e.at);
      changed.add(key);
      const a = this.acc(key);
      addTokens(a.sessions, one);
      addKey(a.models, e.model, one);
      addKey(a.bySession, sessionId, one);
      this.addPlace(a, this.placeFor(e.cwd), e.model, sessionId, one);
    }
    return changed;
  }

  /** Adds DevDesk's ledger (`usage.jsonl` text); returns the days it changed. */
  addLedger(ledger: string): Set<string> {
    const changed = new Set<string>();
    for (const line of ledger.split('\n')) {
      const call = parseLedgerLine(line);
      if (!call || !this.inRange(call.at)) continue;
      const key = dayKey(call.at);
      changed.add(key);
      const a = this.acc(key);
      const one = { total: call.total, cached: call.cached, requests: 1 };
      addTokens(a.devdesk, one);
      const model = `${call.model} ${DEVDESK_MODEL_SUFFIX}`;
      addKey(a.models, model, one);
      this.addPlace(a, devdeskPlace(), model, undefined, one);
      if (!call.ok) a.devdesk.failed++;
    }
    return changed;
  }

  /** The days counted, oldest first. */
  keys(): string[] {
    return [...this.days.keys()].sort();
  }

  /** A day as counted so far. Sessions are named as the board knows them (`names`), else by their transcript's title. */
  day(key: string, names: ReadonlyMap<string, string>, top = TOP_SESSIONS_PER_DAY): DayUsage | undefined {
    const a = this.days.get(key);
    if (!a) return undefined;
    const name = (sessionId: string) => names.get(sessionId) ?? this.titles.get(sessionId) ?? `session ${sessionId.slice(0, 8)}`;
    const sessions = (m: ReadonlyMap<string, Tokens>, cap: number) => capSessions([...m].map(([sessionId, t]) => ({ sessionId, name: name(sessionId), ...t })), cap);
    return {
      day: key,
      sessions: { ...a.sessions },
      byModel: modelsOf(a.models),
      bySession: sessions(a.bySession, top),
      devdesk: { ...a.devdesk },
      byPlace: capPlaces(
        [...a.places.values()].map((p) => ({ ...p.place, tokens: { ...p.tokens }, byModel: modelsOf(p.models), bySession: sessions(p.sessions, TOP_SESSIONS_PER_PLACE) })),
        TOP_PLACES_PER_DAY,
      ),
    };
  }
}

/**
 * Usage since `since`, by local day: transcripts (by session id; each request counted once even when a fork or resume
 * copied it) and DevDesk's ledger (`usage.jsonl` text). Sessions are named as the board knows them (`names`), else by
 * their transcript's title.
 */
export function usageByDay(
  scans: ReadonlyMap<string, readonly UsageScan[]>,
  ledger: string,
  since: number,
  names: ReadonlyMap<string, string>,
  top = TOP_SESSIONS_PER_DAY,
): Map<string, DayUsage> {
  const counter = new DayCounter(since);
  for (const [sessionId, list] of scans) for (const scan of list) counter.addScan(sessionId, scan);
  counter.addLedger(ledger);
  return new Map(counter.keys().map((key) => [key, counter.day(key, names, top)!]));
}

// ---- The history file: one compact JSON line per day ----

type Triple = [number, number, number];
const triple = (t: Tokens): Triple => [t.total, t.cached, t.requests];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const fromTriple = (v: unknown): Tokens | undefined =>
  Array.isArray(v) && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]) ? { total: v[0], cached: v[1], requests: v[2] } : undefined;

const KIND_CODE: Record<PlaceKind, string> = { workspace: 'b', git: 'g', folder: 'f' };
const CODE_KIND: Record<string, PlaceKind | undefined> = { b: 'workspace', g: 'git', f: 'folder' };
const encodeModels = (list: DayUsage['byModel']) => list.map((m) => [m.model, ...triple(m.tokens)]);
const encodeSessions = (list: SessionDay[]) => list.map((s) => [s.sessionId, s.name, ...triple(s)]);

function decodeModels(v: unknown): DayUsage['byModel'] {
  const out: DayUsage['byModel'] = [];
  for (const m of Array.isArray(v) ? v : []) {
    const tokens = Array.isArray(m) && typeof m[0] === 'string' ? fromTriple(m.slice(1)) : undefined;
    if (tokens) out.push({ model: m[0] as string, tokens });
  }
  return out;
}

function decodeSessions(v: unknown): SessionDay[] {
  const out: SessionDay[] = [];
  for (const s of Array.isArray(v) ? v : []) {
    const tokens = Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'string' ? fromTriple(s.slice(2)) : undefined;
    if (tokens) out.push({ sessionId: s[0] as string, name: s[1] as string, ...tokens });
  }
  return out;
}

function decodePlaces(v: unknown[]): PlaceDay[] {
  const out: PlaceDay[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[2] !== 'string') continue;
    const kind = typeof p[1] === 'string' ? CODE_KIND[p[1]] : undefined;
    const tokens = fromTriple(p[3]);
    if (kind && tokens) out.push({ project: p[0], kind, worktree: p[2], tokens, byModel: decodeModels(p[4]), bySession: decodeSessions(p[5]) });
  }
  return out;
}

/** A day as its history line (no newline). */
export function encodeDay(d: DayUsage): string {
  const places = d.byPlace === 'unknown' ? 'u' : d.byPlace?.map((p) => [p.project, KIND_CODE[p.kind], p.worktree, triple(p.tokens), encodeModels(p.byModel), encodeSessions(p.bySession)]);
  return JSON.stringify({
    day: d.day,
    s: triple(d.sessions),
    m: encodeModels(d.byModel),
    x: encodeSessions(d.bySession),
    d: [...triple(d.devdesk), d.devdesk.failed],
    ...(places ? { p: places } : {}),
  });
}

/** A history line's day, or undefined when it is not one. */
export function decodeDay(line: string): DayUsage | undefined {
  const o = parseObject(line);
  if (!o || typeof o.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.day)) return undefined;
  const sessions = fromTriple(o.s);
  const dd = Array.isArray(o.d) ? o.d : [];
  const devdesk = fromTriple(dd);
  if (!sessions || !devdesk) return undefined;
  let byPlace: DayUsage['byPlace'] = o.p === 'u' ? 'unknown' : Array.isArray(o.p) ? decodePlaces(o.p) : undefined;
  // Places that do not add up to the day (entries that could not be read) are dropped, so the day is counted again.
  if (Array.isArray(byPlace) && byPlace.reduce((n, p) => n + p.tokens.requests, 0) !== sessions.requests + devdesk.requests) byPlace = undefined;
  return {
    day: o.day,
    sessions,
    byModel: decodeModels(o.m),
    bySession: decodeSessions(o.x),
    devdesk: { ...devdesk, failed: isNum(dd[3]) ? dd[3] : 0 },
    ...(byPlace ? { byPlace } : {}),
  };
}

/** The history file's days, by day (a later line for a day replaces an earlier one). */
export function decodeHistory(text: string): Map<string, DayUsage> {
  const out = new Map<string, DayUsage>();
  for (const line of text.split('\n')) {
    const d = line.trim() ? decodeDay(line) : undefined;
    if (d) out.set(d.day, d);
  }
  return out;
}

export interface Pruned {
  /** The days kept, oldest first. */
  days: DayUsage[];
  /** The history file's text for them. */
  text: string;
  bytes: number;
}

/**
 * The days to keep: none older than `keepDays` days before `today`, then the oldest dropped until the file fits in
 * `maxBytes`.
 */
export function pruneHistory(days: Iterable<DayUsage>, today: string, keepDays: number, maxBytes: number): Pruned {
  const cutoff = addDays(today, -keepDays);
  const kept = [...days].filter((d) => d.day >= cutoff).sort((a, b) => (a.day < b.day ? -1 : 1));
  const lines = kept.map((d) => `${encodeDay(d)}\n`);
  const sizes = lines.map((l) => Buffer.byteLength(l));
  let bytes = sizes.reduce((a, b) => a + b, 0);
  let first = 0;
  while (first < lines.length && bytes > maxBytes) bytes -= sizes[first++];
  return { days: kept.slice(first), text: lines.slice(first).join(''), bytes };
}

/** DevDesk's ledger lines from `since` on (older days are in the history). */
export function trimLedger(text: string, since: number): string {
  return text
    .split('\n')
    .filter((line) => {
      const at = parseObject(line)?.at;
      return typeof at === 'number' && at >= since;
    })
    .map((l) => `${l}\n`)
    .join('');
}

// ---- Views: what the popover and the stats page show ----

export type Unit = 'day' | 'week' | 'month';

export interface TokensText extends Tokens {
  /** `12.3M` */
  totalText: string;
  /** `6.8M (55%)` */
  cachedText: string;
}

const text = (t: Tokens): TokensText => ({ ...t, totalText: formatTokens(t.total), cachedText: formatShare(t.cached, t.total) });

/** How a period's places are summed: by project (all projects), or by worktree (one project). */
export type PlaceGroup = 'project' | 'worktree';

/** A row of a period's breakdown by place. */
export interface PlaceRow extends TokensText {
  project: string;
  kind: PlaceKind;
  /** Set when grouped by worktree. */
  worktree?: string;
  label: string;
  /** The tooltip: the project's path (and worktree), or what a special project holds. */
  title: string;
  /** Its share of the period's total, in whole percent. */
  share: number;
}

export interface PeriodView {
  /** The period's first day, `YYYY-MM-DD`. */
  key: string;
  /** `Oct 31`, `Week of Oct 27`, `October 2026`. */
  label: string;
  /** For the chart's axis: `31`, `Oct 27`, `Oct`. */
  short: string;
  sessions: TokensText;
  devdesk: TokensText & { failed: number };
  models: (TokensText & { model: string })[];
  top: (TokensText & { name: string })[];
  /** Tokens by place, largest first. */
  places: PlaceRow[];
}

/** Sums days into one period's view, its places summed by project or by worktree (`group`). */
export function sumDays(days: readonly DayUsage[], key: string, label: string, short: string, top = 10, group: PlaceGroup = 'project'): PeriodView {
  const sessions = noTokens();
  const devdesk = { ...noTokens(), failed: 0 };
  const models = new Map<string, Tokens>();
  const bySession = new Map<string, SessionDay>();
  for (const d of days) {
    addTokens(sessions, d.sessions);
    addTokens(devdesk, d.devdesk);
    devdesk.failed += d.devdesk.failed;
    for (const m of d.byModel) {
      let t = models.get(m.model);
      if (!t) models.set(m.model, (t = noTokens()));
      addTokens(t, m.tokens);
    }
    for (const s of d.bySession) {
      let t = bySession.get(s.sessionId);
      if (!t) bySession.set(s.sessionId, (t = { sessionId: s.sessionId, name: s.name, ...noTokens() }));
      // A session named on a later day keeps its later name.
      if (s.sessionId !== OTHER) t.name = s.name;
      addTokens(t, s);
    }
  }
  const others = bySession.get(OTHER);
  if (others) others.name = 'Other sessions';
  const ranked = [...bySession.values()].filter((s) => s.sessionId !== OTHER).sort((a, b) => b.total - a.total);
  const shown = ranked.slice(0, top);
  const rest = ranked.slice(top);
  if (rest.length || others) {
    const o: SessionDay = { sessionId: OTHER, name: 'Other sessions', ...noTokens() };
    for (const s of rest) addTokens(o, s);
    if (others) addTokens(o, others);
    shown.push(o);
  }
  const places = new Map<string, { project: string; kind: PlaceKind; worktree?: string; tokens: Tokens }>();
  for (const d of days) {
    for (const p of placesOf(d)) {
      const k = group === 'project' ? p.project : `${p.project}\n${p.worktree}`;
      let r = places.get(k);
      if (!r) places.set(k, (r = { project: p.project, kind: p.kind, ...(group === 'worktree' ? { worktree: p.worktree } : {}), tokens: noTokens() }));
      addTokens(r.tokens, p.tokens);
    }
  }
  const placeTotal = [...places.values()].reduce((n, r) => n + r.tokens.total, 0);
  const placeLabels = projectLabels([...new Set([...places.values()].map((r) => r.project))]);
  return {
    key,
    label,
    short,
    sessions: text(sessions),
    devdesk: { ...text(devdesk), failed: devdesk.failed },
    models: [...models].map(([model, t]) => ({ model, ...text(t) })).sort((a, b) => b.total - a.total),
    top: shown.map((s) => ({ name: s.name, ...text(s) })),
    places: [...places.values()]
      .sort((a, b) => b.tokens.total - a.tokens.total)
      .map((r) => ({
        project: r.project,
        kind: r.kind,
        ...(r.worktree !== undefined ? { worktree: r.worktree } : {}),
        label: r.worktree ?? placeLabels.get(r.project) ?? r.project,
        title: r.worktree !== undefined ? `${projectTitle(r.project)} · ${r.worktree}` : projectTitle(r.project),
        share: placeTotal ? Math.round((100 * r.tokens.total) / placeTotal) : 0,
        ...text(r.tokens),
      })),
  };
}

const fmt = (key: string, options: Intl.DateTimeFormatOptions) => new Date(dayStart(key)).toLocaleDateString('en-US', options);

function labels(unit: Unit, key: string): [string, string] {
  if (unit === 'day') return [fmt(key, { weekday: 'short', month: 'short', day: 'numeric' }), fmt(key, { day: 'numeric' })];
  if (unit === 'week') return [`Week of ${fmt(key, { month: 'short', day: 'numeric' })}`, fmt(key, { month: 'short', day: 'numeric' })];
  return [fmt(key, { month: 'long', year: 'numeric' }), fmt(key, { month: 'short' })];
}

const startOf = (unit: Unit, key: string) => (unit === 'day' ? key : unit === 'week' ? weekOf(key) : monthOf(key));
const next = (unit: Unit, key: string) => {
  if (unit === 'day') return addDays(key, 1);
  if (unit === 'week') return addDays(key, 7);
  const [y, m] = parts(key);
  return dayKey(new Date(y, m, 1).getTime());
};

/**
 * Every `unit` from the one `from` is in to the one `today` is in, oldest first, including those with no usage, so a
 * chart's bars are evenly spaced.
 */
export function periods(days: readonly DayUsage[], unit: Unit, from: string, today: string, group: PlaceGroup = 'project'): PeriodView[] {
  const groups = new Map<string, DayUsage[]>();
  for (const d of days) {
    if (d.day < from || d.day > today) continue;
    const k = startOf(unit, d.day);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }
  const out: PeriodView[] = [];
  const last = startOf(unit, today);
  for (let k = startOf(unit, from); k <= last; k = next(unit, k)) {
    const [label, short] = labels(unit, k);
    out.push(sumDays(groups.get(k) ?? [], k, label, short, 10, group));
  }
  return out;
}

/** How many of each unit the stats page charts, at most. */
const CHART_SPAN: Record<Unit, number> = { day: 30, week: 26, month: 24 };

export interface HistoryInfo {
  /** Days stored in the history file (today is not, until it ends). */
  days: number;
  bytes: number;
  maxBytes: number;
  keepDays: number;
  /** The oldest day stored. */
  oldest?: string;
}

export interface UsagePage {
  today: string;
  units: Record<Unit, PeriodView[]>;
  history: HistoryInfo;
}

/** The stats page: each unit's periods back to the oldest usage (at most {@link CHART_SPAN} of them). */
export function usagePage(days: readonly DayUsage[], today: string, history: HistoryInfo, group: PlaceGroup = 'project'): UsagePage {
  const oldest = days.find((d) => d.sessions.requests || d.devdesk.requests)?.day ?? today;
  const from = (unit: Unit) => {
    const spanStart = unit === 'day' ? addDays(today, -(CHART_SPAN.day - 1)) : unit === 'week' ? addDays(weekOf(today), -7 * (CHART_SPAN.week - 1)) : monthBack(today, CHART_SPAN.month - 1);
    return oldest > spanStart ? oldest : spanStart;
  };
  return { today, units: { day: periods(days, 'day', from('day'), today, group), week: periods(days, 'week', from('week'), today, group), month: periods(days, 'month', from('month'), today, group) }, history };
}

function monthBack(key: string, n: number): string {
  const [y, m] = parts(key);
  return dayKey(new Date(y, m - 1 - n, 1).getTime());
}

/** The popover: today, this week and the last 30 days, with today's models and top sessions. */
export interface UsagePopover {
  periods: { label: string; sessions: TokensText; devdesk: TokensText & { failed: number } }[];
  today: PeriodView;
}

export function usagePopover(days: readonly DayUsage[], today: string, top = 5, group: PlaceGroup = 'project'): UsagePopover {
  const range = (from: string, label: string) => {
    const v = sumDays(days.filter((d) => d.day >= from && d.day <= today), from, label, label);
    return { label, sessions: v.sessions, devdesk: v.devdesk };
  };
  const todays = sumDays(days.filter((d) => d.day === today), today, 'Today', 'Today', top, group);
  return {
    periods: [range(today, 'Today'), range(weekOf(today), 'This week'), range(addDays(today, -29), 'Last 30 days')],
    today: todays,
  };
}
