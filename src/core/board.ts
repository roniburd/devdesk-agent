import { basename } from 'node:path';
import { DEFAULT_CHOICE, type LaunchChoice, type ModelChoice } from './composer';
import { runningCount } from './sessionChildren';
import type { SessionCard, SessionState } from './sessions';
import { DEFAULT_SERVER } from './tmux';
import { teamText } from './workers';
import { sortSessions, type SortMode } from './urgency';
import { oneLine, truncate } from './text';
import { HIDDEN_PARKED_MAX, IDLE_DIVIDER, searchFields, searchLane, type SearchFields } from './boardSearch';
import { cardView, displayState, distinctions, formatAgo, shownLook, stateLook, type Settle, type StateLook } from './sessionsView';
import { statusFromText } from './statusMerge';

/** The Claude Board's swim lanes: the backlog, then one lane per kind of session state. */
export type LaneId = 'backlog' | 'needs' | 'working' | 'review';
export type SessionLaneId = Exclude<LaneId, 'backlog'>;

export const LANES: readonly { id: LaneId; title: string }[] = [
  { id: 'backlog', title: 'Prompts for later' },
  { id: 'needs', title: 'Needs you' },
  { id: 'working', title: 'Working' },
  { id: 'review', title: 'Done / idle' },
];

const LANE_OF_LOOK: Record<StateLook, SessionLaneId> = {
  question: 'needs',
  permission: 'needs',
  plan: 'needs',
  input: 'needs',
  working: 'working',
  stuck: 'working',
  background: 'working',
  done: 'review',
  asked: 'review',
  interrupted: 'review',
  error: 'review',
  limited: 'review',
  crashed: 'review',
  idle: 'review',
  stopped: 'review',
  parked: 'review',
  unknown: 'review',
};

/**
 * The states (as `displayState` sorts them) of the Done / idle lane's cards under its divider, when read: ready, done
 * long ago, no status, not running or parked.
 */
const IDLE_STATES: ReadonlySet<SessionState> = new Set(['idle', 'unknown', 'stopped', 'parked']);

export function laneForLook(look: StateLook): SessionLaneId {
  return LANE_OF_LOOK[look];
}

/** A prompt for later (the board's first lane): saved from the composer, run only when started. */
export interface BacklogItem {
  id: string;
  prompt: string;
  createdAt: number;
  /** How to run it, as the composer had it; checked against the current choices when it starts. */
  choice?: Partial<LaunchChoice>;
}

const CHOICE_KEYS = ['where', 'worktreeName', 'mode', 'model', 'effort', 'ultracode'] as const;

/** The saved choice's known fields of the right type (strings, `ultracode` a boolean). */
function savedChoice(v: unknown): Partial<LaunchChoice> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const choice: Record<string, unknown> = {};
  for (const k of CHOICE_KEYS) if (typeof o[k] === (k === 'ultracode' ? 'boolean' : 'string')) choice[k] = o[k];
  return Object.keys(choice).length ? (choice as Partial<LaunchChoice>) : undefined;
}

/** A task from before prompts (`title`, optional `notes`) as one prompt: the title, then the notes; empty without a title. */
export function legacyPrompt(title: unknown, notes: unknown): string {
  const t = typeof title === 'string' ? title.trim() : '';
  const n = typeof notes === 'string' ? notes.trim() : '';
  return t && n ? `${t}\n\n${n}` : t;
}

/** A saved item, or (from before prompts) a task's `title` and `notes` as one prompt; undefined when malformed. */
function backlogItem(v: unknown): BacklogItem | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.createdAt !== 'number') return undefined;
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : legacyPrompt(o.title, o.notes);
  if (!prompt) return undefined;
  const choice = savedChoice(o.choice);
  return { id: o.id, prompt, createdAt: o.createdAt, ...(choice ? { choice } : {}) };
}

/**
 * The backlog file's items; malformed entries are dropped, and a blank file has none. Throws when `text` is not a
 * backlog at all (invalid JSON, no `items` list), so a damaged file is never mistaken for an empty one and overwritten.
 */
export function parseBacklog(text: string): BacklogItem[] {
  if (!text.trim()) return [];
  const items = (JSON.parse(text) as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error('no items list');
  return items.map(backlogItem).filter((i): i is BacklogItem => !!i);
}

/**
 * The backlog file. Each item also carries the prompt as `title` (its first line) and `notes` (the rest), so a window
 * still running a version from before prompts keeps them when it rewrites the file.
 */
export function serializeBacklog(items: readonly BacklogItem[]): string {
  const withTitles = items.map((i) => {
    const [title, ...rest] = i.prompt.split('\n');
    const notes = rest.join('\n').trim();
    return { ...i, title, ...(notes ? { notes } : {}) };
  });
  return `${JSON.stringify({ items: withTitles }, null, 2)}\n`;
}

/**
 * Whether a prompt for later from the host-wide `backlog.json` (from before each project folder had its own) belongs to
 * the project folder opening now. Only a prompt saved for an existing worktree says which project it is for (its
 * `where` is the worktree's directory): it belongs here when `isProjectDir` says the directory is this project's.
 * The others (main, a new worktree, no choice, or a worktree since removed) do not say, and go to the first project
 * folder that opens, so each one ends up in exactly one project.
 */
export function backlogItemBelongs(item: BacklogItem, isProjectDir: (dir: string) => boolean, exists: (dir: string) => boolean): boolean {
  const where = item.choice?.where;
  if (!where || where === 'main' || where === 'new') return true;
  return isProjectDir(where) || !exists(where);
}

/** One part of a card's hover: what it is (`Where it stands`) and the text; the first part, the title, has no label. */
export interface HoverPart {
  label?: string;
  text: string;
}

/** A session card as the board's webview shows it (plain data, posted as a message). */
export interface BoardSession {
  id: string;
  /** A few words: a /rename, else DevDesk's Haiku title, else Claude's title or the last prompt. */
  title: string;
  /**
   * Under the title, in small text, with `devdesk.board.cardTitle` `objective`: what the latest prompt is about (the
   * title the card has with `latest`), when the title is the session's objective.
   */
  latest?: string;
  /** In the Needs you lane: what Claude asks or waits to have approved, in one line (Haiku's, else the hook's detail). */
  ask?: string;
  /** In the Working lane: what Claude is doing now, in one line (DevDesk's live status, else the hook's detail). */
  doing?: string;
  /** The note Claude set on its card (`devdesk note`), in any lane. */
  note?: string;
  /** Its worktree's pull request checks hint (`2 checks failing`), when they have something to fix: the card offers Fix checks. */
  checks?: string;
  /**
   * Its place among coordinator and worker sessions (`devdesk worker`): `worker "lint" · working · of <coordinator>` on a
   * worker, "3 workers: 1 done, 2 working" on its coordinator.
   */
  team?: string;
  /** A worker's coordinator's card id, when listed (clicking the team line goes there). */
  coordinatorId?: string;
  worktree: string;
  look: StateLook;
  lookLabel: string;
  ago: string;
  /** What Claude is doing: DevDesk's live status while it works, else the hook's detail (the reply, the question). */
  detail: string;
  /** Where the work stands (DevDesk's Haiku summary), shown dimmed under the detail; empty without one. */
  insight: string;
  /** The card's hover: the title, then where the work stands (Haiku), Claude's recap, the last prompt and what Claude is doing. */
  hoverParts: HoverPart[];
  /** What the board's search box matches (see `matchesQuery`). */
  search: SearchFields;
  unread: boolean;
  /** The color given to it by hand (a `SESSION_COLORS` id): its title is drawn in it. */
  color?: string;
  /** Its Claude terminal is the active terminal (the board marks it, as the Claude view selects its row). */
  focused?: true;
  /** Running subagents, shells and workflows. */
  running: number;
  /** Runs in tmux, so DevDesk can open (and end) its terminal. */
  canOpen: boolean;
  canFork: boolean;
  canEnd: boolean;
  /** The model the board started it with (its pill row's name), when not Default. */
  model?: string;
  /** Not running: opening it resumes it, and End removes it from the list. */
  parked: boolean;
  /**
   * In the Done / idle lane, under its divider: read, and ready, done long enough ago (`idleMs`), no status, not
   * running or parked.
   */
  idle?: true;
}

export interface BoardTask {
  id: string;
  prompt: string;
  ago: string;
  /** Where it will run (`main`, a worktree) and, when not the defaults, its mode, model, effort and Ultracode. */
  chips: string[];
  /** Being started: its buttons are off until it leaves the lane. */
  starting: boolean;
}

/**
 * The chips of a prompt for later: where it runs, then whatever it changes from the defaults. A model shows as its
 * row's name in the pill (`models`), or as its value when no row offers it.
 */
export function choiceChips(choice: Partial<LaunchChoice> | undefined, defaultMode: string, models: readonly Pick<ModelChoice, 'value' | 'label'>[] = []): string[] {
  const c = choice ?? {};
  const where = c.where === 'new' ? (c.worktreeName ? `new: ${c.worktreeName}` : 'new worktree') : c.where && c.where !== 'main' ? basename(c.where) : 'main';
  const chips = [where];
  if (c.mode && c.mode !== defaultMode) chips.push(c.mode);
  if (c.model && c.model !== DEFAULT_CHOICE) chips.push(models.find((r) => r.value === c.model)?.label ?? c.model);
  if (c.effort && c.effort !== DEFAULT_CHOICE) chips.push(`effort ${c.effort}`);
  if (c.ultracode) chips.push('Ultracode');
  return chips;
}

export interface BoardLane {
  id: LaneId;
  title: string;
  sessions: BoardSession[];
  tasks: BoardTask[];
  /** Parked sessions left off the lane (`parkedLimit`); the Claude view lists them all. */
  more?: number;
  /** Parked sessions counted in `more`, the newest `HIDDEN_PARKED_MAX`: shown only while a search matches them. */
  hidden?: BoardSession[];
  /** What the divider above the lane's first `idle` card says (the Done / idle lane). */
  divider?: string;
}

export interface BoardData {
  lanes: BoardLane[];
  needYou: number;
  working: number;
  /** The worktrees that have session cards, for the board's filter (`no worktree` last). */
  worktrees: string[];
}

export interface BoardOptions {
  now: number;
  idleMs: number;
  stuckMs: number;
  unread: ReadonlySet<string>;
  /** The colors given to sessions by hand, by session id. */
  colors?: ReadonlyMap<string, string>;
  /** The session whose Claude terminal is the active terminal, if any. */
  focused?: string;
  unreadFirst: boolean;
  /** DevDesk's tmux server (see `cardView`). */
  vscodeServer?: string;
  /** The mode new sessions start in, left off a prompt's chips. */
  defaultMode?: string;
  /** Prompts for later being started. */
  starting?: ReadonlySet<string>;
  /** The model pill's rows, to name a prompt's model by its row. */
  models?: readonly Pick<ModelChoice, 'value' | 'label'>[];
  /** The models the board started sessions with, by `launchKey`. */
  launchedModels?: ReadonlyMap<string, string>;
  /** How many parked sessions to show (the newest); the rest are counted in their lane's `more`. All when undefined. */
  parkedLimit?: number;
  /**
   * What a card's title says (`devdesk.board.cardTitle`): `objective`, what the whole session sets out to do (Haiku's),
   * with the latest prompt's title under it; `latest`, the latest prompt's title only. `latest` when undefined.
   */
  cardTitle?: CardTitleMode;
  /** Keeps working sessions in place between re-sorts (the Claude view's, so both show one order). */
  settle?: Settle;
  /** How sessions are ordered in each lane (`devdesk.sessions.sort`); `attention` when undefined. */
  sort?: SortMode;
  /** With `urgency`: how long an unread finished turn sorts as recently finished. `idleMs` when undefined. */
  recentMs?: number;
  /** A worktree's checks hint (`2 checks failing`), empty when it has nothing to fix, by worktree directory. */
  checks?: (featureDir: string) => string;
}

/** What a card's title says (setting `devdesk.board.cardTitle`). */
export type CardTitleMode = 'objective' | 'latest';

/** A model the board started a tmux session with, and when. */
export interface Launch {
  model: string;
  at: number;
}

/** How long a launch is remembered before its session is listed. */
export const LAUNCH_GRACE_MS = 60_000;

/** What a launch is remembered by: the tmux server and session. */
export const launchKey = (server: string | undefined, session: string) => `${server ?? DEFAULT_SERVER}\n${session}`;

/**
 * The launches still worth showing: those whose session is `listed` (by `launchKey`), or that started less than
 * `LAUNCH_GRACE_MS` ago (not listed yet). An ended session's name may be reused by a session the board did not start.
 */
export function liveLaunches(launches: ReadonlyMap<string, Launch>, listed: ReadonlySet<string>, now: number): Map<string, Launch> {
  return new Map([...launches].filter(([key, l]) => listed.has(key) || now - l.at < LAUNCH_GRACE_MS));
}

/** The board: prompts for later newest first, and the sessions in `sort` order, each in its state's lane. */
export function buildBoard(cards: readonly SessionCard[], backlog: readonly BacklogItem[], o: BoardOptions): BoardData {
  const lanes: BoardLane[] = LANES.map((l) => ({ ...l, sessions: [], tasks: [], ...(l.id === 'review' ? { divider: IDLE_DIVIDER } : {}) }));
  const byId = new Map(lanes.map((l) => [l.id, l]));
  byId.get('backlog')!.tasks = [...backlog]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      id: t.id,
      prompt: t.prompt,
      ago: formatAgo(t.createdAt, o.now),
      chips: choiceChips(t.choice, o.defaultMode ?? '', o.models),
      starting: !!o.starting?.has(t.id),
    }));
  // An unread parked session (its process ended before you read what it did) stays above the divider, to review, whatever `parkedLimit`.
  // Read ones past `parkedLimit` (the oldest, as they sort last) are only counted in their lane's `more`.
  let parked = 0;
  let hiddenCount = 0;
  const shown: { card: SessionCard; look: StateLook; lane: BoardLane; hidden: boolean; idle: boolean }[] = [];
  const ordered = sortSessions(cards, {
    mode: o.sort ?? 'attention',
    now: o.now,
    idleMs: o.idleMs,
    stuckMs: o.stuckMs,
    recentMs: o.recentMs ?? o.idleMs,
    unread: o.unread,
    unreadFirst: o.unreadFirst,
    settle: o.settle,
  });
  for (const card of ordered) {
    const look = stateLook(card, o.now, o.stuckMs);
    const toReview = card.state === 'parked' && o.unread.has(card.id);
    const lane = byId.get(laneForLook(look))!;
    // Under the divider: read sessions that sort as idle or later (see `attentionOrder`); unread ones are to review.
    // They are moved under the cards to review below, whatever the order put between them.
    const idle = lane.id === 'review' && !o.unread.has(card.id) && IDLE_STATES.has(displayState(card, o.now, o.idleMs));
    if (card.state === 'parked' && !toReview && o.parkedLimit !== undefined && ++parked > o.parkedLimit) {
      lane.more = (lane.more ?? 0) + 1;
      if (++hiddenCount <= HIDDEN_PARKED_MAX) shown.push({ card, look, lane, hidden: true, idle });
      continue;
    }
    shown.push({ card, look, lane, hidden: false, idle });
  }
  const views = shown.map(({ card }) => cardView(card, o.now, o.vscodeServer));
  // A name the user gave wins; otherwise DevDesk's few-word Haiku title, until there is one Claude's title or the prompt.
  const latestTitles = shown.map(({ card }, i) => (card.insightTitle && !(card.nameByUser && card.name) ? card.insightTitle : views[i].title));
  // With `objective`, the session's objective (until Haiku has one, the latest title) over the latest title.
  const byObjective = (card: SessionCard) => o.cardTitle === 'objective' && !!card.insightObjective && !(card.nameByUser && card.name);
  const titles = shown.map(({ card }, i) => (byObjective(card) ? card.insightObjective! : latestTitles[i]));
  // Titles are told apart among the visible cards only.
  const visible = shown.map((s, i) => [s, i] as const).filter(([s]) => !s.hidden);
  const visibleApart = distinctions(
    visible.map(([s]) => s.card),
    visible.map(([, i]) => titles[i]),
    o.now,
  );
  const apart: (string | undefined)[] = shown.map(() => undefined);
  visible.forEach(([, i], k) => (apart[i] = visibleApart[k]));
  /** A worker's coordinator, by its tmux session: its card's id and title (the tmux session's name when not shown). */
  const coordinatorOf = (card: SessionCard) => {
    const c = card.team?.workerOf?.coordinator;
    if (!c) return undefined;
    const i = shown.findIndex(({ card: o }) => o.tmuxSession === c.session && (o.tmuxServer ?? DEFAULT_SERVER) === c.server);
    return i >= 0 ? { id: shown[i].card.id, title: truncate(titles[i], 40) } : { id: undefined, title: c.session };
  };
  for (const [i, { card, look, lane, hidden, idle }] of shown.entries()) {
    const isParked = card.state === 'parked';
    const v = views[i];
    const title = apart[i] ? `${titles[i]} · ${apart[i]}` : titles[i];
    // A parked session resumes with Claude's own model choice: the one the board started it with is not shown.
    const model = card.tmuxSession && !isParked ? o.launchedModels?.get(launchKey(card.tmuxServer, card.tmuxSession)) : undefined;
    // A parked session keeps the look its last turn ended with (a green tick when done), under the Done / idle lane's divider.
    const shown = shownLook(card, o.now, o.stuckMs);
    const coordinator = coordinatorOf(card);
    const team = teamLine(card, coordinator?.title);
    const session: BoardSession = {
      id: card.id,
      title,
      ...(byObjective(card) && latestTitles[i] !== titles[i] ? { latest: latestTitles[i] } : {}),
      worktree: v.worktree,
      look: shown.look,
      lookLabel: shown.label,
      ago: v.ago,
      detail: v.liveStatus || v.detail,
      insight: v.liveStatus ? '' : v.insight,
      hoverParts: hoverOf(titles[i], card, v, look, model, o.now, byObjective(card) ? latestTitles[i] : undefined, team),
      ...(lane.id === 'needs' ? { ask: askLine(card) } : {}),
      ...(lane.id === 'working' && (v.liveStatus || v.detail) ? { doing: v.liveStatus || v.detail } : {}),
      ...(card.note ? { note: card.note } : {}),
      ...(card.featureDir && o.checks?.(card.featureDir) ? { checks: o.checks(card.featureDir) } : {}),
      ...(team ? { team } : {}),
      ...(coordinator?.id ? { coordinatorId: coordinator.id } : {}),
      unread: o.unread.has(card.id),
      ...(o.colors?.get(card.id) ? { color: o.colors.get(card.id) } : {}),
      ...(o.focused === card.id ? { focused: true as const } : {}),
      running: card.children ? runningCount(card.children) : 0,
      canOpen: !!card.tmuxSession || (isParked && !!card.cwd),
      canFork: !!(card.sessionId && card.cwd),
      canEnd: !!card.tmuxSession || isParked,
      parked: isParked,
      ...(idle ? { idle: true as const } : {}),
      ...(model ? { model } : {}),
      search: searchFields({
        title,
        worktree: v.worktree,
        laneTitle: searchLane(lane.id, lane.title, idle),
        lookLabel: shown.label,
        state: card.state,
        model,
        texts: [card.prompt, card.summary, card.insightTitle, card.insightObjective, card.liveStatus, card.askSummary, card.detail, v.insight, card.note],
      }),
    };
    if (hidden) (lane.hidden ??= []).push(session);
    else lane.sessions.push(session);
  }
  // The divider sits above the lane's first idle card, so every card to review goes above every idle one (a stable split).
  for (const lane of lanes) if (lane.divider) lane.sessions = [...lane.sessions.filter((s) => !s.idle), ...lane.sessions.filter((s) => s.idle)];
  const names = new Set(lanes.flatMap((l) => l.sessions.map((s) => s.worktree)));
  const worktrees = [...names].filter((n) => n !== 'no worktree').sort();
  if (names.has('no worktree')) worktrees.push('no worktree');
  return { lanes, needYou: byId.get('needs')!.sessions.length, working: byId.get('working')!.sessions.length, worktrees };
}

/** The card's team line: a worker's name, coordinator and status; a coordinator's workers by status. */
function teamLine(card: SessionCard, coordinator: string | undefined): string | undefined {
  const w = card.team?.workerOf;
  const parts: string[] = [];
  if (w) parts.push(`worker "${w.name}" · ${w.status} · of ${coordinator ?? w.coordinator.session}`);
  if (card.team?.workers?.length) parts.push(teamText(card.team.workers));
  return parts.length ? parts.join(' · ') : undefined;
}

/** What a card in the Needs you lane says Claude asks: Haiku's line for this wait, else the hook's detail. */
function askLine(card: SessionCard): string {
  if (card.askSummary) return card.askSummary;
  return truncate(oneLine(card.detail).replace(/^Asking:\s*/, ''), 160);
}

const PROMPT_MAX = 600;

/** A card's hover, as its parts. */
function hoverOf(
  title: string,
  card: SessionCard,
  v: ReturnType<typeof cardView>,
  look: StateLook,
  model: string | undefined,
  now: number,
  latest?: string,
  team?: string,
): HoverPart[] {
  const prompt = card.prompt ? oneLine(card.prompt) : '';
  const running = card.children ? runningCount(card.children) : 0;
  const waiting = laneForLook(look) === 'needs';
  const parts: (HoverPart | false)[] = [
    { text: title },
    !!latest && latest !== title && { label: 'Latest step', text: latest },
    !!card.note && { label: "Claude's note", text: card.note },
    !!team && { label: 'Team', text: team },
    !!v.liveStatus && { label: 'Doing now', text: v.liveStatus },
    !!v.insight && { label: 'Where it stands', text: v.insight },
    !!v.summary && { label: "Claude's recap", text: v.summary },
    !!prompt && prompt !== title && { label: 'Last prompt', text: truncate(prompt, PROMPT_MAX) },
    !!v.detail && { label: waiting ? 'Waiting on' : 'Latest', text: v.detail },
    !!card.statusFrom && { label: 'Status', text: statusFromText(card, now)! },
    running > 0 && { label: 'Running', text: `${running} (subagents, shells, workflows)` },
    !!model && { label: 'Started with', text: model },
    !!v.times && { label: 'Times', text: v.times },
    !!v.location && { label: 'Where', text: v.location },
  ];
  return parts.filter((p): p is HoverPart => !!p);
}

/** How the board makes room for a session's terminal (setting `devdesk.board.sessionsBeside`). */
export type BesideMode = 'auto' | 'always' | 'never';

/** A lane's width when a session opens beside the board (`devdesk.board.laneWidth`), and the narrowest (`.lane` in media/board.css). */
export const DEFAULT_LANE_WIDTH = 220;
export const MIN_LANE_WIDTH = 180;

/** Gap between lanes and the lanes' side padding (`#lanes` in media/board.css). */
const LANE_GAP_PX = 10;
const LANES_PADDING_PX = 28;

/** The board's width with every lane `laneWidth` wide: all lanes show, with room to read the cards' summaries. */
export function fullBoardWidth(laneWidth: number, lanes = LANES.length): number {
  return lanes * laneWidth + (lanes - 1) * LANE_GAP_PX + LANES_PADDING_PX;
}

/**
 * Opening a session from a board `editorWidth` wide (CSS px) that has the editor area to itself: the board's width once
 * the session's terminal opens beside it (the terminal takes the rest), or undefined to open the terminal over it.
 * `auto` splits only when the terminal gets at least as much room as the board; `always` splits anyway, the board
 * getting at most half.
 */
export function besideBoardWidth(editorWidth: number, mode: BesideMode, laneWidth: number): number | undefined {
  if (mode === 'never' || !(editorWidth > 0)) return undefined;
  const board = fullBoardWidth(laneWidth);
  if (editorWidth - board >= board) return board;
  return mode === 'always' ? Math.floor(editorWidth / 2) : undefined;
}
