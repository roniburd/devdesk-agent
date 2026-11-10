import { describe, expect, it } from 'vitest';
import { withPendingTurns, withRecord } from '../src/core/livePatches';
import { parkable } from '../src/core/park';
import { buildSessionCards, type HookRecord, parseHookRecord, runningCopy, type SessionCard, type SessionState } from '../src/core/sessions';
import { STATE_INFO, stateInfo } from '../src/core/sessionStates';
import { attentionOrder, badgeFor, cardView } from '../src/core/sessionsView';
import { sessionSignals } from '../src/core/worktreeSignals';
import type { TmuxPane } from '../src/core/tmux';

/**
 * Pins, per session state, every fact the code decides from a card's state, through the functions that use it: one
 * table of states must keep every one of these the same.
 */

const NOW = 1_800_000_000_000;
const STATES: SessionState[] = ['working', 'waiting', 'done', 'idle', 'blocked', 'unknown', 'stopped', 'parked'];

const card = (state: SessionState, over: Partial<SessionCard> = {}): SessionCard => ({
  id: `c-${state}`,
  sessionId: `s-${state}`,
  pid: 100,
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  cwd: '/w',
  featureDir: '/w',
  state,
  detail: 'x',
  updatedAt: NOW - 1000,
  attached: false,
  ...over,
});

const rec = (state: string): HookRecord =>
  ({ sessionId: 's1', pid: 999, tmuxSession: 'cc-main', tmuxPane: '%1', cwd: '/w', event: 'Stop', state, detail: 'x', updatedAt: 1000 }) as HookRecord;

/** The states for which `pred` holds. */
const where = (pred: (s: SessionState) => boolean) => STATES.filter(pred);

describe('session state facts', () => {
  it('takes these states from a hook record', () => {
    expect(where((s) => parseHookRecord(JSON.stringify(rec(s))) !== undefined)).toEqual(['working', 'waiting', 'done', 'idle', 'blocked']);
    const patched = (s: SessionState) => withRecord(card(s), { ...rec('idle'), sessionId: `s-${s}`, detail: 'new', updatedAt: NOW }).detail === 'new';
    expect(where(patched)).toEqual(['working', 'waiting', 'done', 'idle', 'blocked']);
  });

  it('marks a dead record crashed when it was mid-turn', () => {
    const pane: TmuxPane = { session: 'cc-main', paneId: '%1', command: '-zsh', attached: false };
    const crashed = (s: SessionState) => !!buildSessionCards([pane], [rec(s)], [], () => false)[0]?.crashed;
    expect(where((s) => ['working', 'waiting', 'done', 'idle', 'blocked'].includes(s) && crashed(s))).toEqual(['working', 'waiting', 'blocked']);
  });

  it('counts these as a live session in a worktree', () => {
    const activity = (s: SessionState) => sessionSignals(new Map(), [card(s)]).activity.get('/w');
    expect(where((s) => activity(s) !== undefined)).toEqual(['working', 'waiting', 'done', 'idle', 'blocked', 'unknown']);
    expect(where((s) => activity(s) === 'busy')).toEqual(['working']);
  });

  it('finds a running copy only in these states', () => {
    expect(where((s) => runningCopy([card(s)], [], `s-${s}`) !== undefined)).toEqual(['working', 'waiting', 'done', 'idle', 'blocked', 'unknown']);
  });

  it('parks only these states', () => {
    expect(where((s) => parkable(card(s), 'devdesk'))).toEqual(['done', 'idle', 'blocked', 'parked']);
  });

  it('ends a pending turn on these states', () => {
    const pending = [{ server: 'devdesk', session: 'cc-main', prompt: 'go', at: NOW - 2000 }];
    const ended = (s: SessionState) => withPendingTurns([card(s)], pending, NOW).pending.length === 0;
    expect(where(ended)).toEqual(['waiting', 'done', 'blocked']);
  });

  it('labels each state', () => {
    expect(Object.fromEntries(STATES.map((s) => [s, cardView(card(s), NOW).stateLabel]))).toEqual({
      working: 'WORKING',
      waiting: 'NEEDS INPUT',
      done: 'DONE',
      idle: 'READY',
      blocked: 'BLOCKED',
      unknown: 'NO STATUS',
      stopped: 'NOT RUNNING',
      parked: 'PARKED',
    });
  });

  it('badges waiting, then blocked, then working', () => {
    const badge = (states: SessionState[]) => badgeFor(states.map((s, i) => card(s, { id: `${s}${i}` })));
    expect(badge(STATES)).toEqual({ value: 1, tooltip: '1 Claude session needs you' });
    expect(badge(STATES.filter((s) => s !== 'waiting'))).toEqual({ value: 1, tooltip: '1 Claude session blocked on an error' });
    expect(badge(['working', 'working', 'done'])).toEqual({ value: 2, tooltip: '2 Claude sessions working' });
    expect(badge(['done', 'idle', 'unknown', 'stopped', 'parked'])).toBeUndefined();
  });

  it('sorts the states in attention order', () => {
    const cards = STATES.map((s) => card(s, { updatedAt: NOW - 1000 }));
    expect(attentionOrder(cards, { now: NOW, idleMs: 60_000, unread: new Set() }).map((c) => c.state)).toEqual([
      'waiting',
      'blocked',
      'working',
      'done',
      'idle',
      'unknown',
      'stopped',
      'parked',
    ]);
  });
});

describe('STATE_INFO', () => {
  const states = (field: 'fromRecord' | 'midTurn' | 'live' | 'parkable' | 'insights' | 'endsPendingTurn') => where((s) => STATE_INFO[s][field]);

  it('has every state, and only those', () => {
    expect(Object.keys(STATE_INFO).sort()).toEqual([...STATES].sort());
    expect(stateInfo('thinking')).toBeUndefined();
    expect(stateInfo('toString')).toBeUndefined();
  });

  it('says what the sessions model, the insights worker and the list order decide from it', () => {
    // A dead record mid-turn is kept as crashed (sessionsModel's removeDead), else as exited.
    expect(states('midTurn')).toEqual(['working', 'waiting', 'blocked']);
    expect(states('insights')).toEqual(['working', 'waiting', 'done']);
    expect(states('fromRecord')).toEqual(['working', 'waiting', 'done', 'idle', 'blocked']);
    expect(states('live')).toEqual(['working', 'waiting', 'done', 'idle', 'blocked', 'unknown']);
    expect(states('parkable')).toEqual(['done', 'idle', 'blocked', 'parked']);
    expect(states('endsPendingTurn')).toEqual(['waiting', 'done', 'blocked']);
    const by = (k: 'listOrder' | 'attentionRank') => Object.fromEntries(STATES.map((s) => [s, STATE_INFO[s][k]]));
    expect(by('listOrder')).toEqual({ waiting: 0, blocked: 1, working: 2, done: 3, idle: 4, unknown: 5, stopped: 6, parked: 7 });
    expect(by('attentionRank')).toEqual({ waiting: 0, blocked: 1, done: 4, working: 3, idle: 5, unknown: 6, stopped: 7, parked: 8 });
  });
});
