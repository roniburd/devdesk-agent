import { describe, expect, it } from 'vitest';
import { cardsWithProgramStatus, cardWithProgramStatus, type ProgramStatus } from '../src/core/programStatus';
import { MOVED_DETAIL, type HookRecord, type SessionCard } from '../src/core/sessions';
import { mergedCard, mergeReason, statusFromText } from '../src/core/statusMerge';
import { withRecord } from '../src/core/livePatches';

const MIN = 60_000;
const HOOK_AT = 1_000_000;
const QUIET = 2 * MIN;

const hooked = (over: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  sessionId: 's1',
  state: 'working',
  detail: 'Running Bash: npm test',
  attached: false,
  tmuxSession: 'cc-main',
  tmuxPane: '%4',
  tmuxServer: 'devdesk',
  updatedAt: HOOK_AT,
  prompt: 'Fix the tests',
  ...over,
});
const report = (over: Partial<ProgramStatus>): ProgramStatus => ({ state: 'working', at: HOOK_AT + 1000, pid: 1, ...over });
/** Options a few seconds after the report: well inside the quiet window. */
const soon = { now: HOOK_AT + 5000, quietMs: QUIET };
const quiet = { now: HOOK_AT + QUIET, quietMs: QUIET };

describe('mergeReason: a hook event newer than the report wins', () => {
  it('keeps the hook record when the report is older or as old, even once the hooks are quiet', () => {
    for (const at of [HOOK_AT - 1, HOOK_AT]) {
      expect(mergeReason(hooked(), report({ state: 'blocked', kind: 'permission', at }), soon)).toBeUndefined();
      expect(mergeReason(hooked(), report({ state: 'done', at }), { now: HOOK_AT + 60 * MIN, quietMs: QUIET })).toBeUndefined();
    }
  });

  it('keeps it when hook and report agree (done and idle and an error all end the turn)', () => {
    const agree: [SessionCard['state'], ProgramStatus['state']][] = [
      ['working', 'working'],
      ['waiting', 'blocked'],
      ['done', 'idle'],
      ['done', 'done'],
      ['done', 'error'],
      ['idle', 'done'],
      ['blocked', 'idle'],
      ['blocked', 'error'],
    ];
    for (const [state, reported] of agree) expect(mergeReason(hooked({ state }), report({ state: reported }), quiet), `${state}/${reported}`).toBeUndefined();
  });

  it('leaves cards without hook state, without a time, or moved to a background job', () => {
    for (const state of ['unknown', 'stopped', 'parked'] as const) expect(mergeReason(hooked({ state }), report({ state: 'blocked' }), quiet)).toBeUndefined();
    expect(mergeReason(hooked({ updatedAt: undefined }), report({ state: 'blocked' }), quiet)).toBeUndefined();
    expect(mergeReason(hooked({ state: 'done', detail: MOVED_DETAIL }), report({ state: 'blocked', kind: 'auth' }), quiet)).toBeUndefined();
  });
});

describe('mergeReason: ahead (at once)', () => {
  it('waits as soon as Claude reports blocked while the record says working', () => {
    for (const kind of ['permission', 'question', 'auth', undefined] as const) expect(mergeReason(hooked(), report({ state: 'blocked', kind }), soon)).toBe('ahead');
  });

  it('shows a sign-in Claude needs after the turn ended, which no hook reports', () => {
    for (const state of ['done', 'idle', 'blocked'] as const) expect(mergeReason(hooked({ state }), report({ state: 'blocked', kind: 'auth' }), soon)).toBe('ahead');
  });

  it('never reopens a finished turn for a permission or a question, quiet or not', () => {
    for (const kind of ['permission', 'question', undefined] as const) {
      expect(mergeReason(hooked({ state: 'done' }), report({ state: 'blocked', kind }), { now: HOOK_AT + 60 * MIN, quietMs: QUIET })).toBeUndefined();
    }
    expect(mergeReason(hooked({ state: 'done' }), report({ state: 'working' }), { now: HOOK_AT + 60 * MIN, quietMs: QUIET })).toBeUndefined();
  });

  it('never ends a hook wait at once', () => {
    for (const state of ['working', 'done', 'idle', 'error'] as const) expect(mergeReason(hooked({ state: 'waiting', waitKind: 'permission' }), report({ state }), soon)).toBeUndefined();
  });
});

describe('mergeReason: quiet hooks', () => {
  it('takes Claude’s state once the record has been unchanged for quietMs, not a millisecond before', () => {
    const waiting = hooked({ state: 'waiting', waitKind: 'permission', detail: 'Needs permission: Bash' });
    expect(mergeReason(waiting, report({ state: 'idle' }), { now: HOOK_AT + QUIET - 1, quietMs: QUIET })).toBeUndefined();
    expect(mergeReason(waiting, report({ state: 'idle' }), { now: HOOK_AT + QUIET, quietMs: QUIET })).toBe('quiet');
    expect(mergeReason(hooked(), report({ state: 'done' }), { now: HOOK_AT + QUIET - 1, quietMs: QUIET })).toBeUndefined();
    expect(mergeReason(hooked(), report({ state: 'done' }), quiet)).toBe('quiet');
  });

  it('counts from the hook event, not from the report', () => {
    // Hooks quiet for 10 minutes, Claude reported a second ago: the report is trusted now.
    expect(mergeReason(hooked(), report({ state: 'idle', at: HOOK_AT + 10 * MIN - 1000 }), { now: HOOK_AT + 10 * MIN, quietMs: QUIET })).toBe('quiet');
  });

  it('covers every state a working or waiting record can be stuck on', () => {
    for (const state of ['done', 'idle', 'error'] as const) expect(mergeReason(hooked(), report({ state }), quiet)).toBe('quiet');
    for (const state of ['working', 'done', 'idle', 'error'] as const) expect(mergeReason(hooked({ state: 'waiting' }), report({ state }), quiet)).toBe('quiet');
  });

  it('keeps a wait while a subagent reports blocked', () => {
    expect(mergeReason(hooked({ state: 'waiting' }), report({ state: 'working', blockedChildren: 1 }), quiet)).toBeUndefined();
    expect(mergeReason(hooked({ state: 'waiting' }), report({ state: 'idle', blockedChildren: 1 }), quiet)).toBe('quiet');
  });

  it('is off with quietMs 0', () => {
    expect(mergeReason(hooked(), report({ state: 'done' }), { now: HOOK_AT + 60 * MIN, quietMs: 0 })).toBeUndefined();
    expect(mergeReason(hooked(), report({ state: 'blocked' }), { now: HOOK_AT + 60 * MIN, quietMs: 0 })).toBe('ahead');
  });
});

describe('mergedCard', () => {
  it('shows a wait Claude reports ahead of the hooks with its message and kind', () => {
    const next = mergedCard(hooked({ liveStatus: 'Running the tests' }), report({ state: 'blocked', kind: 'permission', msg: 'approve Bash: rm -rf build' }), soon);
    expect(next).toMatchObject({
      state: 'waiting',
      detail: 'approve Bash: rm -rf build',
      waitKind: 'permission',
      updatedAt: HOOK_AT + 1000,
      prompt: 'Fix the tests',
      statusFrom: { reason: 'ahead', hookAt: HOOK_AT },
    });
    expect(next.liveStatus).toBeUndefined();
    expect(mergedCard(hooked(), report({ state: 'blocked', kind: 'question' }), soon)).toMatchObject({ waitKind: 'question', detail: 'Waiting for your answer' });
    const signIn = mergedCard(hooked({ state: 'done', asksQuestion: true }), report({ state: 'blocked', kind: 'auth' }), soon);
    expect(signIn).toMatchObject({ state: 'waiting', waitKind: 'elicitation', detail: 'Waiting for you to sign in' });
    expect(signIn).not.toHaveProperty('asksQuestion');
  });

  it('ends a stuck wait once the hooks are quiet, dropping what described it', () => {
    const waiting = hooked({ state: 'waiting', waitKind: 'permission', detail: 'Needs permission: Bash', askSummary: 'Run the tests?' });
    const next = mergedCard(waiting, report({ state: 'idle' }), quiet);
    expect(next).toMatchObject({ state: 'idle', detail: 'At the prompt', statusFrom: { reason: 'quiet', hookAt: HOOK_AT } });
    expect(next.waitKind).toBeUndefined();
    expect(next.askSummary).toBeUndefined();
  });

  it('returns the card itself when the hooks keep it', () => {
    const card = hooked();
    expect(mergedCard(card, report({ state: 'working' }), quiet)).toBe(card);
  });
});

describe('cardWithProgramStatus with merge options', () => {
  it('merges hooked cards only when given the options', () => {
    const card = hooked();
    expect(cardWithProgramStatus(card, report({ state: 'blocked' }))).toBe(card);
    expect(cardWithProgramStatus(card, report({ state: 'blocked' }), soon).state).toBe('waiting');
    const out = cardsWithProgramStatus([card], new Map([['devdesk-4.json', report({ state: 'blocked' })]]), soon);
    expect(out[0].statusFrom?.reason).toBe('ahead');
  });
});

describe('statusFromText', () => {
  it('says where the state came from', () => {
    expect(statusFromText(hooked(), HOOK_AT)).toBeUndefined();
    expect(statusFromText(hooked({ statusFrom: { reason: 'ahead', hookAt: HOOK_AT } }), HOOK_AT)).toMatch(/^Status from Claude/);
    expect(statusFromText(hooked({ statusFrom: { reason: 'quiet', hookAt: HOOK_AT } }), HOOK_AT + 5 * MIN)).toBe('Status from Claude, hooks quiet (no hook event for 5 min)');
  });
});

describe('the next hook event takes the card back', () => {
  const record = (updatedAt: number): HookRecord => ({ sessionId: 's1', tmuxSession: 'cc-main', cwd: '/w', event: 'PermissionRequest', state: 'waiting', detail: 'Needs permission: Bash', waitKind: 'permission', updatedAt });

  it('applies a hook record newer than the hook time the card holds, though older than the report', () => {
    const merged = mergedCard(hooked(), report({ state: 'blocked', at: HOOK_AT + 1000 }), soon);
    const back = withRecord(merged, record(HOOK_AT + 500));
    expect(back).toMatchObject({ state: 'waiting', detail: 'Needs permission: Bash', updatedAt: HOOK_AT + 500 });
    expect(back.statusFrom).toBeUndefined();
    expect(withRecord(merged, record(HOOK_AT))).toBe(merged);
  });
});
