import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { BoardSessions } from './board/boardSessions';
import { sessionAccount } from './claudeAccounts';
import { claudeNeedsTrust } from './claudeTrust';
import type { CliRequest } from './core/devdeskCli';
import { withFileLock } from './core/fileLock';
import { readTextIfExists } from './core/json';
import { isWithin } from './core/paths';
import { featureForCwd, type SessionCard } from './core/sessions';
import { sendBlocker } from './core/sessionSend';
import { joinArgs } from './core/modes';
import { promptArg } from './core/shell';
import { DEFAULT_SERVER, sessionName } from './core/tmux';
import { truncate } from './core/sessionsView';
import {
  cardOfSession,
  checkText,
  type Coordinator,
  listText,
  type Mailbox,
  mailboxFileName,
  mailboxLine,
  type MailboxLine,
  mailboxOfTask,
  needsEscalation,
  nudgeBatch,
  nudgeText,
  parseMailbox,
  pendingReplies,
  readMailboxes,
  replyText,
  taskOfCard,
  unread,
  type WorkerMessage,
  type WorkerTask,
  workerActive,
  workerAllowArgs,
  workerPrompt,
  workerStatus,
  workerStopped,
  workersDirIn,
} from './core/workers';
import { claudeDefaultAccount, sessionsClaudeCommand, sessionsStateDir, sessionsTmuxServer, workersConfig, workspaceRoot } from './config';
import { log } from './log';
import { startNumbered } from './sessionsCommands';
import type { SessionsModel } from './sessionsModel';
import type { SessionsTree } from './sessionsTree';
import { newWorktreeSession, noWorktreesReason, type WorktreeTaskStore } from './worktreeSessions';

/** What the window answers the `devdesk` command. */
export interface WorkerAnswer {
  ok: boolean;
  message: string;
}

/** How often mailboxes are looked at for notices to type, replies to deliver and workers that stopped silently. */
const TICK_MS = 3000;

const serverOf = (s: string | undefined) => s ?? DEFAULT_SERVER;
const newId = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;

/**
 * This window's end of coordinator and worker sessions (see `core/workers.ts`): `devdesk worker` requests, and a tick
 * that types notices into idle coordinators with unread mail, types replies into idle workers, and tells coordinators
 * about workers that stopped without reporting. Every change to a mailbox is made under its file lock, re-read first,
 * so two windows never type the same notice twice.
 */
export class WorkerHub implements vscode.Disposable {
  private readonly boardSessions: BoardSessions;
  private readonly timer: NodeJS.Timeout;
  private readonly hold: { set(want: boolean): void };
  private ticking = false;
  /** When each worker was first seen stopped (its turn over, or gone), by task id; cleared once it works again. */
  private readonly stoppedSince = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Notices, replies and escalations so far (the e2e tests wait on it). */
  typed = 0;

  constructor(
    private readonly sessions: SessionsModel,
    private readonly tree: SessionsTree,
    private readonly worktreeTasks: WorktreeTaskStore,
    private readonly command: () => string,
  ) {
    this.boardSessions = new BoardSessions(sessions, tree);
    this.hold = sessions.holder();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devdesk.workers')) void this.tick();
      }),
    );
  }

  private get dir(): string {
    return workersDirIn(sessionsStateDir());
  }

  private async readBox(file: string): Promise<Mailbox> {
    return parseMailbox((await readTextIfExists(join(this.dir, file))) ?? '');
  }

  /** Appends `lines` to the mailbox `file`, under its lock, when `decide` (given the mailbox as it is now) returns some. */
  private async change<T>(file: string, decide: (box: Mailbox) => Promise<{ lines: MailboxLine[]; result: T }>): Promise<T> {
    const path = join(this.dir, file);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(
      path,
      async () => {
        const { lines, result } = await decide(parseMailbox((await readTextIfExists(path)) ?? ''));
        if (lines.length) await appendFile(path, lines.map(mailboxLine).join(''), { mode: 0o600 });
        return result;
      },
      { dirMode: 0o700 },
    );
  }

  private append(file: string, ...lines: MailboxLine[]): Promise<void> {
    return this.change(file, async () => ({ lines, result: undefined }));
  }

  /** The card of the pane the request came from (a session just started may need a fresh list). */
  private async cardOfPane(req: CliRequest): Promise<SessionCard | undefined> {
    const match = (cards: readonly SessionCard[]) => cards.find((c) => c.tmuxPane === req.pane && serverOf(c.tmuxServer) === serverOf(req.server) && c.tmuxSession);
    return match(this.sessions.current) ?? match(await this.sessions.fresh());
  }

  private async coordinatorOf(req: CliRequest): Promise<{ coordinator: Coordinator; card: SessionCard } | { error: string }> {
    const card = await this.cardOfPane(req);
    if (!card?.tmuxSession) return { error: `no DevDesk Claude session in tmux pane ${req.server ?? DEFAULT_SERVER}:${req.pane}` };
    return { coordinator: { server: serverOf(card.tmuxServer), session: card.tmuxSession }, card };
  }

  /** Does a `devdesk worker` request. */
  async handle(req: CliRequest): Promise<WorkerAnswer> {
    try {
      switch (req.verb) {
        case 'start':
          return await this.start(req);
        case 'check':
          return await this.check(req);
        case 'list':
          return await this.list(req);
        case 'done':
        case 'ask':
          return await this.report(req);
        case 'reply':
          return await this.reply(req);
        default:
          return { ok: false, message: `unknown worker command ${String(req.verb)}` };
      }
    } finally {
      void this.tick();
    }
  }

  private async start(req: CliRequest): Promise<WorkerAnswer> {
    const found = await this.coordinatorOf(req);
    if ('error' in found) return { ok: false, message: found.error };
    const { coordinator } = found;
    if (taskOfCard(await readMailboxes(this.dir), found.card)) return { ok: false, message: 'a worker cannot start workers of its own: ask your coordinator instead' };
    const root = workspaceRoot();
    if (req.where === 'new') {
      const why = root ? noWorktreesReason(root) : 'this VS Code window has no folder open';
      if (why) return { ok: false, message: `${why} (use --worktree current)` };
    }
    const file = mailboxFileName(coordinator);
    const cards = this.sessions.current;
    const { maxConcurrent } = workersConfig();
    const task = await this.change<WorkerTask | { error: string }>(file, async (box) => {
      const active = box.tasks.filter((t) => workerActive(workerStatus(t, box, cardOfSession(cards, t.server, t.session)))).length;
      if (active >= maxConcurrent) return { lines: [], result: { error: `${active} workers already run (devdesk.workers.maxConcurrent is ${maxConcurrent}): wait for their reports` } };
      const t: WorkerTask = { id: newId('w-'), name: req.name!, task: req.text!.trim(), coordinator, where: req.where ?? 'new', at: Date.now(), ...(req.base ? { base: req.base } : {}) };
      return { lines: [{ t: 'task', ...t }], result: t };
    });
    if ('error' in task) return { ok: false, message: task.error };
    log.info(`worker ${task.id} (${task.name}) of ${coordinator.session}: starting`);
    void this.launch(file, task, req).catch((err: Error) => this.failed(file, task, err.message));
    return {
      ok: true,
      message: `Started worker "${task.name}": task ${task.id}${task.where === 'new' ? ', in a new worktree' : ''}. It reports to you. Start any other workers, then end your turn: you will be told when messages arrive (then run: devdesk worker check).`,
    };
  }

  /** Makes the worker's worktree (unless it works in the coordinator's) and starts Claude there, in the background. */
  private async launch(file: string, task: WorkerTask, req: CliRequest): Promise<void> {
    const prompt = workerPrompt({ id: task.id, name: task.name, task: task.task, coordinator: task.coordinator.session, command: this.command() });
    const server = sessionsTmuxServer();
    // Workers run in their coordinator's Claude account (devdesk.claude.accounts).
    const coordinator = cardOfSession(this.sessions.current, task.coordinator.server, task.coordinator.session);
    const account = coordinator ? sessionAccount(coordinator) : claudeDefaultAccount();
    let session: string | undefined;
    let where: { name: string; dir: string } | undefined;
    let why = '';
    if (task.where === 'current') {
      const feature = featureForCwd(await this.sessions.loadFeatures(), req.cwd);
      const dir = req.cwd;
      session = await startNumbered(
        this.sessions,
        this.tree,
        sessionName(feature ?? { name: 'main', dir, isMain: true }),
        dir,
        sessionsClaudeCommand(joinArgs(workerAllowArgs(this.command()), promptArg(prompt)), undefined, account),
        await claudeNeedsTrust(dir, account),
      );
      where = { name: feature?.name ?? 'main', dir };
    } else {
      const root = workspaceRoot()!;
      const features = await this.sessions.loadFeatures();
      const main = features.find((f) => f.isMain) ?? features[0];
      const pkg = main?.packages.filter((p) => isWithin(req.cwd, p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
      const ok = await newWorktreeSession(this.sessions, this.tree, this.worktreeTasks, truncate(task.task.split('\n')[0], 120), {
        name: task.name,
        prompt,
        extraArgs: workerAllowArgs(this.command()),
        open: false,
        account,
        base: task.base,
        ...(pkg ? { packageDir: pkg.dir } : {}),
        untrusted: claudeNeedsTrust,
        started: (s) => (session = s),
        created: (w) => (where = w),
        failed: (m) => (why = m),
      });
      if (!ok || !session) return this.failed(file, task, why || `the worktree session did not start in ${root}`);
    }
    await this.append(file, { t: 'started', task: task.id, session: session!, server, dir: where!.dir, ...(where ? { worktree: where.name } : {}), at: Date.now() });
    log.info(`worker ${task.id} (${task.name}) of ${task.coordinator.session}: started in ${session} (${where!.dir})`);
  }

  private async failed(file: string, task: WorkerTask, why: string): Promise<void> {
    log.warn(`worker ${task.id} (${task.name}) could not start: ${why}`);
    await this.append(file, { t: 'msg', id: newId('m-'), task: task.id, kind: 'failed', outcome: 'failed', text: why, at: Date.now() });
    void this.tick();
  }

  private async check(req: CliRequest): Promise<WorkerAnswer> {
    const found = await this.coordinatorOf(req);
    if ('error' in found) return { ok: false, message: found.error };
    const command = this.command();
    const text = await this.change(mailboxFileName(found.coordinator), async (box) => {
      const fresh = unread(box);
      const lines: MailboxLine[] = fresh.length ? [{ t: 'read', ids: fresh.map((m) => m.id), at: Date.now() }] : [];
      return { lines, result: checkText(box, fresh, command, Date.now()) };
    });
    return { ok: true, message: text };
  }

  private async list(req: CliRequest): Promise<WorkerAnswer> {
    const found = await this.coordinatorOf(req);
    if ('error' in found) return { ok: false, message: found.error };
    const box = await this.readBox(mailboxFileName(found.coordinator));
    const cards = await this.sessions.fresh();
    return { ok: true, message: listText(box, (t) => workerStatus(t, box, cardOfSession(cards, t.server, t.session))) };
  }

  /** The worker's task: the one named (`--task`), else the one whose worker runs in the request's pane. */
  private async taskOf(req: CliRequest): Promise<{ file: string; box: Mailbox; task: WorkerTask } | { error: string }> {
    const boxes = await readMailboxes(this.dir);
    if (req.taskId) return mailboxOfTask(boxes, req.taskId) ?? { error: `no worker task ${req.taskId}` };
    const card = req.pane ? await this.cardOfPane(req) : undefined;
    const task = card ? taskOfCard(boxes, card) : undefined;
    return task ? mailboxOfTask(boxes, task.id)! : { error: 'name the task: --task <id> (your first prompt has it)' };
  }

  private async report(req: CliRequest): Promise<WorkerAnswer> {
    const found = await this.taskOf(req);
    if ('error' in found) return { ok: false, message: found.error };
    const { file, task } = found;
    const message: WorkerMessage = {
      id: newId('m-'),
      task: task.id,
      kind: req.verb === 'done' ? 'done' : 'ask',
      text: req.text!.trim(),
      at: Date.now(),
      ...(req.verb === 'done' ? { outcome: req.outcome } : {}),
    };
    await this.append(file, { t: 'msg', ...message });
    log.info(`worker ${task.id} (${task.name}) ${message.kind === 'done' ? `reported ${message.outcome}` : 'asked its coordinator'}`);
    return {
      ok: true,
      message:
        message.kind === 'done'
          ? `Reported ${message.outcome} to your coordinator (${task.coordinator.session}). End your turn now.`
          : `Asked your coordinator (${task.coordinator.session}). End your turn now: its answer will be typed here.`,
    };
  }

  private async reply(req: CliRequest): Promise<WorkerAnswer> {
    const found = await this.taskOf(req);
    if ('error' in found) return { ok: false, message: found.error };
    const { file, task } = found;
    if (req.pane) {
      const me = await this.cardOfPane(req);
      if (me?.tmuxSession && (me.tmuxSession !== task.coordinator.session || serverOf(me.tmuxServer) !== task.coordinator.server))
        return { ok: false, message: `task ${task.id} is not one of your workers` };
    }
    await this.append(file, { t: 'reply', id: newId('r-'), task: task.id, text: req.text!.trim(), at: Date.now() });
    return { ok: true, message: `The answer goes to worker "${task.name}" as soon as it waits at its prompt.` };
  }

  /** Whether Claude waits at an empty prompt in the card's session, so a line can be typed in without interrupting it. */
  private async idle(card: SessionCard | undefined): Promise<boolean> {
    if (!card?.tmuxPane || card.state === 'working') return false;
    const screen = await this.boardSessions.promptScreen(card).catch(() => undefined);
    return !!screen && !screen.exited && !sendBlocker(card, '', screen);
  }

  /** One look at every mailbox whose coordinator this window lists. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const boxes = await readMailboxes(this.dir);
      const cards = this.sessions.current;
      const config = workersConfig();
      const now = Date.now();
      // Keep the session list fresh while some worker has not settled, or mail waits to be told about.
      const busy = [...boxes.values()].some(
        (box) => nudgeBatch(box).length > 0 || pendingReplies(box).length > 0 || box.tasks.some((t) => workerActive(workerStatus(t, box, cardOfSession(cards, t.server, t.session)))),
      );
      this.hold.set(busy);
      if (!this.sessions.isLoaded) return;
      for (const [file, box] of boxes) {
        if (!box.coordinator) continue;
        // The coordinator's window acts on its mailbox: another may not list its workers (devdesk.sessions.workspaceOnly).
        const coordinator = cardOfSession(cards, box.coordinator.server, box.coordinator.session);
        if (!coordinator) continue;
        await this.escalate(file, box, cards, now, config.escalationMs).catch((err: Error) => log.warn(`workers: ${err.message}`));
        await this.deliver(file, box, cards).catch((err: Error) => log.warn(`workers: cannot deliver a reply: ${err.message}`));
        if (config.nudge) await this.nudge(file, box, coordinator).catch((err: Error) => log.warn(`workers: cannot tell ${box.coordinator?.session}: ${err.message}`));
      }
    } catch (err) {
      log.warn(`workers: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async escalate(file: string, box: Mailbox, cards: readonly SessionCard[], now: number, graceMs: number): Promise<void> {
    for (const task of box.tasks) {
      if (!task.session) continue;
      const card = cardOfSession(cards, task.server, task.session);
      if (!workerStopped(card)) {
        this.stoppedSince.delete(task.id);
        continue;
      }
      if (!this.stoppedSince.has(task.id)) this.stoppedSince.set(task.id, card?.state === 'done' && card.turnEndedAt ? Math.min(card.turnEndedAt, now) : now);
      const stoppedAt = this.stoppedSince.get(task.id);
      if (!needsEscalation(task, box, stoppedAt, now, graceMs)) continue;
      const gone = !card || card.state === 'stopped' || card.state === 'parked';
      const last = card?.detail ? ` Its last words: ${truncate(card.detail.replace(/\s+/g, ' '), 300)}` : '';
      const text = gone ? `Claude no longer runs in its session (${task.session}).${last}` : `Its turn ended without devdesk worker done or ask.${last}`;
      const wrote = await this.change(file, async (now2) => {
        const again = now2.tasks.find((t) => t.id === task.id);
        if (!again || !needsEscalation(again, now2, stoppedAt, Date.now(), graceMs)) return { lines: [], result: false };
        return { lines: [{ t: 'msg', id: newId('m-'), task: task.id, kind: 'stopped', text, at: Date.now() }], result: true };
      });
      if (wrote) log.info(`worker ${task.id} (${task.name}) stopped without reporting: told ${task.coordinator.session}`);
    }
  }

  private async deliver(file: string, box: Mailbox, cards: readonly SessionCard[]): Promise<void> {
    const command = this.command();
    for (const reply of pendingReplies(box)) {
      const task = box.tasks.find((t) => t.id === reply.task);
      const card = task && cardOfSession(cards, task.server, task.session);
      if (!card || !(await this.idle(card))) continue;
      await this.change(file, async (now) => {
        if (now.delivered.has(reply.id)) return { lines: [], result: undefined };
        await this.boardSessions.typeInto(card, replyText(reply, command), { multiline: true });
        this.typed++;
        return { lines: [{ t: 'delivered', ids: [reply.id], at: Date.now() }], result: undefined };
      });
      log.info(`workers: typed the coordinator's answer into ${task.session}`);
    }
  }

  private async nudge(file: string, box: Mailbox, coordinator: SessionCard): Promise<void> {
    if (!nudgeBatch(box).length || !(await this.idle(coordinator))) return;
    const command = this.command();
    await this.change(file, async (now) => {
      const batch = nudgeBatch(now);
      if (!batch.length) return { lines: [], result: undefined };
      await this.boardSessions.typeInto(coordinator, nudgeText(batch.length, command));
      this.typed++;
      log.info(`workers: told ${coordinator.tmuxSession} about ${batch.length} worker message(s)`);
      return { lines: [{ t: 'nudged', ids: batch, at: Date.now() }], result: undefined };
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.hold.set(false);
    for (const d of this.subscriptions) d.dispose();
  }
}
