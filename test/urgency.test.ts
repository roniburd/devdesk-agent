import { describe, expect, it } from 'vitest';
import { buildBoard } from '../src/core/board';
import { INTERRUPTED_DETAIL, type SessionCard } from '../src/core/sessions';
import { attentionOrder, SettledOrder } from '../src/core/sessionsView';
import { sortSessions, urgencyOrder, urgencyRank, type UrgencyOptions } from '../src/core/urgency';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({
  id,
  tmuxSession: `cc-${id}`,
  tmuxPane: '%1',
  cwd: `/ws/${id}`,
  state: 'done',
  detail: 'Finished',
  updatedAt: NOW - MIN,
  attached: false,
  ...over,
});

const opts = (over: Partial<UrgencyOptions> = {}): UrgencyOptions => ({ now: NOW, stuckMs: 10 * MIN, recentMs: 15 * MIN, unread: new Set(), ...over });
const ids = (cards: readonly SessionCard[]) => cards.map((c) => c.id);

describe('urgencyRank', () => {
  it('ranks needs you, recently finished, working, stuck, the rest, not running, parked', () => {
    const unread = new Set(['recent', 'old']);
    const o = opts({ unread });
    expect(urgencyRank(card('q', { state: 'waiting' }), o)).toBe(0);
    expect(urgencyRank(card('b', { state: 'blocked' }), o)).toBe(0);
    expect(urgencyRank(card('recent'), o)).toBe(1);
    expect(urgencyRank(card('w', { state: 'working' }), o)).toBe(2);
    expect(urgencyRank(card('s', { state: 'working', updatedAt: NOW - 11 * MIN }), o)).toBe(3);
    expect(urgencyRank(card('read'), o)).toBe(4);
    expect(urgencyRank(card('old', { updatedAt: NOW - 16 * MIN }), o)).toBe(4);
    expect(urgencyRank(card('i', { state: 'idle' }), o)).toBe(4);
    expect(urgencyRank(card('u', { state: 'unknown' }), o)).toBe(4);
    expect(urgencyRank(card('x', { state: 'stopped' }), o)).toBe(5);
    expect(urgencyRank(card('p', { state: 'parked' }), o)).toBe(6);
  });

  it('does not count a turn stopped with Esc as recently finished', () => {
    expect(urgencyRank(card('e', { detail: INTERRUPTED_DETAIL }), opts({ unread: new Set(['e']) }))).toBe(4);
  });

  it('ranks a done session waiting on background work as working', () => {
    const c = card('bg', { children: [{ id: 'k', kind: 'shell', label: 'sleep', state: 'running', background: true, children: [] }] });
    expect(urgencyRank(c, opts())).toBe(2);
  });
});

describe('urgencyOrder', () => {
  it('puts the longest waiting first, and newest first in the other ranks', () => {
    const cards = [
      card('w-old', { state: 'working', updatedAt: NOW - 5 * MIN }),
      card('q-new', { state: 'waiting', updatedAt: NOW - MIN }),
      card('w-new', { state: 'working', updatedAt: NOW - MIN }),
      card('q-old', { state: 'blocked', updatedAt: NOW - 9 * MIN }),
      card('p', { state: 'parked' }),
      card('x', { state: 'stopped' }),
      card('stuck', { state: 'working', updatedAt: NOW - 20 * MIN }),
      card('recent', { updatedAt: NOW - 2 * MIN }),
      card('read', { updatedAt: NOW - 2 * MIN }),
    ];
    expect(ids(urgencyOrder(cards, opts({ unread: new Set(['recent']) })))).toEqual(['q-old', 'q-new', 'recent', 'w-new', 'w-old', 'stuck', 'read', 'x', 'p']);
  });

  it('puts unread sessions first among the rest', () => {
    const cards = [card('read', { updatedAt: NOW - 20 * MIN }), card('old-unread', { updatedAt: NOW - 60 * MIN })];
    expect(ids(urgencyOrder(cards, opts({ unread: new Set(['old-unread']) })))).toEqual(['old-unread', 'read']);
  });

  it('breaks ties by id, whatever order the cards come in', () => {
    const a = card('a', { state: 'waiting', updatedAt: NOW - MIN });
    const b = card('b', { state: 'waiting', updatedAt: NOW - MIN });
    const c = card('c', { updatedAt: undefined });
    const d = card('d', { updatedAt: undefined });
    expect(ids(urgencyOrder([b, d, a, c], opts()))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(urgencyOrder([c, a, d, b], opts()))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps working sessions in place between re-sorts with settle', () => {
    const settle = { order: new SettledOrder(), everyMs: 5 * MIN };
    const first = [card('a', { state: 'working', updatedAt: NOW - 2 * MIN }), card('b', { state: 'working', updatedAt: NOW - MIN })];
    expect(ids(urgencyOrder(first, opts(), settle))).toEqual(['b', 'a']);
    // `a` did something since: newest first would swap them; settled, they stay.
    const later = [card('a', { state: 'working', updatedAt: NOW + 30_000 }), card('b', { state: 'working', updatedAt: NOW - MIN })];
    expect(ids(urgencyOrder(later, opts({ now: NOW + 40_000 }), settle))).toEqual(['b', 'a']);
  });
});

describe('sortSessions', () => {
  it('uses attention order with `attention`', () => {
    const cards = [card('w', { state: 'working' }), card('d', { updatedAt: NOW - 2 * MIN })];
    const unread = new Set(['d']);
    const o = { ...opts({ unread }), idleMs: 30 * MIN, unreadFirst: true };
    expect(ids(sortSessions(cards, { ...o, mode: 'attention' }))).toEqual(ids(attentionOrder(cards, NOW, 30 * MIN, unread, true)));
    expect(ids(sortSessions(cards, { ...o, mode: 'urgency' }))).toEqual(['d', 'w']);
  });
});

describe('buildBoard with urgency', () => {
  const base = { now: NOW, idleMs: 30 * MIN, stuckMs: 10 * MIN, unreadFirst: true, sort: 'urgency' as const, recentMs: 15 * MIN };

  it('orders each lane by urgency', () => {
    const cards = [
      card('q-new', { state: 'waiting', updatedAt: NOW - MIN }),
      card('q-old', { state: 'waiting', updatedAt: NOW - 8 * MIN }),
      card('stuck', { state: 'working', updatedAt: NOW - 20 * MIN }),
      card('work', { state: 'working', updatedAt: NOW - 30 * MIN + MIN * 25 }),
      card('done-read', { updatedAt: NOW - MIN }),
      card('blocked', { state: 'blocked', detail: 'API error', updatedAt: NOW - 3 * MIN }),
    ];
    const board = buildBoard(cards, [], { ...base, unread: new Set() });
    const lane = (id: string) => board.lanes.find((l) => l.id === id)!.sessions.map((s) => s.id);
    expect(lane('needs')).toEqual(['q-old', 'q-new']);
    expect(lane('working')).toEqual(['work', 'stuck']);
    expect(lane('review')).toEqual(['blocked', 'done-read']);
  });

  it('keeps every card to review above the idle divider', () => {
    // A read ready session updated recently, a read done one earlier, and an unread parked one.
    const cards = [card('ready', { state: 'idle', updatedAt: NOW - MIN }), card('done', { updatedAt: NOW - 5 * MIN }), card('parked', { state: 'parked', updatedAt: NOW - 90 * MIN })];
    const review = buildBoard(cards, [], { ...base, unread: new Set(['parked']) }).lanes.find((l) => l.id === 'review')!.sessions;
    expect(review.map((s) => [s.id, !!s.idle])).toEqual([
      ['done', false],
      ['parked', false],
      ['ready', true],
    ]);
  });
});
