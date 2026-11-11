import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSessionCards,
  cardsInScope,
  featureForSession,
  type HookRecord,
  INTERRUPTED_DETAIL,
  isClaudeCommand,
  isInjectedPrompt,
  MOVED_DETAIL,
  NO_HOOKS_DETAIL,
  NOT_RUNNING_DETAIL,
  parseHookRecord,
  processAlive,
  readHookRecords,
  TranscriptEnds,
  splitRecords,
  transcriptEnd,
} from '../src/core/sessions';
import type { TmuxPane } from '../src/core/tmux';
import type { Feature } from '../src/core/worktrees';

const ROOT = '/w/orders';
const main: Feature = { name: 'main', dir: ROOT, isMain: true, packages: [] };
const feat: Feature = { name: 'af2-dp-alarms', dir: `${ROOT}/worktrees/af2-dp-alarms`, isMain: false, packages: [] };
const features = [main, feat];

const rec = (over: Partial<HookRecord>): HookRecord => ({
  sessionId: 's1',
  pid: 100,
  tmuxSession: 'cc-af2-dp-alarms',
  tmuxPane: '%1',
  cwd: feat.dir,
  event: 'PreToolUse',
  state: 'working',
  detail: 'Running Bash',
  updatedAt: 1000,
  ...over,
});
const pane = (session: string, paneId: string, command = 'claude', attached = false): TmuxPane => ({ session, paneId, command, attached });
const LIVE = new Set([100, 200, 300, 400]);
const alive = (pid: number) => LIVE.has(pid);

describe('parseHookRecord', () => {
  it('accepts a valid record', () => {
    expect(parseHookRecord(JSON.stringify(rec({ prompt: 'fix it', transcriptPath: '/t.jsonl' })))).toEqual(
      rec({ prompt: 'fix it', transcriptPath: '/t.jsonl' }),
    );
    expect(parseHookRecord(JSON.stringify(rec({ tmuxSession: null, tmuxPane: null })))).toEqual(
      (({ tmuxPane, ...r }) => r)(rec({ tmuxSession: null })),
    );
  });
  it('accepts records from older hook scripts and the done state', () => {
    const { pid, tmuxPane, ...old } = rec({ state: 'done' });
    expect(parseHookRecord(JSON.stringify(old))).toEqual(old);
  });
  it('keeps asksQuestion only when it is true', () => {
    expect(parseHookRecord(JSON.stringify(rec({ state: 'done', asksQuestion: true })))?.asksQuestion).toBe(true);
    expect(parseHookRecord(JSON.stringify({ ...rec({ state: 'done' }), asksQuestion: false }))).not.toHaveProperty('asksQuestion');
    expect(parseHookRecord(JSON.stringify({ ...rec({}), asksQuestion: null }))).not.toHaveProperty('asksQuestion');
  });
  it("keeps when the session's Claude process started it, and puts it on the card", () => {
    expect(parseHookRecord(JSON.stringify({ ...rec({}), sessionStartedAt: 900 }))?.sessionStartedAt).toBe(900);
    expect(parseHookRecord(JSON.stringify({ ...rec({}), sessionStartedAt: null }))).not.toHaveProperty('sessionStartedAt');
    const [card] = buildSessionCards([pane('cc-af2-dp-alarms', '%1')], [rec({ sessionStartedAt: 900 })], features, alive);
    expect(card.sessionStartedAt).toBe(900);
  });
  it('keeps the subagent roster the hooks wrote, without its malformed or empty fields, and puts it on the card', () => {
    const subagents = { a1: { type: 'Explore', name: null, startedAt: 5, runningSince: 5, stoppedAt: null, idleAt: 9, resumed: false }, bad: 'x' };
    const parsed = parseHookRecord(JSON.stringify({ ...rec({}), subagents }));
    expect(parsed?.subagents).toEqual({ a1: { type: 'Explore', startedAt: 5, runningSince: 5, idleAt: 9 } });
    expect(parseHookRecord(JSON.stringify({ ...rec({}), subagents: null }))).not.toHaveProperty('subagents');
    expect(parseHookRecord(JSON.stringify({ ...rec({}), subagents: { bad: 1 } }))).not.toHaveProperty('subagents');
    const [card] = buildSessionCards([pane('cc-af2-dp-alarms', '%1')], [rec({ subagents: parsed?.subagents })], features, alive);
    expect(card.subagents).toEqual(parsed?.subagents);
  });
  it("lists one card after a /clear: the new session's record wins the Claude process", () => {
    const old = rec({ sessionId: 'old', state: 'waiting', updatedAt: 1000 });
    const cleared = rec({ sessionId: 'new', state: 'idle', detail: 'Ready', updatedAt: 2000 });
    const cards = buildSessionCards([pane('cc-af2-dp-alarms', '%1')], [old, cleared], features, alive);
    expect(cards.map((c) => [c.id, c.tmuxSession])).toEqual([['new', 'cc-af2-dp-alarms']]);
  });
  it('reads what a waiting record waits on, and ignores it otherwise', () => {
    const waiting = { ...rec({ state: 'waiting', detail: 'Asking: which?' }), wait: { kind: 'question', toolUseId: 'toolu_1' } };
    expect(parseHookRecord(JSON.stringify(waiting))?.waitKind).toBe('question');
    expect(parseHookRecord(JSON.stringify({ ...waiting, wait: { kind: 'other' } }))).not.toHaveProperty('waitKind');
    expect(parseHookRecord(JSON.stringify({ ...waiting, wait: null }))).not.toHaveProperty('waitKind');
    expect(parseHookRecord(JSON.stringify({ ...waiting, state: 'working' }))).not.toHaveProperty('waitKind');
  });
  it("reads a blocked record's error kind and how a turn ended, and ignores them otherwise", () => {
    const blocked = { ...rec({ state: 'blocked', detail: 'rate_limit: Too many requests' }), errorKind: 'rate_limit' };
    expect(parseHookRecord(JSON.stringify(blocked))?.errorKind).toBe('rate_limit');
    expect(parseHookRecord(JSON.stringify({ ...blocked, errorKind: null }))).not.toHaveProperty('errorKind');
    expect(parseHookRecord(JSON.stringify({ ...blocked, state: 'done' }))).not.toHaveProperty('errorKind');
    const ended = { ...rec({ state: 'done', detail: 'Interrupted' }), endKind: 'interrupted' };
    expect(parseHookRecord(JSON.stringify(ended))?.endKind).toBe('interrupted');
    expect(parseHookRecord(JSON.stringify({ ...ended, endKind: 'other' }))).not.toHaveProperty('endKind');
  });
  it('rejects broken or incomplete records', () => {
    expect(parseHookRecord('{"sessionId":')).toBeUndefined();
    expect(parseHookRecord('null')).toBeUndefined();
    expect(parseHookRecord(JSON.stringify({ ...rec({}), state: 'thinking' }))).toBeUndefined();
    expect(parseHookRecord(JSON.stringify({ ...rec({}), updatedAt: 'now' }))).toBeUndefined();
    expect(parseHookRecord(JSON.stringify({ ...rec({}), sessionId: '' }))).toBeUndefined();
    expect(parseHookRecord(JSON.stringify({ ...rec({}), tmuxPane: 3 }))).toBeUndefined();
    expect(parseHookRecord(JSON.stringify({ ...rec({}), pid: 'x' }))?.pid).toBeUndefined();
  });
});

describe('readHookRecords', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });
  it('reads valid .json files and skips the rest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-state-'));
    await writeFile(join(dir, 's1.json'), JSON.stringify(rec({})));
    await writeFile(join(dir, 's2.json'), '{"half": ');
    await writeFile(join(dir, 'tmpabc.tmp'), JSON.stringify(rec({ sessionId: 's3' })));
    expect(await readHookRecords(dir)).toEqual([rec({})]);
  });
  it('returns nothing for a missing directory', async () => {
    expect(await readHookRecords(join(tmpdir(), 'devdesk-no-such-dir'))).toEqual([]);
  });
  it('corrects records whose transcript was backgrounded or interrupted', async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-state-'));
    const moved = join(dir, 'moved.jsonl');
    const stopped = join(dir, 'stopped.jsonl');
    await writeFile(moved, `${line({ type: 'assistant', message: { content: [] } })}\n${line({ type: 'continued-in', continuedInSessionId: 'x' })}\n`);
    await writeFile(stopped, `${line(interrupt)}\n`);
    // A Notification fired after backgrounding is newer than the transcript; the move still wins.
    await writeFile(join(dir, 's1.json'), JSON.stringify(rec({ transcriptPath: moved, state: 'waiting', updatedAt: Date.now() + 60_000 })));
    await writeFile(join(dir, 's2.json'), JSON.stringify(rec({ sessionId: 's2', transcriptPath: stopped, updatedAt: 1000 })));
    // A prompt submitted after the interrupt (record newer than the transcript) is not hidden.
    await writeFile(join(dir, 's3.json'), JSON.stringify(rec({ sessionId: 's3', transcriptPath: stopped, updatedAt: Date.now() + 60_000 })));
    // A finished reply keeps showing; a missing transcript changes nothing.
    await writeFile(join(dir, 's4.json'), JSON.stringify(rec({ sessionId: 's4', transcriptPath: stopped, state: 'done', detail: 'Fixed', updatedAt: 1000 })));
    await writeFile(join(dir, 's5.json'), JSON.stringify(rec({ sessionId: 's5', transcriptPath: join(dir, 'gone.jsonl'), state: 'waiting' })));
    const byId = Object.fromEntries((await readHookRecords(dir)).map((r) => [r.sessionId, r]));
    expect(byId.s1).toMatchObject({ state: 'idle', detail: MOVED_DETAIL, endKind: 'moved' });
    expect(byId.s1).not.toHaveProperty('waitKind');
    expect(byId.s2).toMatchObject({ state: 'done', detail: INTERRUPTED_DETAIL, endKind: 'interrupted' });
    expect(byId.s3).toMatchObject({ state: 'working', detail: 'Running Bash' });
    expect(byId.s3).not.toHaveProperty('endKind');
    expect(byId.s4).toMatchObject({ state: 'done', detail: 'Fixed' });
    expect(byId.s5).toMatchObject({ state: 'waiting', detail: 'Running Bash' });
  });
  it('with a kept TranscriptEnds, reads a transcript again only once it changed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-state-'));
    const transcript = join(dir, 't.jsonl');
    await writeFile(transcript, `${line(interrupt)}\n`);
    await writeFile(join(dir, 's1.json'), JSON.stringify(rec({ transcriptPath: transcript, updatedAt: 1000 })));
    const ends = new TranscriptEnds();
    expect((await readHookRecords(dir, ends))[0]).toMatchObject({ state: 'done', detail: INTERRUPTED_DETAIL });
    expect((await readHookRecords(dir, ends))[0]).toMatchObject({ state: 'done', detail: INTERRUPTED_DETAIL });
    await appendFile(transcript, `${line({ type: 'assistant', message: { content: [] } })}\n`);
    expect((await readHookRecords(dir, ends))[0]).toMatchObject({ state: 'working', detail: 'Running Bash' });
  });
});

const line = (v: unknown) => JSON.stringify(v);
const interrupt = { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };

describe('transcriptEnd', () => {
  const text = (...entries: unknown[]) => entries.map(line).join('\n');
  it('sees a backgrounded conversation', () => {
    expect(transcriptEnd(text({ type: 'user', message: { content: 'hi' } }, { type: 'continued-in' }))).toBe('moved');
  });
  it('sees an interrupt, skipping bookkeeping entries and a cut first line', () => {
    expect(transcriptEnd(`{"type":"assi\n${text(interrupt, { type: 'system' }, { type: 'file-history-snapshot' })}\n`)).toBe('interrupted');
    expect(transcriptEnd(text({ type: 'user', message: { content: '[Request interrupted by user]' } }))).toBe('interrupted');
  });
  it('ignores normal endings and subagent entries', () => {
    expect(transcriptEnd(text(interrupt, { type: 'assistant', message: { content: [] } }))).toBeUndefined();
    expect(transcriptEnd(text({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }))).toBeUndefined();
    expect(transcriptEnd(text({ type: 'assistant', message: { content: [] } }, { ...interrupt, isSidechain: true }))).toBeUndefined();
    expect(transcriptEnd('')).toBeUndefined();
  });
});

describe('processAlive', () => {
  it('sees this process and not an unused pid', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('isClaudeCommand', () => {
  it('matches claude and the native build version name', () => {
    expect(isClaudeCommand('claude')).toBe(true);
    expect(isClaudeCommand('2.1.3')).toBe(true);
    expect(isClaudeCommand('node')).toBe(false);
  });
});

describe('splitRecords', () => {
  it('separates dead sessions and keeps the newest record per Claude process', () => {
    const { live, dead } = splitRecords(
      [rec({ sessionId: 'a', updatedAt: 1 }), rec({ sessionId: 'b', updatedAt: 2 }), rec({ sessionId: 'gone', pid: 999 })],
      [],
      alive,
    );
    expect(live.map((r) => r.sessionId)).toEqual(['b']);
    expect(dead.map((r) => r.sessionId)).toEqual(['gone']);
  });
  it('keeps old records without a pid only while their tmux session runs a program', () => {
    const old = rec({ pid: undefined, tmuxPane: undefined });
    expect(splitRecords([old], [pane('cc-af2-dp-alarms', '%1')], alive).live).toEqual([old]);
    expect(splitRecords([old], [pane('cc-af2-dp-alarms', '%1', '-zsh')], alive)).toEqual({ live: [], dead: [] });
    expect(splitRecords([{ ...old, tmuxSession: null }], [], alive)).toEqual({ live: [], dead: [] });
  });
});

describe('buildSessionCards', () => {
  it('gives a numbered session (+ New session) the worktree of the feature it was started for', () => {
    const cards = buildSessionCards([pane('cc-af2-dp-alarms-2', '%4'), pane('cc-main-3', '%5', 'zsh')], [], features, alive);
    expect(cards.map((c) => [c.tmuxSession, c.featureName])).toEqual([
      ['cc-af2-dp-alarms-2', 'af2-dp-alarms'],
      ['cc-main-3', 'main'],
    ]);
  });
  it('makes a card per live Claude session with its worktree and tmux pane', () => {
    const cards = buildSessionCards([pane('cc-af2-dp-alarms', '%1')], [rec({ prompt: 'fix alarms', transcriptPath: '/t.jsonl' })], features, alive);
    expect(cards).toEqual([
      {
        id: 's1',
        sessionId: 's1',
        pid: 100,
        tmuxSession: 'cc-af2-dp-alarms',
        tmuxPane: '%1',
        tmuxServer: 'default',
        featureName: 'af2-dp-alarms',
        featureDir: feat.dir,
        cwd: feat.dir,
        transcriptPath: '/t.jsonl',
        state: 'working',
        detail: 'Running Bash',
        prompt: 'fix alarms',
        updatedAt: 1000,
        attached: false,
      },
    ]);
  });

  it('includes sessions outside tmux, matched to a worktree (or main) by cwd', () => {
    const cards = buildSessionCards(
      [],
      [
        rec({ sessionId: 'vs', pid: 200, tmuxSession: null, tmuxPane: null, cwd: `${feat.dir}/src/AWSOrdersCDK`, state: 'waiting' }),
        rec({ sessionId: 'root', pid: 300, tmuxSession: null, tmuxPane: null, cwd: `${ROOT}/src/X`, state: 'done' }),
        rec({ sessionId: 'else', pid: 400, tmuxSession: null, tmuxPane: null, cwd: '/tmp/x', state: 'idle' }),
      ],
      features,
      alive,
    );
    expect(cards.map((c) => [c.id, c.state, c.featureName, c.tmuxPane])).toEqual([
      ['vs', 'waiting', 'af2-dp-alarms', undefined],
      ['root', 'done', 'main', undefined],
      ['else', 'idle', undefined, undefined],
    ]);
  });

  it('gives two Claudes in panes of the same tmux session their own cards', () => {
    const cards = buildSessionCards(
      [pane('orders', '%3'), pane('orders', '%4')],
      [rec({ sessionId: 'x', pid: 100, tmuxSession: 'orders', tmuxPane: '%3' }), rec({ sessionId: 'y', pid: 200, tmuxSession: 'orders', tmuxPane: '%4' })],
      features,
      alive,
    );
    expect(cards.map((c) => [c.id, c.tmuxPane])).toEqual([
      ['x', '%3'],
      ['y', '%4'],
    ]);
  });

  it('drops dead sessions, shows hook-less Claude panes and stopped DevDesk sessions', () => {
    const cards = buildSessionCards(
      [pane('cc-af2-dp-alarms', '%1', '-zsh'), pane('orders-1', '%5', '2.1.3'), pane('commandline', '%6', 'zsh'), pane('cc-main', '%7', 'vim')],
      [rec({ pid: 999 })],
      features,
      alive,
    );
    expect(cards.map((c) => [c.id, c.state, c.featureName, c.detail])).toEqual([
      ['tmux:default:%5', 'unknown', undefined, NO_HOOKS_DETAIL],
      ['tmux:default:cc-main', 'unknown', 'main', NO_HOOKS_DETAIL],
      ['tmux:default:cc-af2-dp-alarms', 'stopped', 'af2-dp-alarms', NOT_RUNNING_DETAIL],
    ]);
    // A hook-less pane's Claude process (found in the process tree), so Claude's registry names it and its start time.
    expect(buildSessionCards([{ ...pane('orders-1', '%5', 'zsh'), claude: true, claudePid: 4242 }], [], features, alive)[0].pid).toBe(4242);
    // Its Claude died mid-turn (a record without SessionEnd): crashed.
    expect(cards[2].crashed).toBe(true);
  });

  it('does not mark a stopped session crashed when Claude died at the prompt', () => {
    const cards = buildSessionCards([pane('cc-af2-dp-alarms', '%1', '-zsh')], [rec({ pid: 999, state: 'done' })], features, alive);
    expect(cards.map((c) => [c.state, c.crashed])).toEqual([['stopped', undefined]]);
  });

  it('matches hook-less panes to a worktree by their directory', () => {
    const cards = buildSessionCards([{ ...pane('scratch', '%3'), cwd: `${feat.dir}/src/P` }, { ...pane('scratch', '%4'), cwd: '/tmp' }], [], features, alive);
    expect(cards.map((c) => [c.id, c.featureName, c.cwd])).toEqual([
      ['tmux:default:%3', 'af2-dp-alarms', `${feat.dir}/src/P`],
      ['tmux:default:%4', undefined, '/tmp'],
    ]);
  });

  it('trusts the process tree over tmux command names when the caller provides it', () => {
    const cards = buildSessionCards(
      [
        { ...pane('cc-feat', '%1', 'zsh'), claude: true }, // `claude; exec $SHELL`: tmux reports the wrapper shell
        { ...pane('cc-main', '%2', '-zsh'), claude: false },
      ],
      [],
      features,
      alive,
    );
    expect(cards.map((c) => [c.id, c.state])).toEqual([
      ['tmux:default:%1', 'unknown'],
      ['tmux:default:cc-main', 'stopped'],
    ]);
  });

  it('keeps panes on different tmux servers apart and can list one server only', () => {
    const panes = [{ ...pane('cc-x', '%1'), server: 'devdesk' }, pane('orders', '%1'), { ...pane('cc-y', '%2', 'zsh'), server: 'devdesk' }];
    const records = [
      rec({ sessionId: 'mine', pid: 100, tmuxSession: 'cc-x', tmuxPane: '%1', tmuxServer: 'devdesk' }),
      rec({ sessionId: 'yours', pid: 200, tmuxSession: 'orders', tmuxPane: '%1' }),
      rec({ sessionId: 'ide', pid: 300, tmuxSession: null, tmuxPane: null }),
    ];
    const all = buildSessionCards(panes, records, features, alive);
    expect(all.map((c) => [c.id, c.tmuxServer, c.tmuxSession])).toEqual([
      ['ide', undefined, undefined],
      ['mine', 'devdesk', 'cc-x'],
      ['yours', 'default', 'orders'],
      ['tmux:devdesk:cc-y', 'devdesk', 'cc-y'],
    ]);
    expect(buildSessionCards(panes, records, features, alive, 'devdesk').map((c) => c.id)).toEqual(['mine', 'tmux:devdesk:cc-y']);
  });

  it('lists a /fork of a listed session (it runs outside tmux, as a background job), and forks of that fork', () => {
    const records = [
      rec({ sessionId: 'mine', pid: 100, tmuxSession: 'cc-x', tmuxPane: '%1', tmuxServer: 'devdesk' }),
      rec({ sessionId: 'fork', pid: 200, tmuxSession: null, tmuxPane: null }),
      rec({ sessionId: 'fork-of-fork', pid: 300, tmuxSession: null, tmuxPane: null }),
      rec({ sessionId: 'ide', pid: 400, tmuxSession: null, tmuxPane: null }),
      rec({ sessionId: 'ide-fork', pid: 500, tmuxSession: null, tmuxPane: null }),
    ];
    const forkParents = new Map([
      ['fork-of-fork', 'fork'],
      ['fork', 'mine'],
      ['ide-fork', 'ide'],
    ]);
    const cards = buildSessionCards([{ ...pane('cc-x', '%1'), server: 'devdesk' }], records, features, alive, 'devdesk', forkParents);
    expect(cards.map((c) => c.id).sort()).toEqual(['fork', 'fork-of-fork', 'mine']);
    expect(cards.find((c) => c.id === 'fork')).toMatchObject({ sessionId: 'fork', tmuxSession: undefined, cwd: feat.dir, featureName: feat.name });
  });

  it('orders needs input, working, done, ready, unknown, stopped, then newest first', () => {
    const r = (sessionId: string, pid: number, state: HookRecord['state'], updatedAt: number) =>
      rec({ sessionId, pid, state, updatedAt, tmuxSession: null, tmuxPane: null });
    const cards = buildSessionCards(
      [pane('cc-x', '%9', 'bash')],
      [r('a', 100, 'idle', 1), r('b', 200, 'working', 2), r('c', 300, 'waiting', 3), r('d', 400, 'done', 4)],
      features,
      alive,
    );
    expect(cards.map((c) => c.id)).toEqual(['c', 'b', 'd', 'a', 'tmux:default:cc-x']);
  });
});

describe('worktree of a session', () => {
  it('follows the cwd, or the last edited file when Claude builds in a worktree from main', () => {
    expect(featureForSession(features, `${ROOT}/src/Pkg`)?.name).toBe('main');
    expect(featureForSession(features, `${ROOT}/src/Pkg`, `${feat.dir}/src/Pkg/a.ts`)?.name).toBe(feat.name);
    expect(featureForSession(features, '/home/u/scratch', `${feat.dir}/src/Pkg/a.ts`)?.name).toBe(feat.name);
    // In a worktree, the cwd wins over an edit elsewhere; an edit in main does not move a session.
    expect(featureForSession(features, feat.dir, `${ROOT}/src/Pkg/a.ts`)?.name).toBe(feat.name);
    expect(featureForSession(features, '/home/u/scratch', `${ROOT}/src/a.ts`)).toBeUndefined();
  });

  it('matches a cwd reported with symlinks resolved', () => {
    const linked = [{ ...main, dir: '/var/w', realDir: '/private/var/w' }, { ...feat, dir: '/var/w/worktrees/f', realDir: '/private/var/w/worktrees/f' }];
    expect(featureForSession(linked, '/private/var/w/src/Pkg')?.name).toBe('main');
    expect(featureForSession(linked, '/private/var/w/worktrees/f/src')?.name).toBe(feat.name);
    expect(featureForSession(linked, '/var/w/worktrees/f')?.name).toBe(feat.name);
  });

  it('labels a card with the worktree Claude moved into or edits in', () => {
    const panes = [pane('cc-main', '%1')];
    const moved = buildSessionCards(panes, [rec({ tmuxSession: 'cc-main', cwd: `${feat.dir}/src/Pkg` })], features, alive);
    expect(moved[0]).toMatchObject({ featureName: feat.name, featureDir: feat.dir });
    const editing = buildSessionCards(panes, [rec({ tmuxSession: 'cc-main', cwd: ROOT, lastEditPath: `${feat.dir}/src/Pkg/a.ts` })], features, alive);
    expect(editing[0].featureName).toBe(feat.name);
  });

  it('parses lastEditPath and the blocked state', () => {
    expect(parseHookRecord(JSON.stringify({ ...rec({ state: 'blocked' }), lastEditPath: '/w/a.ts' }))).toMatchObject({
      state: 'blocked',
      lastEditPath: '/w/a.ts',
    });
    expect(parseHookRecord(JSON.stringify({ ...rec({}), lastEditPath: 3 }))).toBeUndefined();
  });
});

describe('injected prompts', () => {
  it('tells prompts Claude Code submitted itself from the user\'s', () => {
    expect(isInjectedPrompt('<task-notification>\n<task-id>b1</task-id>')).toBe(true);
    expect(isInjectedPrompt('  <system-reminder>x</system-reminder>')).toBe(true);
    // A subagent's hand-back or another session's message, as the hook sees it and as the transcript records it.
    expect(isInjectedPrompt('<agent-message from="a31e9ca86c2d6cd55">\n[Subagent hand-back] The text below')).toBe(true);
    expect(isInjectedPrompt('Another Claude session sent a message:\n<agent-message from="abb8">\nhi')).toBe(true);
    expect(isInjectedPrompt('what does <agent-message> mean?')).toBe(false);
    expect(isInjectedPrompt('why does <task-id> show in the title?')).toBe(false);
    expect(isInjectedPrompt('fix the DNS test')).toBe(false);
  });

  it('drops an injected prompt from a saved record, so it is never the title', () => {
    const rec = { sessionId: 's', tmuxSession: null, cwd: '/w', event: 'UserPromptSubmit', state: 'working', detail: 'Thinking', updatedAt: 1 };
    expect(parseHookRecord(JSON.stringify({ ...rec, prompt: '<task-notification><task-id>b1</task-id>' }))?.prompt).toBeUndefined();
    expect(parseHookRecord(JSON.stringify({ ...rec, prompt: 'fix it' }))?.prompt).toBe('fix it');
  });
});

describe('cardsInScope', () => {
  const alive = () => true;
  const linked: Feature = { name: 'linked', dir: '/repos/orders-linked', isMain: false, packages: [] };
  const records = [
    rec({ sessionId: 'wt', pid: 1, tmuxSession: null, tmuxPane: null, cwd: `${feat.dir}/src/P` }),
    rec({ sessionId: 'root', pid: 2, tmuxSession: null, tmuxPane: null, cwd: `${ROOT}/src/X` }),
    rec({ sessionId: 'linked', pid: 3, tmuxSession: null, tmuxPane: null, cwd: `${linked.dir}/src` }),
    rec({ sessionId: 'other', pid: 4, tmuxSession: null, tmuxPane: null, cwd: '/Users/me/MacExplorer' }),
    rec({ sessionId: 'sibling', pid: 5, tmuxSession: null, tmuxPane: null, cwd: `${ROOT}-2/src` }),
    rec({ sessionId: 'edits', pid: 6, tmuxSession: null, tmuxPane: null, cwd: '/elsewhere', lastEditPath: `${feat.dir}/README.md` }),
  ];
  const fs = [...features, linked];
  const ids = (dirs: string[], fts: Feature[] = fs) => cardsInScope(buildSessionCards([], records, fts, alive), dirs, fts).map((c) => c.id).sort();

  it('keeps sessions working in the workspace or one of its worktrees, wherever the worktree lives', () => {
    expect(ids([ROOT])).toEqual(['linked', 'root', 'wt']);
  });

  it('matches a plain folder by cwd, with or without a trailing slash, and its resolved path', () => {
    expect(ids(['/Users/me/MacExplorer/'], [])).toEqual(['other']);
    expect(ids(['/link', '/Users/me/MacExplorer'], [])).toEqual(['other']);
  });

  it('keeps every session when no folder is open', () => {
    expect(ids([], [])).toHaveLength(6);
  });

  it("drops another workspace's cc-main sessions: a tmux name places only a card without a cwd", () => {
    const other: Feature = { name: 'main', dir: '/Users/me/MacExplorer', isMain: true, packages: [] };
    const panes = [{ ...pane('cc-main-7', '%7'), cwd: ROOT }, pane('cc-main-8', '%8')];
    const cards = buildSessionCards(panes, [], [other], alive);
    expect(cards.map((c) => c.featureName)).toEqual(['main', 'main']);
    expect(cardsInScope(cards, [other.dir], [other]).map((c) => c.tmuxPane)).toEqual(['%8']);
    expect(cardsInScope([{ id: 'x', state: 'unknown', detail: '', attached: false }], [ROOT], features)).toEqual([]);
  });
});
