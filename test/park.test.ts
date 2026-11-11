import { describe, expect, it } from 'vitest';
import type { EndedRecord } from '../src/core/ended';
import { meminfoFreePercent, memorystatusFreePercent, parkable, parkedIn, parkPlan, type ParkPolicy } from '../src/core/park';
import type { SessionCard } from '../src/core/sessions';

const MIN = 60_000;
const DAY = 1440 * MIN;
const NOW = 1_800_000_000_000;

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  sessionId: 's1',
  pid: 100,
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  cwd: '/w',
  state: 'done',
  detail: 'x',
  updatedAt: NOW - 3 * DAY,
  attached: false,
  ...over,
});
/** A card with its own id, session id and tmux session. */
const own = (id: string, over: Partial<SessionCard> = {}) => card({ id, sessionId: id, tmuxSession: `cc-${id}`, ...over });

const POLICY: ParkPolicy = { anyMs: 2 * DAY, readMs: 0, maxLive: 0, lowMemory: false, idleMs: 30 * MIN };
const allRead = () => true;
const ids = (cards: SessionCard[], policy: Partial<ParkPolicy> = {}, read: (c: SessionCard) => boolean = allRead) =>
  parkPlan(cards, NOW, { ...POLICY, ...policy }, 'devdesk', read).map((p) => `${p.card.id}:${p.reason}`);

describe('parkable', () => {
  it('takes only finished, unattached DevDesk sessions that run nothing', () => {
    const cards = [
      card({ id: 'old' }),
      card({ id: 'attached', attached: true }),
      card({ id: 'waiting', state: 'waiting' }),
      card({ id: 'working', state: 'working' }),
      card({ id: 'stopped', state: 'stopped' }),
      card({ id: 'mine', tmuxSession: 'orders' }),
      card({ id: 'other-server', tmuxServer: 'default' }),
      card({ id: 'no-id', sessionId: undefined }),
      card({ id: 'busy', children: [{ id: 'k', kind: 'agent', label: 'a', state: 'running', background: true, children: [] }] }),
      card({ id: 'shell-left', state: 'parked' }),
      card({ id: 'already-parked', state: 'parked', tmuxSession: undefined }),
      card({ id: 'blocked', state: 'blocked' }),
    ];
    expect(cards.filter((c) => parkable(c, 'devdesk')).map((c) => c.id)).toEqual(['old', 'shell-left', 'blocked']);
  });
});

describe('parkPlan', () => {
  it('never parks a held session (a window is reattaching its terminal), by any rule', () => {
    const cards = [own('old'), own('held'), own('a', { updatedAt: NOW - 40 * MIN }), own('b', { updatedAt: NOW - 50 * MIN })];
    const held = (c: SessionCard) => c.id === 'held';
    const plan = parkPlan(cards, NOW, { ...POLICY, maxLive: 1, lowMemory: true }, 'devdesk', allRead, held).map((p) => p.card.id);
    expect(plan).not.toContain('held');
    expect(plan).toContain('old');
  });

  it('parks by age past parkAfterDays, and turns everything off at 0', () => {
    const cards = [own('old'), own('recent', { updatedAt: NOW - DAY })];
    expect(ids(cards)).toEqual(['old:inactive']);
    expect(ids(cards, { anyMs: 0, readMs: MIN, maxLive: 1, lowMemory: true })).toEqual([]);
  });

  it('parks finished sessions the user has read sooner, but not those that need them', () => {
    const hour = { updatedAt: NOW - 2 * 60 * MIN };
    const cards = [
      own('read', hour),
      own('unread', hour),
      own('question', { ...hour, asksQuestion: true }),
      own('error', { ...hour, state: 'blocked' }),
      own('fresh', { updatedAt: NOW - 10 * MIN }),
      own('shell-left-error', { ...hour, state: 'parked', lastState: 'blocked' }),
    ];
    const read = (c: SessionCard) => c.id !== 'unread';
    expect(ids(cards, { readMs: 60 * MIN }, read)).toEqual(['read:read']);
    expect(ids(cards, { readMs: 0 }, read)).toEqual([]);
  });

  it('keeps at most maxLive sessions running: parks the idle ones, read and oldest first', () => {
    const cards = [
      own('working', { state: 'working', updatedAt: NOW - 5 * DAY }),
      own('attached', { attached: true, updatedAt: NOW - 5 * DAY }),
      own('just-done', { updatedAt: NOW - 5 * MIN }),
      own('unread-oldest', { updatedAt: NOW - 20 * 60 * MIN }),
      own('read-old', { updatedAt: NOW - 10 * 60 * MIN }),
      own('read-older', { updatedAt: NOW - 12 * 60 * MIN }),
      own('parked', { state: 'parked', tmuxSession: undefined }),
    ];
    const read = (c: SessionCard) => c.id !== 'unread-oldest';
    // 6 run (the parked one does not count): 2 over 4.
    expect(ids(cards, { maxLive: 4 }, read)).toEqual(['read-older:limit', 'read-old:limit']);
    expect(ids(cards, { maxLive: 3 }, read)).toEqual(['read-older:limit', 'read-old:limit', 'unread-oldest:limit']);
    // Never the working, attached or just finished ones, however far over.
    expect(ids(cards, { maxLive: 1 }, read)).toHaveLength(3);
    expect(ids(cards, { maxLive: 0 }, read)).toEqual([]);
  });

  it('counts sessions parked by age against the limit', () => {
    const cards = [own('ancient'), own('a', { updatedAt: NOW - 2 * 60 * MIN }), own('b', { updatedAt: NOW - 3 * 60 * MIN })];
    expect(ids(cards, { maxLive: 2 })).toEqual(['ancient:inactive']);
    expect(ids(cards, { maxLive: 1 })).toEqual(['ancient:inactive', 'b:limit']);
  });

  it('parks one more idle session when memory is low', () => {
    const cards = [own('a', { updatedAt: NOW - 2 * 60 * MIN }), own('b', { updatedAt: NOW - 3 * 60 * MIN }), own('fresh', { updatedAt: NOW - MIN })];
    expect(ids(cards, { lowMemory: true })).toEqual(['b:memory']);
    expect(ids(cards, { lowMemory: true, maxLive: 2 })).toEqual(['b:limit', 'a:memory']);
    expect(ids([cards[2]], { lowMemory: true })).toEqual([]);
  });
});

describe('parkedIn', () => {
  const ended = (over: Partial<EndedRecord>): EndedRecord => ({
    sessionId: 's1',
    tmuxSession: 'cc-main',
    tmuxServer: 'devdesk',
    cwd: '/w',
    event: 'Stop',
    state: 'done',
    detail: '',
    updatedAt: NOW - DAY,
    endedAt: NOW - DAY,
    endReason: 'parked',
    ...over,
  });

  it('finds the newest session DevDesk parked in a tmux session, if not running again', () => {
    const records = [
      ended({ sessionId: 'older', endedAt: NOW - 2 * DAY }),
      ended({ sessionId: 'newer' }),
      ended({ sessionId: 'exited', endedAt: NOW, endReason: 'exited' }),
      ended({ sessionId: 'crashed', endedAt: NOW, endReason: 'crashed' }),
      ended({ sessionId: 'elsewhere', endedAt: NOW, tmuxSession: 'cc-other' }),
      ended({ sessionId: 'other-server', endedAt: NOW, tmuxServer: 'default' }),
    ];
    expect(parkedIn('cc-main', 'devdesk', records, new Set())?.sessionId).toBe('newer');
    expect(parkedIn('cc-main', 'devdesk', records, new Set(['newer']))?.sessionId).toBe('older');
    expect(parkedIn('cc-gone', 'devdesk', records, new Set())).toBeUndefined();
  });
});

describe('free memory', () => {
  it('reads MemAvailable of MemTotal on Linux', () => {
    expect(meminfoFreePercent('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n')).toBe(25);
    expect(meminfoFreePercent('MemTotal:       16000000 kB\n')).toBeUndefined();
  });

  it("reads macOS's memory pressure level", () => {
    expect(memorystatusFreePercent('34\n')).toBe(34);
    expect(memorystatusFreePercent('')).toBeUndefined();
    expect(memorystatusFreePercent('nope')).toBeUndefined();
  });
});
