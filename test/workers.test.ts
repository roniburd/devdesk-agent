import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBoard } from '../src/core/board';
import type { SessionCard } from '../src/core/sessions';
import {
  cardsWithWorkers,
  checkText,
  isMailboxFileName,
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
  teamText,
  workerActive,
  workerAllowArgs,
  workerPrompt,
  workerStatus,
  workerStopped,
} from '../src/core/workers';

const card = (over: Partial<SessionCard>): SessionCard => ({ id: 'x', state: 'idle', detail: '', attached: false, ...over });
const coordinator = { server: 'devdesk', session: 'cc-main' };
const task = (id: string, over: Record<string, unknown> = {}): MailboxLine =>
  ({ t: 'task', id, name: `n${id}`, task: `do ${id}`, coordinator, where: 'new', at: 100, ...over }) as MailboxLine;
const started = (id: string, session: string, at = 200): MailboxLine => ({ t: 'started', task: id, session, server: 'devdesk', dir: `/w/${session}`, worktree: session, at });
const box = (...lines: MailboxLine[]): Mailbox => parseMailbox(lines.map(mailboxLine).join(''));

describe('the mailbox', () => {
  it('adds up its lines, skipping those it cannot read', () => {
    const text = [
      mailboxLine(task('w-000001')),
      'garbage\n',
      mailboxLine(task('w-000001', { name: 'again' })),
      mailboxLine(task('bad-id')),
      mailboxLine(started('w-000001', 'cc-a')),
      mailboxLine({ t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'done', outcome: 'succeeded', text: 'ok', at: 300 }),
      JSON.stringify({ t: 'msg', id: 'm-2222', task: 'w-000001', kind: 'nope', text: 'x', at: 1 }) + '\n',
      mailboxLine({ t: 'read', ids: ['m-1111'], at: 400 }),
      mailboxLine({ t: 'reply', id: 'r-1111', task: 'w-000001', text: 'yes', at: 500 }),
      mailboxLine({ t: 'delivered', ids: ['r-1111'], at: 600 }),
    ].join('');
    const b = parseMailbox(text);
    expect(b.coordinator).toEqual(coordinator);
    expect(b.tasks).toEqual([{ id: 'w-000001', name: 'nw-000001', task: 'do w-000001', coordinator, where: 'new', at: 100, session: 'cc-a', server: 'devdesk', dir: '/w/cc-a', worktree: 'cc-a', startedAt: 200 }]);
    expect(b.messages.map((m) => m.id)).toEqual(['m-1111']);
    expect([...b.read]).toEqual(['m-1111']);
    expect(pendingReplies(b)).toEqual([]);
    expect(b.delivered.get('r-1111')).toBe(600);
  });

  it('is named after its coordinator, unambiguously', () => {
    expect(mailboxFileName({ server: 'devdesk', session: 'cc-main-2' })).toBe('devdesk~cc-main-2.jsonl');
    expect(mailboxFileName({ server: 'a b', session: 'x/y' })).toBe('a_b~x_y.jsonl');
    expect(isMailboxFileName('devdesk~cc-main.jsonl')).toBe(true);
    expect(isMailboxFileName('devdesk-cc-main.jsonl')).toBe(false);
  });

  it('is read from its directory, and finds a task and the task of a card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-workers-'));
    try {
      writeFileSync(join(dir, 'devdesk~cc-main.jsonl'), mailboxLine(task('w-000001')) + mailboxLine(started('w-000001', 'cc-a')));
      writeFileSync(join(dir, 'other.txt'), 'x');
      const boxes = await readMailboxes(dir);
      expect([...boxes.keys()]).toEqual(['devdesk~cc-main.jsonl']);
      expect(mailboxOfTask(boxes, 'w-000001')?.file).toBe('devdesk~cc-main.jsonl');
      expect(mailboxOfTask(boxes, 'w-999999')).toBeUndefined();
      expect(taskOfCard(boxes, { tmuxSession: 'cc-a', tmuxServer: 'devdesk' })?.id).toBe('w-000001');
      expect(taskOfCard(boxes, { tmuxSession: 'cc-a', tmuxServer: 'other' })).toBeUndefined();
      expect((await readMailboxes(join(dir, 'missing'))).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a worker', () => {
  const b = box(task('w-000001'), started('w-000001', 'cc-a'));
  const t = b.tasks[0];
  it('stands as its report says, else as its card does', () => {
    expect(workerStatus(box(task('w-000001')).tasks[0], b, undefined)).toBe('starting');
    expect(workerStatus(t, b, undefined)).toBe('ended');
    expect(workerStatus(t, b, card({ state: 'working' }))).toBe('working');
    expect(workerStatus(t, b, card({ state: 'waiting' }))).toBe('waiting');
    expect(workerStatus(t, b, card({ state: 'done' }))).toBe('idle');
    expect(workerStatus(t, b, card({ state: 'stopped' }))).toBe('ended');
    const reported = box(task('w-000001'), started('w-000001', 'cc-a'), { t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'done', outcome: 'failed', text: 'no', at: 300 });
    expect(workerStatus(t, reported, card({ state: 'working' }))).toBe('failed');
    const noStart = box(task('w-000001'), { t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'failed', text: 'no git', at: 300 });
    expect(workerStatus(t, noStart, undefined)).toBe('failed');
    expect(['starting', 'working', 'waiting', 'idle'].every((s) => workerActive(s as never))).toBe(true);
    expect(['ended', 'succeeded', 'failed'].some((s) => workerActive(s as never))).toBe(false);
    expect([workerStopped(undefined), workerStopped(card({ state: 'done' })), workerStopped(card({ state: 'working' }))]).toEqual([true, true, false]);
  });

  it('starts with its task, then the commands it reports with', () => {
    const prompt = workerPrompt({ id: 'w-abcdef', name: 'lint', task: '  Fix the lint errors in src/\n', coordinator: 'cc-main', command: '/h/.claude/devdesk/devdesk' });
    expect(prompt.startsWith('Fix the lint errors in src/\n\n---\nYou are a worker session ("lint", task w-abcdef)')).toBe(true);
    expect(prompt).toContain('/h/.claude/devdesk/devdesk worker done --task w-abcdef --outcome succeeded --summary');
    expect(prompt).toContain('/h/.claude/devdesk/devdesk worker ask --task w-abcdef "<your question>"');
    expect(workerPrompt({ id: 'w-abcdef', name: 'x', task: 't', coordinator: 'c', command: '/My Home/devdesk' })).toContain(`'/My Home/devdesk' worker done`);
    expect(workerAllowArgs('/h/devdesk')).toBe(`--allowedTools 'Bash(/h/devdesk worker:*)'`);
  });

  it('that stopped without reporting is escalated once per wake, after the grace period', () => {
    const grace = 60_000;
    expect(needsEscalation(t, b, undefined, 1_000_000, grace)).toBe(false);
    expect(needsEscalation(t, b, 990_000, 1_000_000, grace)).toBe(false);
    expect(needsEscalation(t, b, 900_000, 1_000_000, grace)).toBe(true);
    expect(needsEscalation(t, b, 150, 1_000_000, grace), 'stopped before it started').toBe(false);
    const asked = box(task('w-000001'), started('w-000001', 'cc-a'), { t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'ask', text: '?', at: 500 });
    expect(needsEscalation(asked.tasks[0], asked, 900_000, 1_000_000, grace)).toBe(false);
    const escalated = box(task('w-000001'), started('w-000001', 'cc-a'), { t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'stopped', text: '', at: 500 });
    expect(needsEscalation(escalated.tasks[0], escalated, 900_000, 1_000_000, grace)).toBe(false);
    // An answer typed in wakes it: stopping again after that is escalated again.
    const woken = box(
      task('w-000001'),
      started('w-000001', 'cc-a'),
      { t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'ask', text: '?', at: 500 },
      { t: 'reply', id: 'r-1111', task: 'w-000001', text: 'yes', at: 600 },
      { t: 'delivered', ids: ['r-1111'], at: 700 },
    );
    expect(needsEscalation(woken.tasks[0], woken, 900_000, 1_000_000, grace)).toBe(true);
    expect(needsEscalation(woken.tasks[0], woken, 650, 1_000_000, grace), 'its stop from before the answer').toBe(false);
    const done = box(task('w-000001'), started('w-000001', 'cc-a'), { t: 'msg', id: 'm-1111', task: 'w-000001', kind: 'done', outcome: 'succeeded', text: 'ok', at: 500 });
    expect(needsEscalation(done.tasks[0], done, 900_000, 1_000_000, grace)).toBe(false);
  });
});

describe('the coordinator', () => {
  const msg = (id: string, kind: 'done' | 'ask' | 'stopped' | 'failed', text: string, at = 1000): MailboxLine => ({ t: 'msg', id, task: 'w-000001', kind, text, at, ...(kind === 'done' ? { outcome: 'succeeded' } : {}) });

  it('is told once per batch of unread messages', () => {
    expect(nudgeBatch(box(task('w-000001')))).toEqual([]);
    const one = box(task('w-000001'), msg('m-1111', 'done', 'ok'));
    expect(nudgeBatch(one)).toEqual(['m-1111']);
    const told = box(task('w-000001'), msg('m-1111', 'done', 'ok'), { t: 'nudged', ids: ['m-1111'], at: 2 });
    expect(nudgeBatch(told)).toEqual([]);
    const more = box(task('w-000001'), msg('m-1111', 'done', 'ok'), { t: 'nudged', ids: ['m-1111'], at: 2 }, msg('m-2222', 'ask', '?'));
    expect(nudgeBatch(more)).toEqual(['m-1111', 'm-2222']);
    const read = box(task('w-000001'), msg('m-1111', 'done', 'ok'), { t: 'read', ids: ['m-1111'], at: 2 });
    expect(nudgeBatch(read)).toEqual([]);
    expect(nudgeText(1, '/h/devdesk')).toBe('You have 1 worker message. Run `/h/devdesk worker check`.');
    expect(nudgeText(3, '/h/devdesk')).toBe('You have 3 worker messages. Run `/h/devdesk worker check`.');
  });

  it('reads each kind of message, with how to answer', () => {
    const b = box(task('w-000001'), msg('m-1111', 'done', 'all tests pass', 1000), msg('m-2222', 'ask', 'which branch?', 1000), msg('m-3333', 'stopped', 'turn ended', 1000), msg('m-4444', 'failed', 'no git', 1000));
    const text = checkText(b, b.messages, 'devdesk', 61_000);
    expect(text).toMatch(/^4 new worker messages:/);
    expect(text).toContain('[succeeded] nw-000001 (task w-000001, 1m ago): all tests pass');
    expect(text).toContain('[question] nw-000001 (task w-000001, 1m ago): which branch?\n  answer: devdesk worker reply --task w-000001 "<answer>"');
    expect(text).toContain('[stopped without reporting]');
    expect(text).toContain('[failed to start] nw-000001 (task w-000001, 1m ago): no git');
    expect(checkText(b, [], 'devdesk', 0)).toBe('No new worker messages.');
  });

  it('lists its workers, and the unread count', () => {
    const b = box(task('w-000001'), started('w-000001', 'cc-a'), task('w-000002'), msg('m-1111', 'ask', '?'));
    expect(listText(b, (t) => (t.id === 'w-000001' ? 'working' : 'starting'))).toBe(
      'w-000001  nw-000001  working  worktree cc-a  (tmux cc-a)\nw-000002  nw-000002  starting\n\n1 unread message: devdesk worker check',
    );
    expect(listText(undefined, () => 'working')).toMatch(/^No workers/);
  });

  it('types replies into its workers once', () => {
    const b = box(task('w-000001'), { t: 'reply', id: 'r-1111', task: 'w-000001', text: 'use main', at: 1 });
    expect(pendingReplies(b).map((r) => r.id)).toEqual(['r-1111']);
    expect(replyText(b.replies[0], 'devdesk')).toMatch(/^Your coordinator answers: use main\n\nContinue the task; .*devdesk worker done --task w-000001/);
  });
});

describe('the board', () => {
  it('links workers and their coordinator', () => {
    expect(teamText(['succeeded', 'working', 'starting'])).toBe('3 workers: 1 done, 2 working');
    expect(teamText(['failed'])).toBe('1 worker: 1 failed');
    const boxes = new Map([['devdesk~cc-main.jsonl', box(task('w-000001'), started('w-000001', 'cc-a'), task('w-000002', { name: 'docs' }), started('w-000002', 'cc-b'))]]);
    const cards = [
      card({ id: 'main', tmuxSession: 'cc-main', tmuxServer: 'devdesk', tmuxPane: '%1', state: 'idle', prompt: 'Split the work' }),
      card({ id: 'a', tmuxSession: 'cc-a', tmuxServer: 'devdesk', tmuxPane: '%2', state: 'working', prompt: 'Lint' }),
      card({ id: 'other', tmuxSession: 'cc-a', tmuxServer: 'default', tmuxPane: '%2', state: 'working' }),
    ];
    const out = cardsWithWorkers(cards, boxes);
    expect(out[0].team).toEqual({ workers: ['working', 'ended'] });
    expect(out[1].team?.workerOf).toEqual({ task: 'w-000001', name: 'nw-000001', coordinator, status: 'working' });
    expect(out[2].team).toBeUndefined();
    expect(cardsWithWorkers(cards, new Map())).toBe(cards);

    const board = buildBoard(out, [], { view: { now: 0, unread: new Set(), idleMs: 1, stuckMs: 1e9 } });
    const sessions = board.lanes.flatMap((l) => l.sessions);
    const coord = sessions.find((s) => s.id === 'main');
    const worker = sessions.find((s) => s.id === 'a');
    expect(coord?.team).toBe('2 workers: 1 working, 1 ended');
    expect(worker?.team).toMatch(/^worker "nw-000001" · working · of Split the work$/);
    expect(worker?.coordinatorId).toBe('main');
    expect(worker?.hoverParts.some((p) => p.label === 'Team')).toBe(true);
  });
});
