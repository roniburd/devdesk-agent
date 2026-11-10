import { stat } from 'node:fs/promises';
import type { CardTeam } from './workers';
import { readTailText } from './transcriptTail';
import { isFiniteNumber, parseObject, readJsonFiles } from './json';
import { DEFAULT_SERVER, isNumberedSession, isShellCommand, serverOf, sessionName, type TmuxPane } from './tmux';
import type { SessionChild } from './sessionChildren';
import { featureDirs, type Feature } from './worktrees';
import { isWithin, trimSlashes } from './paths';
import type { EndedRecord, EndReason } from './ended';
import type { RegistryEntry } from './sessionInfo';
import { isRecordState, STATE_INFO } from './sessionStates';

/**
 * What a waiting session waits on, from the hook record: a question (AskUserQuestion), a plan to review (ExitPlanMode),
 * a permission, or an MCP server's input form.
 */
export type WaitKind = 'question' | 'plan' | 'permission' | 'elicitation';
const WAIT_KINDS: ReadonlySet<string> = new Set(['question', 'plan', 'permission', 'elicitation']);

/**
 * How a turn ended when its transcript, not a hook, says so (see `withTranscriptEnd`): Esc interrupted it, or the
 * conversation went on in a background job.
 */
export type EndKind = 'interrupted' | 'moved';
const END_KINDS: ReadonlySet<string> = new Set(['interrupted', 'moved']);

/** `blocked`: the turn ended on an error (StopFailure). */
export type RecordState = 'working' | 'waiting' | 'done' | 'idle' | 'blocked';
/**
 * `unknown`: Claude runs in tmux without DevDesk hooks; `stopped`: a DevDesk tmux session whose Claude exited;
 * `parked`: a session that no longer runs (parked, exited or crashed), kept so it can be resumed (`claude --resume`).
 */
export type SessionState = RecordState | 'unknown' | 'stopped' | 'parked';

/** One Claude session's last hook event, as written by devdesk_hook.py. Older scripts omit the optional fields. */
export interface HookRecord {
  sessionId: string;
  pid?: number;
  tmuxSession: string | null;
  tmuxPane?: string | null;
  /** The tmux server (`-L` name, `default` without one); missing from older hook scripts, which means the default server. */
  tmuxServer?: string | null;
  cwd: string;
  transcriptPath?: string | null;
  /** The last file Claude edited (absolute); missing from older hook scripts. */
  lastEditPath?: string | null;
  event: string;
  state: RecordState;
  detail: string;
  /** What a waiting session waits on (the record's `wait.kind`); missing from older hook scripts, whose detail tells. */
  waitKind?: WaitKind;
  /**
   * What error ended a blocked turn (StopFailure's kind: `rate_limit`, `overloaded_error`, `unknown`, ...); missing from
   * older hook scripts, whose detail tells.
   */
  errorKind?: string;
  /**
   * How the turn ended, when the transcript says so (`withTranscriptEnd`); kept in ended records. Ended records kept
   * before this field say it only in their detail (`INTERRUPTED_DETAIL`, `MOVED_DETAIL`).
   */
  endKind?: EndKind;
  prompt?: string;
  updatedAt: number;
  /** A finished turn (`done`) whose reply ends with a question; missing from older hook scripts. */
  asksQuestion?: boolean;
  /** When the current turn started (UserPromptSubmit) and, once it finished (Stop), ended; missing from older hook scripts. */
  turnStartedAt?: number;
  turnEndedAt?: number;
  /**
   * When the running Claude process started (or resumed, or /clear started) the session; missing from older hook
   * scripts. A subagent or background shell the transcript shows started before it ran in an earlier process.
   */
  sessionStartedAt?: number;
}

export interface SessionCard {
  /** The Claude session id, or `tmux:<pane or session>` for tmux sessions without a hook record. */
  id: string;
  sessionId?: string;
  pid?: number;
  tmuxSession?: string;
  tmuxPane?: string;
  /** The tmux server of tmuxSession / tmuxPane. */
  tmuxServer?: string;
  /** The DevDesk feature (worktree, or `main` for the workspace root) the session runs in, if any. */
  featureName?: string;
  featureDir?: string;
  cwd?: string;
  transcriptPath?: string;
  state: SessionState;
  detail: string;
  /** What a waiting session waits on, when its hook record says (see `HookRecord.waitKind`; read it with `waitKindOf`). */
  waitKind?: WaitKind;
  /** What error ended a blocked turn, when its hook record says (see `HookRecord.errorKind`; read it with `hitLimit`). */
  errorKind?: string;
  /** How the turn ended, when its transcript says (see `HookRecord.endKind`; read it with `endKindOf`). */
  endKind?: EndKind;
  prompt?: string;
  updatedAt?: number;
  attached: boolean;
  /** What the session spun off (subagents, background shells, workflows), when listed (`devdesk.sessions.showChildren`). */
  children?: SessionChild[];
  /** Something the session started in the background (subagent, shell, workflow) still runs, whether or not `children` lists it. */
  runsInBackground?: boolean;
  /** A stopped session whose Claude exited mid-turn without ending the session (crashed or was killed). */
  crashed?: boolean;
  /** The name Claude Code shows for the session (a /rename, a job name, or Claude's own title); see `claudeTitle`. */
  name?: string;
  /** Claude's latest recap of the session, and when it wrote it. */
  summary?: string;
  summaryAt?: number;
  /** The finished turn's reply asks the user something: from the hook record, or DevDesk's Haiku insight when it has one. */
  asksQuestion?: boolean;
  /** When the current turn started and, once finished, ended (from the hook record): insights are matched to turns by these. */
  turnStartedAt?: number;
  turnEndedAt?: number;
  /** When the running Claude process started the session (see `HookRecord.sessionStartedAt`). */
  sessionStartedAt?: number;
  /** What Claude is doing right now, from DevDesk's Haiku insight for this turn (working sessions only). */
  liveStatus?: string;
  /** A short name for the session's task, from DevDesk's Haiku insight. */
  insightTitle?: string;
  /** What the whole session sets out to do (DevDesk's Haiku insight), for the board's card titles. */
  insightObjective?: string;
  /** What Claude waits for the user to answer or approve, from DevDesk's Haiku insight for this wait (waiting sessions only). */
  askSummary?: string;
  /** The session's name is one the user gave it (a /rename), so it wins over `insightTitle`. */
  nameByUser?: boolean;
  /** Where the work stands, from DevDesk's latest Haiku insight, and when it was written. */
  insightSummary?: string;
  insightSummaryAt?: number;
  /** When the Claude process (or else the transcript) started. */
  startedAt?: number;
  /** A parked session: why it stopped running, and the state it was in then. */
  endReason?: EndReason;
  lastState?: RecordState;
  endedAt?: number;
  /** A parked session: the tmux session it ran in and its server, which resuming it uses again when free. */
  formerTmuxSession?: string;
  formerTmuxServer?: string;
  /** A note Claude set on its card (`devdesk note`), kept per tmux pane. */
  note?: string;
  /**
   * The state is Claude's own report (OSC 7501), not the hook record's (see `mergedCard`): why (`ahead` of the hooks, or
   * the hooks went `quiet`), and the hook record's time, which a newer hook event must beat.
   */
  statusFrom?: { reason: 'ahead' | 'quiet'; hookAt: number };
  /** Its place among coordinator and worker sessions (`devdesk worker`), from the mailboxes. */
  team?: CardTeam;
}

export const NO_HOOKS_DETAIL = 'Install Claude status hooks to see what Claude is doing';
export const NOT_RUNNING_DETAIL = 'Claude is not running in this session';

/**
 * A "prompt" Claude Code submitted itself, not the user: a background task's result (`<task-notification>`), a system
 * reminder, or a subagent's hand-back or another session's message (`<agent-message from="…">`, which the transcript
 * records after "Another Claude session sent a message:"). Older hook scripts saved these as the session's prompt; they
 * are never a title.
 */
export function isInjectedPrompt(text: string): boolean {
  return /^\s*(Another Claude session sent a message:\s*)?<(task-notification>|system-reminder>|agent-message[\s>])/.test(text);
}

const optionalString = (v: unknown) => v === undefined || v === null || typeof v === 'string';

export function parseHookRecord(text: string): HookRecord | undefined {
  const r = parseObject(text);
  if (!r) return undefined;
  if (typeof r.sessionId !== 'string' || !r.sessionId) return undefined;
  if (r.tmuxSession !== null && typeof r.tmuxSession !== 'string') return undefined;
  if (typeof r.cwd !== 'string' || typeof r.event !== 'string' || typeof r.detail !== 'string') return undefined;
  if (typeof r.state !== 'string' || !isRecordState(r.state)) return undefined;
  if (!isFiniteNumber(r.updatedAt)) return undefined;
  if (!optionalString(r.tmuxPane) || !optionalString(r.tmuxServer) || !optionalString(r.transcriptPath) || !optionalString(r.prompt)) return undefined;
  if (!optionalString(r.lastEditPath)) return undefined;
  const record: HookRecord = {
    sessionId: r.sessionId,
    tmuxSession: r.tmuxSession,
    cwd: r.cwd,
    event: r.event,
    state: r.state as RecordState,
    detail: r.detail,
    updatedAt: r.updatedAt,
  };
  if (Number.isInteger(r.pid) && (r.pid as number) > 1) record.pid = r.pid as number;
  if (r.tmuxPane) record.tmuxPane = r.tmuxPane as string;
  if (r.tmuxServer) record.tmuxServer = r.tmuxServer as string;
  if (r.transcriptPath) record.transcriptPath = r.transcriptPath as string;
  if (r.prompt && !isInjectedPrompt(r.prompt as string)) record.prompt = r.prompt as string;
  if (r.lastEditPath) record.lastEditPath = r.lastEditPath as string;
  if (r.asksQuestion === true) record.asksQuestion = true;
  const wait = r.wait as { kind?: unknown } | null | undefined;
  if (r.state === 'waiting' && typeof wait?.kind === 'string' && WAIT_KINDS.has(wait.kind)) record.waitKind = wait.kind as WaitKind;
  if (r.state === 'blocked' && typeof r.errorKind === 'string' && r.errorKind) record.errorKind = r.errorKind;
  if (typeof r.endKind === 'string' && END_KINDS.has(r.endKind)) record.endKind = r.endKind as EndKind;
  if (isFiniteNumber(r.turnStartedAt)) record.turnStartedAt = r.turnStartedAt;
  if (isFiniteNumber(r.turnEndedAt)) record.turnEndedAt = r.turnEndedAt;
  if (isFiniteNumber(r.sessionStartedAt)) record.sessionStartedAt = r.sessionStartedAt;
  return record;
}

export const MOVED_DETAIL = 'Conversation continued in a background job';
export const INTERRUPTED_DETAIL = 'Interrupted';

/** How a card's turn ended (`endKind`); for an ended record kept before that field, what its detail says. */
export function endKindOf(card: Pick<SessionCard, 'endKind' | 'detail'>): EndKind | undefined {
  if (card.endKind) return card.endKind;
  return card.detail === INTERRUPTED_DETAIL ? 'interrupted' : card.detail === MOVED_DETAIL ? 'moved' : undefined;
}

/** What a waiting card waits on (`waitKind`); for a record from an older hook script, what its detail says. */
export function waitKindOf(card: Pick<SessionCard, 'waitKind' | 'detail'>): WaitKind {
  if (card.waitKind) return card.waitKind;
  if (card.detail.startsWith('Asking:')) return 'question';
  if (card.detail.startsWith('Plan ready')) return 'plan';
  // Anything else needs input, as an MCP server's form does.
  return /permission/i.test(card.detail) ? 'permission' : 'elicitation';
}

const LIMIT_RE = /\b(rate|usage)[ _-]?limit|limit (reached|exceeded)|\blimited\b/i;

/**
 * A blocked card stopped at a rate or usage limit: its error kind says `rate_limit` (or the API's `rate_limit_error`, the
 * type of a StopFailure error given as an object); otherwise (an older hook script, Claude's own report, or a limit
 * Claude Code reports under another kind) its detail mentions a limit.
 */
export function hitLimit(card: Pick<SessionCard, 'errorKind' | 'detail'>): boolean {
  return /^rate_limit(_error)?$/.test(card.errorKind ?? '') || LIMIT_RE.test(card.detail);
}

/** `card` without its wait, error and end kinds: they describe its record's state, not one something else sets. */
export function withoutStateKinds(card: SessionCard): SessionCard {
  const next = { ...card };
  delete next.waitKind;
  delete next.errorKind;
  delete next.endKind;
  return next;
}

/**
 * How a transcript ends when no hook reports it: `moved` when the conversation was backgrounded into a job (Claude
 * appends `continued-in`, and the pane's Claude keeps firing hooks under the old session id), `interrupted` when its last
 * message is Esc's `[Request interrupted by user…]` (Claude runs no Stop hook then).
 */
export function transcriptEnd(tail: string): 'moved' | 'interrupted' | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Not an object: blank, or the first line cut by the tail read.
    const entry = parseObject(lines[i]) as { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } } | undefined;
    if (!entry) continue;
    if (entry.type === 'continued-in') return 'moved';
    if (entry.isSidechain || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    if (entry.type === 'assistant') return undefined;
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? (content.at(-1) as { text?: unknown })?.text : undefined;
    return typeof text === 'string' && text.startsWith('[Request interrupted by user') ? 'interrupted' : undefined;
  }
  return undefined;
}

const TRANSCRIPT_TAIL_BYTES = 65536;

/**
 * How each transcript ends (`transcriptEnd`), kept by path with the size and mtime it was read at, so a refresh reads
 * only the tails of transcripts that changed. Forgets transcripts no record named in the last `readHookRecords`.
 */
export class TranscriptEnds {
  private known = new Map<string, { size: number; mtimeMs: number; end: ReturnType<typeof transcriptEnd> }>();
  private seen = new Set<string>();

  /** How the transcript at `path` ends and when it last changed; undefined when unreadable. */
  async read(path: string): Promise<{ end: ReturnType<typeof transcriptEnd>; mtimeMs: number } | undefined> {
    this.seen.add(path);
    const now = await stat(path).catch(() => undefined);
    if (!now) return undefined;
    const cached = this.known.get(path);
    if (cached && cached.size === now.size && cached.mtimeMs === now.mtimeMs) return cached;
    const tail = await readTailText(path, TRANSCRIPT_TAIL_BYTES);
    if (!tail) return undefined;
    const read = { size: tail.size, mtimeMs: tail.mtimeMs, end: transcriptEnd(tail.text) };
    this.known.set(path, read);
    return read;
  }

  /** The transcript's size when last read, if it was. */
  sizeOf(path: string): number | undefined {
    return this.known.get(path)?.size;
  }

  /** Forgets transcripts not read since the last call. */
  prune(): void {
    for (const path of this.known.keys()) if (!this.seen.has(path)) this.known.delete(path);
    this.seen = new Set();
  }
}

/** `record` without its wait and error kinds, which no longer describe a state its transcript replaced. */
function withoutKinds(record: HookRecord): HookRecord {
  const { waitKind: _wait, errorKind: _error, ...rest } = record;
  return rest;
}

/**
 * Corrects a record with what its transcript shows happened after the last hook event. An interrupt only counts when
 * the transcript changed after the record, so a prompt submitted since then is not shown as interrupted.
 */
async function withTranscriptEnd(record: HookRecord, ends: TranscriptEnds): Promise<HookRecord> {
  if (!record.transcriptPath) return record;
  const read = await ends.read(record.transcriptPath);
  if (!read) return record;
  if (read.end === 'moved') return { ...withoutKinds(record), state: 'idle', detail: MOVED_DETAIL, endKind: 'moved' };
  if (read.end === 'interrupted' && (record.state === 'working' || record.state === 'waiting') && read.mtimeMs >= record.updatedAt) {
    // A finished turn like any other (the board's done lane), shown in its own colour.
    return { ...withoutKinds(record), state: 'done', detail: INTERRUPTED_DETAIL, endKind: 'interrupted' };
  }
  return record;
}

/**
 * Valid records from `<dir>/*.json`, corrected by their transcripts; unreadable or invalid files are skipped. Pass a
 * long-lived `ends` to re-read only the transcripts that changed since the last call.
 */
export async function readHookRecords(dir: string, ends = new TranscriptEnds()): Promise<HookRecord[]> {
  const records = await readJsonFiles(
    dir,
    (n) => n.endsWith('.json'),
    async (text) => {
      const record = parseHookRecord(text);
      return record && withTranscriptEnd(record, ends);
    },
  );
  ends.prune();
  return records;
}

/** True if a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function featureForCwd(features: readonly Feature[], cwd: string): Feature | undefined {
  let best: Feature | undefined;
  let bestLength = -1;
  for (const f of features) {
    for (const dir of featureDirs(f)) {
      if (isWithin(cwd, dir) && dir.length > bestLength) {
        best = f;
        bestLength = dir.length;
      }
    }
  }
  return best;
}

/**
 * The worktree a session works in: the one its cwd is in, unless the cwd is in main (or no worktree) and the last file
 * Claude edited is in another worktree, which means Claude is building there from main.
 */
export function featureForSession(features: readonly Feature[], cwd: string, lastEditPath?: string | null): Feature | undefined {
  const here = featureForCwd(features, cwd);
  if (lastEditPath && (!here || here.isMain)) {
    const edited = featureForCwd(features, lastEditPath);
    if (edited && !edited.isMain) return edited;
  }
  return here;
}

/** The tmux server a record's session runs on. */
const recordServer = (r: HookRecord) => r.tmuxServer ?? DEFAULT_SERVER;
const inSession = (p: TmuxPane, r: HookRecord) => p.session === r.tmuxSession && serverOf(p) === recordServer(r);
const isPane = (p: TmuxPane, r: HookRecord) => p.paneId === r.tmuxPane && serverOf(p) === recordServer(r);

export interface RecordSplit {
  live: HookRecord[];
  /** Records whose Claude process is gone (it crashed or was killed without SessionEnd); safe to delete. */
  dead: HookRecord[];
}

/**
 * A record with a pid is live while that process runs. Records from older hook scripts have no pid: they count as live
 * while their tmux session still runs a program other than a shell, and are never reported dead.
 * When several live records share a Claude process (a /clear or resume without SessionEnd), the newest wins.
 */
export function splitRecords(records: readonly HookRecord[], panes: readonly TmuxPane[], alive: (pid: number) => boolean): RecordSplit {
  const dead: HookRecord[] = [];
  const newest = new Map<string, HookRecord>();
  for (const r of records) {
    let key: string;
    if (r.pid !== undefined) {
      if (!alive(r.pid)) {
        dead.push(r);
        continue;
      }
      key = `pid:${r.pid}`;
    } else {
      if (!r.tmuxSession || !panes.some((p) => inSession(p, r) && paneBusy(p))) continue;
      key = `tmux:${recordServer(r)}:${r.tmuxSession}`;
    }
    const prev = newest.get(key);
    if (!prev || r.updatedAt > prev.updatedAt) newest.set(key, r);
  }
  return { live: [...newest.values()], dead };
}

/** tmux shows Claude Code as `claude`, or as its version (`2.1.3`) for the native build. */
export const isClaudeCommand = (command: string) => command === 'claude' || /^\d+\.\d+\.\d+$/.test(command);

/** Claude runs in the pane: from its process tree when the caller looked (`claude`), else from tmux's command name. */
const paneRunsClaude = (p: TmuxPane) => p.claude ?? isClaudeCommand(p.command);
/** The pane runs Claude or another program, not just a shell. */
const paneBusy = (p: TmuxPane) => paneRunsClaude(p) || !isShellCommand(p.command);

/** SessionEnd deletes a session's record, so a dead process with a record that was still in a turn crashed or was killed. */
const diedMidTurn = (r: HookRecord, p: TmuxPane) => STATE_INFO[r.state].midTurn && inSession(p, r);

/**
 * The cards of sessions working in this workspace: whose cwd is inside one of `dirs` (the workspace root, as opened and
 * resolved) or one of its worktrees (which may live elsewhere, as git linked worktrees can). The cwd decides: tmux
 * session names repeat across workspaces (each has a `cc-main`), so a name only places a card that has no cwd. Every
 * card when `dirs` is empty (no folder open).
 */
export function cardsInScope(cards: readonly SessionCard[], dirs: readonly string[], features: readonly Feature[] = []): SessionCard[] {
  if (!dirs.length) return [...cards];
  const roots = [...dirs, ...features.flatMap(featureDirs)].map(trimSlashes).filter(Boolean);
  const inside = (cwd: string) => roots.some((d) => isWithin(cwd, d));
  return cards.filter((c) => (c.cwd ? inside(c.cwd) : c.featureDir !== undefined));
}

/**
 * One card per live Claude session (wherever it runs), plus tmux panes running `claude` without a hook record, plus
 * DevDesk (`cc-`) tmux sessions whose Claude has exited, plus sessions that ended (`ended`, parked): a DevDesk tmux
 * session left with only a shell takes the ended record of the Claude that ran in it.
 */
export function buildSessionCards(
  panes: readonly TmuxPane[],
  records: readonly HookRecord[],
  features: readonly Feature[],
  alive: (pid: number) => boolean = processAlive,
  /** Only sessions running on this tmux server (`-L` name); every session, wherever it runs, when undefined. */
  onlyServer?: string,
  /** The session each /fork was forked from, by session id. */
  forkParents: ReadonlyMap<string, string> = new Map(),
  /** Sessions that no longer run, newest end first or in any order. */
  ended: readonly EndedRecord[] = [],
): SessionCard[] {
  if (onlyServer !== undefined) {
    const onServer = (r: HookRecord) => (!!r.tmuxPane || !!r.tmuxSession) && recordServer(r) === onlyServer;
    ended = ended.filter(onServer);
    panes = panes.filter((p) => serverOf(p) === onlyServer);
    const kept = new Set(records.filter(onServer).map((r) => r.sessionId));
    // A /fork runs as a background job outside tmux: list it with the session it was forked from, and forks of it.
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of records) {
        const parent = forkParents.get(r.sessionId);
        if (parent && kept.has(parent) && !kept.has(r.sessionId)) grew = !!kept.add(r.sessionId);
      }
    }
    records = records.filter((r) => kept.has(r.sessionId));
  }
  // A feature's own session, else one + New session numbered after it (`cc-a-2`); an exact name wins (feature `a-2`).
  const byTmuxName = (name: string | undefined) =>
    name ? features.find((f) => sessionName(f) === name) ?? features.find((f) => isNumberedSession(name, sessionName(f))) : undefined;
  const covered = new Set<string>(); // `<server>/<pane id>` and `<server>/<session>` that already have a card
  const paneKey = (p: TmuxPane) => `${serverOf(p)}/${p.paneId}`;
  const sessionKey = (p: TmuxPane) => `${serverOf(p)}/${p.session}`;
  const cards: SessionCard[] = [];

  const split = splitRecords(records, panes, alive);
  const liveIds = new Set(split.live.map((r) => r.sessionId));
  // Newest end first, so a tmux session takes the last Claude that ran in it.
  const endedLeft = ended.filter((r) => !liveIds.has(r.sessionId)).sort((a, b) => b.endedAt - a.endedAt);
  const takeEnded = (p: TmuxPane): EndedRecord | undefined => {
    const i = endedLeft.findIndex((r) => r.tmuxSession === p.session && recordServer(r) === serverOf(p));
    return i < 0 ? undefined : endedLeft.splice(i, 1)[0];
  };
  for (const r of split.live) {
    const pane =
      (r.tmuxPane ? panes.find((p) => isPane(p, r)) : undefined) ??
      (r.tmuxSession && !r.tmuxPane ? panes.find((p) => inSession(p, r) && paneBusy(p)) : undefined);
    if (pane) {
      covered.add(paneKey(pane));
      covered.add(sessionKey(pane));
    }
    const feature = featureForSession(features, r.cwd, r.lastEditPath) ?? byTmuxName(pane?.session);
    cards.push({
      id: r.sessionId,
      sessionId: r.sessionId,
      pid: r.pid,
      tmuxSession: pane?.session,
      tmuxPane: pane?.paneId,
      tmuxServer: pane ? serverOf(pane) : undefined,
      featureName: feature?.name,
      featureDir: feature?.dir,
      cwd: r.cwd,
      transcriptPath: r.transcriptPath ?? undefined,
      state: r.state,
      detail: r.detail,
      ...stateKinds(r),
      prompt: r.prompt,
      updatedAt: r.updatedAt,
      attached: pane?.attached ?? false,
      ...(r.asksQuestion ? { asksQuestion: true } : {}),
      ...turnTimes(r),
      ...(r.sessionStartedAt !== undefined ? { sessionStartedAt: r.sessionStartedAt } : {}),
    });
  }

  for (const p of panes) {
    if (!paneRunsClaude(p) || covered.has(paneKey(p))) continue;
    covered.add(paneKey(p));
    covered.add(sessionKey(p));
    const feature = byTmuxName(p.session) ?? (p.cwd ? featureForCwd(features, p.cwd) : undefined);
    cards.push({
      id: `tmux:${serverOf(p)}:${p.paneId}`,
      tmuxSession: p.session,
      tmuxPane: p.paneId,
      tmuxServer: serverOf(p),
      featureName: feature?.name,
      featureDir: feature?.dir,
      cwd: p.cwd,
      state: 'unknown',
      detail: NO_HOOKS_DETAIL,
      attached: p.attached,
      ...(p.claudePid !== undefined ? { pid: p.claudePid } : {}),
    });
  }

  for (const p of panes) {
    if (!p.session.startsWith('cc-') || covered.has(sessionKey(p))) continue;
    covered.add(sessionKey(p));
    const feature = byTmuxName(p.session) ?? (p.cwd ? featureForCwd(features, p.cwd) : undefined);
    const running = panes.some((q) => sessionKey(q) === sessionKey(p) && paneBusy(q));
    const was = running ? undefined : takeEnded(p);
    if (was) {
      cards.push({
        ...parkedCard(was, feature ?? featureForSession(features, was.cwd, was.lastEditPath)),
        tmuxSession: p.session,
        tmuxPane: p.paneId,
        tmuxServer: serverOf(p),
        attached: p.attached,
        ...(split.dead.some((r) => diedMidTurn(r, p)) ? { crashed: true } : {}),
      });
      continue;
    }
    cards.push({
      id: `tmux:${serverOf(p)}:${p.session}`,
      tmuxSession: p.session,
      tmuxPane: p.paneId,
      tmuxServer: serverOf(p),
      featureName: feature?.name,
      featureDir: feature?.dir,
      cwd: p.cwd,
      state: running ? 'unknown' : 'stopped',
      detail: running ? NO_HOOKS_DETAIL : NOT_RUNNING_DETAIL,
      attached: p.attached,
      ...(!running && split.dead.some((r) => diedMidTurn(r, p)) ? { crashed: true } : {}),
    });
  }

  for (const r of endedLeft) cards.push(parkedCard(r, featureForSession(features, r.cwd, r.lastEditPath)));

  return cards.sort(
    (a, b) => STATE_INFO[a.state].listOrder - STATE_INFO[b.state].listOrder || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
  );
}

/** The record's wait, error and end kinds, for its card. */
export function stateKinds(r: HookRecord): Pick<SessionCard, 'waitKind' | 'errorKind' | 'endKind'> {
  return {
    ...(r.waitKind ? { waitKind: r.waitKind } : {}),
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
    ...(r.endKind ? { endKind: r.endKind } : {}),
  };
}

function turnTimes(r: HookRecord): Pick<SessionCard, 'turnStartedAt' | 'turnEndedAt'> {
  return {
    ...(r.turnStartedAt !== undefined ? { turnStartedAt: r.turnStartedAt } : {}),
    ...(r.turnEndedAt !== undefined ? { turnEndedAt: r.turnEndedAt } : {}),
  };
}

/** The card of a session that no longer runs; opening it resumes the conversation. */
function parkedCard(r: EndedRecord, feature: Feature | undefined): SessionCard {
  return {
    id: r.sessionId,
    sessionId: r.sessionId,
    featureName: feature?.name,
    featureDir: feature?.dir,
    cwd: r.cwd,
    transcriptPath: r.transcriptPath ?? undefined,
    state: 'parked',
    detail: r.detail,
    prompt: r.prompt,
    updatedAt: r.updatedAt,
    attached: false,
    endReason: r.endReason,
    lastState: r.state,
    // How its last turn ended, for the look it keeps (see `finishedLook`); a parked session waits on nothing.
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
    ...(r.endKind ? { endKind: r.endKind } : {}),
    endedAt: r.endedAt,
    ...(r.tmuxSession ? { formerTmuxSession: r.tmuxSession, formerTmuxServer: r.tmuxServer ?? DEFAULT_SERVER } : {}),
    ...(r.asksQuestion ? { asksQuestion: true } : {}),
    ...turnTimes(r),
    ...(r.endReason === 'crashed' ? { crashed: true } : {}),
  };
}

/**
 * Where Claude already runs conversation `sessionId`, so resuming it again would start a second Claude on it (two
 * terminals, one status record, and a card that seems to come from nowhere when you type into one of them): a card
 * in a tmux pane with Claude running, by its session id or by its Claude process (`registry`, Claude's own list of
 * running processes, covers panes without hook records); `'elsewhere'` when a live process runs it outside any card
 * (another tmux server, or no tmux); undefined when nothing runs it.
 */
export function runningCopy(
  cards: readonly SessionCard[],
  registry: readonly RegistryEntry[],
  sessionId: string,
  alive: (pid: number) => boolean = processAlive,
): SessionCard | 'elsewhere' | undefined {
  const pids = new Set(registry.filter((e) => e.sessionId === sessionId && alive(e.pid)).map((e) => e.pid));
  const running = (c: SessionCard) => STATE_INFO[c.state].live && !!c.tmuxSession;
  const card =
    cards.find((c) => running(c) && c.sessionId === sessionId) ?? cards.find((c) => running(c) && c.pid !== undefined && pids.has(c.pid));
  return card ?? (pids.size ? 'elsewhere' : undefined);
}
