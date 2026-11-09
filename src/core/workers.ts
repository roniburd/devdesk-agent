import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, parseObject } from './json';
import type { SessionCard } from './sessions';
import { claudeGone } from './sessionSend';
import { shellQuote } from './shell';
import { DEFAULT_SERVER, isServerName } from './tmux';

/**
 * Coordinator and worker sessions: a Claude session (the coordinator) runs `devdesk worker start` to start other
 * Claude sessions (workers) on parts of its task, each in a worktree of its own or in the coordinator's. Workers
 * report with `devdesk worker done` or ask with `devdesk worker ask`; what they send goes to the coordinator's mailbox,
 * and the window types a one-line notice into the coordinator when it waits at an empty prompt.
 *
 * The mailbox is a JSON-lines file per coordinator in `workers/` of the sessions state directory, only ever appended
 * to (under a file lock), so a lost notice loses nothing: `devdesk worker check` reads what is unread whenever it runs.
 */
export const workersDirIn = (stateDir: string) => join(stateDir, 'workers');

/** A coordinator: the tmux session it runs in, on its server. */
export interface Coordinator {
  server: string;
  session: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
/** A coordinator's mailbox file (`devdesk~cc-main-2.jsonl`): `~` never appears in either part, so the name is unambiguous. */
export const mailboxFileName = (c: Coordinator) => `${safe(c.server)}~${safe(c.session)}.jsonl`;
export const isMailboxFileName = (name: string) => /^[A-Za-z0-9_.-]+~[A-Za-z0-9_.-]+\.jsonl$/.test(name);

export type WorkerWhere = 'new' | 'current';
export type Outcome = 'succeeded' | 'failed';
export const OUTCOMES: readonly Outcome[] = ['succeeded', 'failed'];

/** A worker's task, as `devdesk worker start` recorded it, with where it started once it has. */
export interface WorkerTask {
  id: string;
  name: string;
  task: string;
  coordinator: Coordinator;
  where: WorkerWhere;
  base?: string;
  at: number;
  /** Once started: its tmux session (on `server`), its folder and the worktree's name. */
  session?: string;
  server?: string;
  dir?: string;
  worktree?: string;
  startedAt?: number;
}

/**
 * What reaches the coordinator: a worker's report (`done`), its question (`ask`), DevDesk's notice that it stopped
 * without reporting (`stopped`), or that it could not be started (`failed`).
 */
export type MessageKind = 'done' | 'ask' | 'stopped' | 'failed';
export interface WorkerMessage {
  id: string;
  task: string;
  kind: MessageKind;
  outcome?: Outcome;
  text: string;
  at: number;
}

/** The coordinator's answer to a worker (`devdesk worker reply`), typed into the worker once it waits at its prompt. */
export interface WorkerReply {
  id: string;
  task: string;
  text: string;
  at: number;
}

/** A mailbox as its lines add up. */
export interface Mailbox {
  coordinator?: Coordinator;
  tasks: WorkerTask[];
  messages: WorkerMessage[];
  /** Messages `devdesk worker check` printed. */
  read: Set<string>;
  /** Messages the coordinator was told about (one notice per batch). */
  nudged: Set<string>;
  replies: WorkerReply[];
  /** Replies typed into their worker, and when. */
  delivered: Map<string, number>;
}

/** One line of a mailbox file. */
export type MailboxLine =
  | ({ t: 'task' } & WorkerTask)
  | { t: 'started'; task: string; session: string; server: string; dir: string; worktree?: string; at: number }
  | ({ t: 'msg' } & WorkerMessage)
  | ({ t: 'reply' } & WorkerReply)
  | { t: 'read' | 'nudged' | 'delivered'; ids: string[]; at: number };

export const mailboxLine = (line: MailboxLine) => `${JSON.stringify(line)}\n`;

export const TASK_ID = /^w-[0-9a-f]{6,16}$/;
export const isTaskId = (s: unknown): s is string => typeof s === 'string' && TASK_ID.test(s);
const MESSAGE_ID = /^[A-Za-z0-9_-]{4,40}$/;
const str = (v: unknown): v is string => typeof v === 'string';
const MESSAGE_KINDS: ReadonlySet<string> = new Set(['done', 'ask', 'stopped', 'failed']);

function coordinatorOf(v: unknown): Coordinator | undefined {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  return o && isServerName(o.server) && str(o.session) && o.session ? { server: o.server, session: o.session } : undefined;
}

/** A mailbox file's text as its state; lines it cannot read are skipped. */
export function parseMailbox(text: string): Mailbox {
  const box: Mailbox = { tasks: [], messages: [], read: new Set(), nudged: new Set(), replies: [], delivered: new Map() };
  const byId = new Map<string, WorkerTask>();
  for (const raw of text.split('\n')) {
    const o = raw.trim() ? parseObject(raw) : undefined;
    if (!o || !isFiniteNumber(o.at)) continue;
    if (o.t === 'task') {
      const coordinator = coordinatorOf(o.coordinator);
      if (!isTaskId(o.id) || !str(o.name) || !str(o.task) || !coordinator || byId.has(o.id)) continue;
      const task: WorkerTask = { id: o.id, name: o.name, task: o.task, coordinator, where: o.where === 'new' ? 'new' : 'current', at: o.at };
      if (str(o.base)) task.base = o.base;
      box.coordinator ??= coordinator;
      byId.set(task.id, task);
      box.tasks.push(task);
    } else if (o.t === 'started') {
      const task = str(o.task) ? byId.get(o.task) : undefined;
      if (!task || !str(o.session) || !isServerName(o.server) || !str(o.dir)) continue;
      Object.assign(task, { session: o.session, server: o.server, dir: o.dir, startedAt: o.at, ...(str(o.worktree) ? { worktree: o.worktree } : {}) });
    } else if (o.t === 'msg') {
      if (!str(o.id) || !MESSAGE_ID.test(o.id) || !str(o.task) || !str(o.kind) || !MESSAGE_KINDS.has(o.kind) || !str(o.text)) continue;
      const m: WorkerMessage = { id: o.id, task: o.task, kind: o.kind as MessageKind, text: o.text, at: o.at };
      if (o.outcome === 'succeeded' || o.outcome === 'failed') m.outcome = o.outcome;
      box.messages.push(m);
    } else if (o.t === 'reply') {
      if (!str(o.id) || !MESSAGE_ID.test(o.id) || !str(o.task) || !str(o.text)) continue;
      box.replies.push({ id: o.id, task: o.task, text: o.text, at: o.at });
    } else if ((o.t === 'read' || o.t === 'nudged' || o.t === 'delivered') && Array.isArray(o.ids)) {
      for (const id of o.ids.filter(str)) {
        if (o.t === 'delivered') box.delivered.set(id, o.at);
        else box[o.t].add(id);
      }
    }
  }
  return box;
}

/** The mailboxes in `dir`, by file name. */
export async function readMailboxes(dir: string): Promise<Map<string, Mailbox>> {
  const boxes = new Map<string, Mailbox>();
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.filter(isMailboxFileName).map(async (n) => {
      const text = await readFile(join(dir, n), 'utf8').catch(() => undefined);
      if (text !== undefined) boxes.set(n, parseMailbox(text));
    }),
  );
  return boxes;
}

/** The mailbox (file name and state) that holds the task `id`. */
export function mailboxOfTask(boxes: ReadonlyMap<string, Mailbox>, id: string): { file: string; box: Mailbox; task: WorkerTask } | undefined {
  for (const [file, box] of boxes) {
    const task = box.tasks.find((t) => t.id === id);
    if (task) return { file, box, task };
  }
  return undefined;
}

const serverOf = (s: string | undefined) => s ?? DEFAULT_SERVER;
/** The card of the tmux session `session` on `server`, when listed. */
export function cardOfSession(cards: readonly SessionCard[], server: string | undefined, session: string | undefined): SessionCard | undefined {
  if (!session) return undefined;
  return cards.find((c) => c.tmuxSession === session && serverOf(c.tmuxServer) === serverOf(server));
}

/** The task whose worker runs in the card's tmux session. */
export function taskOfCard(boxes: ReadonlyMap<string, Mailbox>, card: Pick<SessionCard, 'tmuxSession' | 'tmuxServer'>): WorkerTask | undefined {
  if (!card.tmuxSession) return undefined;
  for (const box of boxes.values()) {
    const task = box.tasks.find((t) => t.session === card.tmuxSession && serverOf(t.server) === serverOf(card.tmuxServer));
    if (task) return task;
  }
  return undefined;
}

/** The worker's report (its last `done`), or DevDesk's word that it could not start. */
export function settlement(box: Mailbox, id: string): WorkerMessage | undefined {
  return box.messages.filter((m) => m.task === id && (m.kind === 'done' || m.kind === 'failed')).at(-1);
}

/** Where a worker stands, as `devdesk worker list` and the board say it. */
export type WorkerStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'ended' | 'succeeded' | 'failed';

/**
 * A worker's status: what it reported (`succeeded`, `failed`), else what its card shows: `starting` (no session yet),
 * `ended` (its card is gone, or Claude no longer runs in it), `working`, `waiting` (on a permission or question),
 * `idle` (its turn ended: waiting at its prompt).
 */
export function workerStatus(task: WorkerTask, box: Mailbox, card: SessionCard | undefined): WorkerStatus {
  const settled = settlement(box, task.id);
  if (settled) return settled.kind === 'failed' ? 'failed' : (settled.outcome ?? 'succeeded');
  if (!task.session) return 'starting';
  if (!card || claudeGone(card)) return 'ended';
  if (card.state === 'working') return 'working';
  if (card.state === 'waiting' || card.state === 'blocked') return 'waiting';
  return 'idle';
}

/** Whether a worker counts toward the most that may run at once: not reported, not failed to start, not ended. */
export const workerActive = (status: WorkerStatus) => status === 'starting' || status === 'working' || status === 'waiting' || status === 'idle';

/** Whether the worker's Claude no longer works: its turn ended, or it is gone. */
export function workerStopped(card: SessionCard | undefined): boolean {
  return !card || claudeGone(card) || card.state === 'done' || card.state === 'idle';
}

/**
 * Whether DevDesk tells the coordinator that the worker stopped without reporting: it has not reported, it stopped
 * (`stoppedAt`) after it was last woken (started, or a reply typed into it) at least `graceMs` ago, and has neither
 * asked anything nor been reported as stopped since it was woken.
 */
export function needsEscalation(task: WorkerTask, box: Mailbox, stoppedAt: number | undefined, now: number, graceMs: number): boolean {
  if (!task.session || settlement(box, task.id) || stoppedAt === undefined || now - stoppedAt < graceMs) return false;
  const woken = Math.max(task.startedAt ?? task.at, ...box.replies.filter((r) => r.task === task.id).map((r) => box.delivered.get(r.id) ?? 0));
  if (stoppedAt < woken) return false;
  return !box.messages.some((m) => m.task === task.id && (m.kind === 'ask' || m.kind === 'stopped') && m.at >= woken);
}

/** The unread messages. */
export const unread = (box: Mailbox) => box.messages.filter((m) => !box.read.has(m.id));

/** The unread messages to tell the coordinator about now: all of them, when one is new since its last notice; else none. */
export function nudgeBatch(box: Mailbox): string[] {
  const ids = unread(box).map((m) => m.id);
  return ids.some((id) => !box.nudged.has(id)) ? ids : [];
}

const quote = (command: string) => (/[^A-Za-z0-9_./~-]/.test(command) ? `'${command.replace(/'/g, `'\\''`)}'` : command);

/** The one line typed into an idle coordinator with unread messages. */
export function nudgeText(count: number, command: string): string {
  return `You have ${count} worker message${count === 1 ? '' : 's'}. Run \`${quote(command)} worker check\`.`;
}

/** The replies not yet typed into their worker. */
export const pendingReplies = (box: Mailbox) => box.replies.filter((r) => !box.delivered.has(r.id));

/** A reply as typed into its worker. */
export function replyText(reply: WorkerReply, command: string): string {
  return `Your coordinator answers: ${reply.text}\n\nContinue the task; when it is finished, report with \`${quote(command)} worker done --task ${reply.task} --outcome succeeded|failed --summary "..."\`.`;
}

/**
 * Claude's arguments that let a worker run `devdesk worker` (to ask and report) without asking the user, who does not
 * watch it, for permission: `--allowedTools` with a Bash rule for the command (in shell syntax).
 */
export function workerAllowArgs(command: string): string {
  return `--allowedTools ${shellQuote(`Bash(${command} worker:*)`)}`;
}

/**
 * The worker's first prompt: its task first (so its card is named after it), then how it reports, with the exact
 * commands to run.
 */
export function workerPrompt(o: { id: string; name: string; task: string; coordinator: string; command: string }): string {
  const cli = quote(o.command);
  return `${o.task.trim()}

---
You are a worker session ("${o.name}", task ${o.id}) that another Claude session (your coordinator, ${o.coordinator}) started through DevDesk to do the task above. The coordinator cannot see this terminal: reach it only with the commands below, and only to ask something you need, or to report. Do only this task, yourself (no helper workers). Never ask the user with a question prompt: ask the coordinator.

To ask the coordinator, run this, then end your turn; its answer is typed in here:
  ${cli} worker ask --task ${o.id} "<your question>"

When the task is finished (or cannot be), run this exactly once, then end your turn. The summary is three sentences: what you did, what you found, what is left. Use --outcome failed when the work is not done; never hide a failure in the summary.
  ${cli} worker done --task ${o.id} --outcome succeeded --summary "<what you did, what you found, what is left>"`;
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/** What `devdesk worker check` prints for `messages` (of `box`). */
export function checkText(box: Mailbox, messages: readonly WorkerMessage[], command: string, now: number): string {
  if (!messages.length) return 'No new worker messages.';
  const name = (id: string) => box.tasks.find((t) => t.id === id)?.name ?? id;
  const lines = messages.map((m) => {
    const who = `${name(m.task)} (task ${m.task}, ${ago(now - m.at)} ago)`;
    switch (m.kind) {
      case 'done':
        return `[${m.outcome ?? 'succeeded'}] ${who}: ${m.text}`;
      case 'ask':
        return `[question] ${who}: ${m.text}\n  answer: ${quote(command)} worker reply --task ${m.task} "<answer>"`;
      case 'stopped':
        return `[stopped without reporting] ${who}: ${m.text}\n  steer it: ${quote(command)} worker reply --task ${m.task} "<what to do>"`;
      case 'failed':
        return `[failed to start] ${who}: ${m.text}`;
    }
  });
  return `${messages.length} new worker message${messages.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`;
}

/** What `devdesk worker list` prints: one line per worker, with its status and where it runs. */
export function listText(box: Mailbox | undefined, statusOf: (task: WorkerTask) => WorkerStatus): string {
  if (!box?.tasks.length) return 'No workers: start one with devdesk worker start.';
  const rows = box.tasks.map((t) => `${t.id}  ${t.name}  ${statusOf(t)}${t.worktree ? `  worktree ${t.worktree}` : ''}${t.session ? `  (tmux ${t.session})` : ''}`);
  const unreadCount = unread(box).length;
  return `${rows.join('\n')}${unreadCount ? `\n\n${unreadCount} unread message${unreadCount === 1 ? '' : 's'}: devdesk worker check` : ''}`;
}

/** The board's line on a coordinator's card: "3 workers: 1 done, 1 failed, 1 working". */
export function teamText(statuses: readonly WorkerStatus[]): string {
  const n = statuses.length;
  const count = (s: WorkerStatus | WorkerStatus[]) => statuses.filter((x) => (Array.isArray(s) ? s.includes(x) : x === s)).length;
  const parts = [
    [count('succeeded'), 'done'],
    [count('failed'), 'failed'],
    [count(['working', 'starting']), 'working'],
    [count('waiting'), 'waiting'],
    [count('idle'), 'idle'],
    [count('ended'), 'ended'],
  ]
    .filter(([c]) => c)
    .map(([c, label]) => `${c} ${label}`);
  return `${n} worker${n === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/** A card's place in a team: the worker's task and coordinator, or the coordinator's workers' statuses. */
export interface CardTeam {
  workerOf?: { task: string; name: string; coordinator: Coordinator; status: WorkerStatus };
  workers?: WorkerStatus[];
}

/** Every card with its place in a team (`boxes` from readMailboxes). */
export function cardsWithWorkers(cards: SessionCard[], boxes: ReadonlyMap<string, Mailbox>): SessionCard[] {
  if (!boxes.size) return cards;
  const team = new Map<SessionCard, CardTeam>();
  for (const box of boxes.values()) {
    if (!box.tasks.length || !box.coordinator) continue;
    const statuses: WorkerStatus[] = [];
    for (const task of box.tasks) {
      const card = cardOfSession(cards, task.server, task.session);
      const status = workerStatus(task, box, card);
      statuses.push(status);
      if (card) team.set(card, { ...team.get(card), workerOf: { task: task.id, name: task.name, coordinator: box.coordinator, status } });
    }
    const coordinator = cardOfSession(cards, box.coordinator.server, box.coordinator.session);
    if (coordinator) team.set(coordinator, { ...team.get(coordinator), workers: [...(team.get(coordinator)?.workers ?? []), ...statuses] });
  }
  return team.size ? cards.map((c) => (team.has(c) ? { ...c, team: team.get(c) } : c)) : cards;
}
