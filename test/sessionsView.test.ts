import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionCard } from '../src/core/sessions';
import {
  attentionOrder,
  badgeFor,
  cardShown,
  cardSignature,
  cardView,
  displayState,
  firstSeen,
  formatAgo,
  HAND_MARK_MS,
  markSeen,
  nextSeen,
  readDecoration,
  SettledOrder,
  shownChange,
  shownLook,
  stateLook,
  transitionsToWaiting,
  truncate,
  unreadCards,
  withHandMarks,
} from '../src/core/sessionsView';

const NOW = 10_000_000;
const card = (over: Partial<SessionCard>): SessionCard => ({ id: 's1', state: 'working', detail: 'Running Bash', attached: false, ...over });

describe('formatAgo', () => {
  it('formats relative times', () => {
    expect(formatAgo(undefined, NOW)).toBe('');
    expect(formatAgo(NOW - 30_000, NOW)).toBe('just now');
    expect(formatAgo(NOW + 5_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(formatAgo(NOW - 2 * 3_600_000, NOW)).toBe('2h');
    expect(formatAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d');
  });
});

describe('cardView', () => {
  it('titles a session by Claude’s name, and fills the tooltip with the prompt, recap and times', () => {
    const v = cardView(
      card({ name: 'VSCode Extension', prompt: 'just merge', summary: 'You merged it.', summaryAt: NOW - 2 * 3_600_000, startedAt: NOW - 86_400_000, updatedAt: NOW - 5 * 60_000 }),
      NOW,
    );
    expect(v.title).toBe('VSCode Extension');
    expect(v.prompt).toBe('just merge');
    expect(v.summary).toBe('You merged it. (2h ago)');
    expect(v.times).toBe('Started 1d ago · active 5m ago');
  });

  it("titles a session by DevDesk's short Haiku title, unless the user named it, and keeps the prompt for the tooltip", () => {
    const prompt = 'Fix the login timeout when the session expires: raise TIMEOUT_MS in src/login.ts to 30 seconds.';
    const short = cardView(card({ prompt, insightTitle: 'Raise login timeout' }), NOW);
    expect([short.title, short.prompt]).toEqual(['Raise login timeout', prompt]);
    expect(cardView(card({ prompt, name: 'Claude’s own title', insightTitle: 'Raise login timeout' }), NOW).title).toBe('Raise login timeout');
    expect(cardView(card({ prompt, name: 'my name', nameByUser: true, insightTitle: 'Raise login timeout' }), NOW).title).toBe('my name');
  });

  it('leaves the tooltip extras empty when there is nothing more to show', () => {
    const v = cardView(card({ prompt: 'fix it', updatedAt: NOW }), NOW);
    expect(v.title).toBe('fix it');
    expect(v.prompt).toBe('');
    expect(v.summary).toBe('');
    expect(v.times).toBe('Active just now');
  });

  it('shows the worktree, the last prompt, the state and where the session runs', () => {
    const v = cardView(
      card({
        featureName: 'af2',
        featureDir: '/w/worktrees/af2',
        cwd: '/w/worktrees/af2/src/Pkg',
        tmuxSession: 'cc-af2',
        tmuxPane: '%1',
        prompt: 'fix the\nalarms',
        state: 'waiting',
        updatedAt: NOW - 120_000,
      }),
      NOW,
    );
    expect(v).toEqual({
      id: 's1',
      worktree: 'af2',
      hasWorktree: true,
      title: 'fix the alarms',
      prompt: '',
      summary: '',
      times: 'Active 2m ago',
      location: 'tmux cc-af2 · src/Pkg',
      state: 'waiting',
      stateLabel: 'NEEDS INPUT',
      ago: '2m',
      detail: 'Running Bash',
      liveStatus: '',
      insight: '',
      attached: false,
      inTmux: true,
    });
  });
  it("shows DevDesk's live status and summary when the card has them", () => {
    const v = cardView(card({ liveStatus: 'Running\nthe tests', insightSummary: 'Parser fixed', insightSummaryAt: NOW - 5 * 60_000 }), NOW);
    expect([v.liveStatus, v.insight]).toEqual(['Running the tests', 'Parser fixed (5m ago)']);
  });
  it('labels sessions outside worktrees and tmux, and every state', () => {
    const v = cardView(card({ cwd: '/home/u/scratch/x', state: 'done' }), NOW);
    expect([v.worktree, v.hasWorktree, v.title, v.location, v.stateLabel, v.inTmux]).toEqual([
      'no worktree',
      false,
      'Claude in x',
      'not in tmux · scratch/x',
      'DONE',
      false,
    ]);
    expect(cardView(card({ state: 'idle' }), NOW).stateLabel).toBe('READY');
    expect(cardView(card({ state: 'unknown', tmuxSession: 'h' }), NOW)).toMatchObject({ stateLabel: 'NO STATUS', title: 'h' });
    expect(cardView(card({ state: 'stopped' }), NOW).stateLabel).toBe('NOT RUNNING');
  });
  it('names the tmux server of sessions outside the VS Code one', () => {
    const at = (tmuxServer?: string) => cardView(card({ tmuxSession: 'orders-1', tmuxPane: '%1', tmuxServer }), NOW, 'devdesk').location;
    expect([at('devdesk'), at('default'), at(undefined), at('other')]).toEqual([
      'tmux orders-1',
      'tmux orders-1 (your tmux)',
      'tmux orders-1 (your tmux)',
      'tmux orders-1 (server other)',
    ]);
  });
  it('collapses whitespace and truncates long details', () => {
    const v = cardView(card({ detail: `line1\n\n  ${'x'.repeat(300)}` }), NOW);
    expect(v.detail.startsWith('line1 xxx')).toBe(true);
    expect(v.detail).toHaveLength(160);
    expect(v.detail.endsWith('…')).toBe(true);
    expect(truncate('short', 140)).toBe('short');
  });
});

describe('transitionsToWaiting', () => {
  it('lists sessions that just started waiting', () => {
    const prev = [card({ id: 'a', state: 'working' }), card({ id: 'b', state: 'waiting' })];
    const next = [card({ id: 'a', state: 'waiting' }), card({ id: 'b', state: 'waiting' }), card({ id: 'c', state: 'waiting' })];
    expect(transitionsToWaiting(prev, next)).toEqual(['a', 'c']);
  });
});

describe('badgeFor', () => {
  const cards = (...states: SessionCard['state'][]) => states.map((state, i) => card({ id: `s${i}`, state }));
  it('counts only the most urgent kind of session', () => {
    expect(badgeFor(cards('working', 'waiting', 'blocked', 'waiting'))).toEqual({ value: 2, tooltip: '2 Claude sessions need you' });
    expect(badgeFor(cards('working', 'blocked', 'done'))).toEqual({ value: 1, tooltip: '1 Claude session blocked on an error' });
    expect(badgeFor(cards('working', 'working', 'done'))).toEqual({ value: 2, tooltip: '2 Claude sessions working' });
  });
  it('shows nothing when no session needs you or is working', () => {
    expect(badgeFor(cards('done', 'idle', 'unknown', 'stopped'))).toBeUndefined();
    expect(badgeFor([])).toBeUndefined();
  });
});

describe('attention', () => {
  const IDLE = 30 * 60_000;
  const STUCK = 10 * 60_000;
  it('shows a done session not updated for idleMs as idle', () => {
    expect(displayState(card({ state: 'done', updatedAt: NOW - IDLE - 1 }), NOW, IDLE)).toBe('idle');
    expect(displayState(card({ state: 'done', updatedAt: NOW - 1000 }), NOW, IDLE)).toBe('done');
    expect(displayState(card({ state: 'waiting', updatedAt: 0 }), NOW, IDLE)).toBe('waiting');
  });

  it('orders needs input, blocked, unread done, working, read done, idle, no status, newest first', () => {
    const cards = [
      card({ id: 'stopped', state: 'stopped' }),
      card({ id: 'stale', state: 'done', updatedAt: NOW - IDLE - 1 }),
      card({ id: 'read', state: 'done', updatedAt: NOW - 1 }),
      card({ id: 'work-old', state: 'working', updatedAt: NOW - 5 }),
      card({ id: 'work-new', state: 'working', updatedAt: NOW - 2 }),
      card({ id: 'unread', state: 'done', updatedAt: NOW - 9 }),
      card({ id: 'blocked', state: 'blocked', updatedAt: NOW - 9 }),
      card({ id: 'waiting', state: 'waiting', updatedAt: NOW - 99 }),
      card({ id: 'nostatus', state: 'unknown' }),
    ];
    expect(attentionOrder(cards, NOW, IDLE, new Set(['unread'])).map((c) => c.id)).toEqual([
      'waiting',
      'blocked',
      'unread',
      'work-new',
      'work-old',
      'read',
      'stale',
      'nostatus',
      'stopped',
    ]);
  });

  it('puts every unread session first with unreadFirst, else only within its state', () => {
    const cards = [
      card({ id: 'waiting-read', state: 'waiting', updatedAt: NOW - 1 }),
      card({ id: 'working-unread', state: 'working', updatedAt: NOW - 50 }),
      card({ id: 'working-read', state: 'working', updatedAt: NOW - 1 }),
      card({ id: 'idle-unread', state: 'idle', updatedAt: NOW - 9 }),
    ];
    const unread = new Set(['working-unread', 'idle-unread']);
    // Working sessions sort as read, newest first.
    expect(attentionOrder(cards, NOW, IDLE, unread, true).map((c) => c.id)).toEqual(['idle-unread', 'waiting-read', 'working-read', 'working-unread']);
    expect(attentionOrder(cards, NOW, IDLE, unread).map((c) => c.id)).toEqual(['waiting-read', 'working-read', 'working-unread', 'idle-unread']);
  });

  it('keeps working sessions in place until the re-sort interval, a newly working one first', () => {
    const settle = { order: new SettledOrder(), everyMs: 5 * 60_000 };
    const ids = (cards: SessionCard[], now: number) => attentionOrder(cards, now, IDLE, new Set(), true, settle).map((c) => c.id);
    const waiting = card({ id: 'waiting', state: 'waiting', updatedAt: NOW - 99 });
    const w = (id: string, updatedAt: number) => card({ id, state: 'working', updatedAt });
    expect(ids([w('a', NOW - 3), w('b', NOW - 2), waiting], NOW)).toEqual(['waiting', 'b', 'a']);
    // a gets a hook event: it stays where it was.
    expect(ids([w('a', NOW + 10), w('b', NOW - 2), waiting], NOW + 10)).toEqual(['waiting', 'b', 'a']);
    // c starts working: it goes first among them; b finishes and leaves the run.
    expect(ids([w('a', NOW + 20), card({ id: 'b', state: 'done', updatedAt: NOW + 20 }), w('c', NOW + 1), waiting], NOW + 20)).toEqual([
      'waiting',
      'c',
      'a',
      'b',
    ]);
    // After the interval they sort newest first again.
    expect(ids([w('a', NOW + 5 * 60_000), w('c', NOW + 1), waiting], NOW + 5 * 60_000 + 20)).toEqual(['waiting', 'a', 'c']);
    // 0: always sorted.
    const live = { order: new SettledOrder(), everyMs: 0 };
    expect(attentionOrder([w('a', 1), w('b', 2)], NOW, IDLE, new Set(), false, live).map((c) => c.id)).toEqual(['b', 'a']);
    expect(attentionOrder([w('a', 3), w('b', 2)], NOW, IDLE, new Set(), false, live).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('marks a session unread when anything about it changes, until its terminal has been looked at', () => {
    const first = [card({ id: 'a', updatedAt: 1 }), card({ id: 'b', updatedAt: 1 })];
    // The first load counts as seen.
    let seen = nextSeen(new Map(), first, new Set(), true);
    expect([...unreadCards(seen, first)]).toEqual([]);
    // a gets a hook event (still working), b's subagent finishes, c is new.
    const next = [
      card({ id: 'a', updatedAt: 2, detail: 'Editing x.ts' }),
      card({ id: 'b', updatedAt: 1, children: [{ id: 'k', kind: 'agent', label: 'k', state: 'done', background: false, children: [] }] }),
      card({ id: 'c', state: 'waiting' }),
    ];
    seen = nextSeen(seen, next, new Set());
    expect([...unreadCards(seen, next)]).toEqual(['a', 'b', 'c']);
    // Looking at a's terminal long enough reads it; b and c stay unread.
    seen = nextSeen(seen, next, new Set(['a']));
    expect([...unreadCards(seen, next)]).toEqual(['b', 'c']);
  });

  it('keeps what was read of a session missing from a listing, so it is still read when listed again', () => {
    const a = card({ id: 'a', state: 'done', detail: 'Fixed it' });
    const b = card({ id: 'b', state: 'done', detail: 'Deployed' });
    let seen = nextSeen(new Map(), [a, b], new Set(), true);
    // One listing misses every session (hook records unreadable for a moment), or only some of them.
    seen = nextSeen(seen, [], new Set());
    expect([...seen.keys()]).toEqual(['a', 'b']);
    seen = nextSeen(seen, [b], new Set());
    expect([...unreadCards(seen, [a, b])]).toEqual([]);
    // Listed again with something new, it is unread.
    expect([...unreadCards(seen, [{ ...a, detail: 'Fixed more' }, b])]).toEqual(['a']);
  });

  it("a host's first load takes the shared read state of its listed sessions, and counts the others as read", () => {
    const a = card({ id: 'a', state: 'done', detail: 'Fixed it' });
    const b = card({ id: 'b', state: 'done', detail: 'Deployed' });
    const c = card({ id: 'c' });
    // a was read as it is now, b changed since it was read, c was never saved; x is another host's or workspace's.
    const shared = new Map([['x', 'sig-x'], ['b', 'old'], ['a', cardSignature(a)]]);
    const seen = firstSeen(shared, [a, b, c]);
    expect([...seen]).toEqual([['a', cardSignature(a)], ['b', 'old'], ['c', cardSignature(c)], ['x', 'sig-x']]);
    expect([...unreadCards(seen, [a, b, c])]).toEqual(['b']);
  });

  it("puts a mark by hand back when another window's write undoes it, while the session shows what it did then", () => {
    const a = card({ id: 'a', state: 'done', detail: 'Fixed it' });
    const read = new Map([['a', { signature: cardSignature(a), shown: cardSignature(a), at: NOW }]]);
    // Another window saved its copy from before the mark: a is unread again, and its own entry y is new.
    const reverted = new Map([['y', 'sig-y']]);
    const put = withHandMarks(reverted, read, [a], new Set(), NOW + 1000);
    expect([...put.seen]).toEqual([['y', 'sig-y'], ['a', cardSignature(a)]]);
    expect([...put.marks.keys()]).toEqual(['a']);
    // Marked unread, and undone by a write that has it read.
    const unread = new Map([['a', { signature: undefined, shown: cardSignature(a), at: NOW }]]);
    expect([...withHandMarks(new Map([['a', cardSignature(a)]]), unread, [a], new Set(), NOW).seen]).toEqual([]);
    // Nothing undone: the saved map itself.
    const saved = new Map([['a', cardSignature(a)]]);
    expect(withHandMarks(saved, read, [a], new Set(), NOW).seen).toBe(saved);
    // A mark no longer stands once it is old, the session shows something new, its terminal was looked at, or it is not listed.
    expect(withHandMarks(reverted, read, [a], new Set(), NOW + HAND_MARK_MS).marks.size).toBe(0);
    expect(withHandMarks(reverted, read, [{ ...a, detail: 'Fixed more' }], new Set(), NOW).marks.size).toBe(0);
    expect(withHandMarks(reverted, read, [a], new Set(['a']), NOW).marks.size).toBe(0);
    expect([...withHandMarks(reverted, read, [], new Set(), NOW).seen]).toEqual([['y', 'sig-y']]);
  });

  it('forgets the sessions gone longest once it remembers more than its limit', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => card({ id }));
    let seen = nextSeen(new Map(), cards, new Set(), true);
    // a goes first, then b: a has been gone longest.
    seen = nextSeen(seen, cards.slice(1), new Set(), false, 3);
    seen = nextSeen(seen, cards.slice(2), new Set(), false, 3);
    expect([...seen.keys()]).toEqual(['c', 'd', 'b']);
    // Listed sessions are never dropped, even past the limit; a, forgotten, comes back unread.
    seen = nextSeen(seen, cards, new Set(), false, 2);
    expect([...seen.keys()]).toEqual(['b', 'c', 'd']);
    expect([...unreadCards(seen, cards)]).toEqual(['a']);
  });

  it('marks a session read or unread by hand, until what it shows changes or its terminal is looked at', () => {
    const a = card({ id: 'a', state: 'done', detail: 'Fixed it' });
    const b = card({ id: 'b' });
    let seen = nextSeen(new Map(), [a, b], new Set(), true);
    seen = markSeen(seen, a, false);
    expect([...unreadCards(seen, [a, b])]).toEqual(['a']);
    // Still unread on the next refresh while nobody looks at it.
    seen = nextSeen(seen, [a, b], new Set());
    expect([...unreadCards(seen, [a, b])]).toEqual(['a']);
    seen = markSeen(seen, a, true);
    expect([...unreadCards(seen, [a, b])]).toEqual([]);
    // Marked read, it turns unread again once something new happens.
    const a2 = { ...a, detail: 'Fixed more' };
    expect([...unreadCards(nextSeen(seen, [a2, b], new Set()), [a2, b])]).toEqual(['a']);
  });

  it('keeps a read session read when only its time changes, so ageing or an idle reminder is not news', () => {
    const done = card({ id: 'a', state: 'done', detail: 'Fixed it', updatedAt: 1 });
    const seen = nextSeen(new Map(), [done], new Set(['a']));
    // Claude's idle reminder rewrites the same state a minute later; half an hour on the session sorts as idle.
    expect([...unreadCards(seen, [{ ...done, updatedAt: 60_001 }])]).toEqual([]);
    expect([...unreadCards(seen, [{ ...done, updatedAt: 1 }])]).toEqual([]);
    // A new turn ending (new reply) or an interrupt is news.
    expect([...unreadCards(seen, [{ ...done, detail: 'Fixed the other one' }])]).toEqual(['a']);
    expect([...unreadCards(seen, [{ ...done, detail: 'Interrupted' }])]).toEqual(['a']);
  });

  it('marks a session that changed while nobody looked as unread when the saved read state is reloaded', () => {
    const a = card({ id: 'a', state: 'working', detail: 'Running Bash' });
    // Saved by the window before a reload: a was read while working.
    const saved = new Map(nextSeen(new Map(), [a], new Set(['a'])));
    // After the reload (no seeding: there is saved state), a has finished and b started meanwhile.
    const now = [{ ...a, state: 'done' as const, detail: 'Done' }, card({ id: 'b', state: 'waiting' })];
    const seen = nextSeen(saved, now, new Set());
    expect([...unreadCards(seen, now)]).toEqual(['a', 'b']);
  });

  it('picks the icon look: kind of input, limit or error, stuck, crashed', () => {
    const look = (over: Partial<SessionCard>) => stateLook(card({ updatedAt: NOW - 1000, ...over }), NOW, STUCK);
    expect(look({ state: 'waiting', detail: 'Asking: which one?' })).toBe('question');
    expect(look({ state: 'waiting', detail: 'Plan ready for your review' })).toBe('plan');
    expect(look({ state: 'waiting', detail: 'Claude needs your permission to use Bash' })).toBe('permission');
    expect(look({ state: 'waiting', detail: 'Claude needs your input' })).toBe('input');
    // A record that says what it waits on wins over its detail.
    expect(look({ state: 'waiting', detail: 'Claude needs your permission', waitKind: 'question' })).toBe('question');
    expect(look({ state: 'waiting', detail: 'Claude needs your permission', waitKind: 'plan' })).toBe('plan');
    expect(look({ state: 'waiting', detail: 'Asking: which one?', waitKind: 'permission' })).toBe('permission');
    expect(look({ state: 'waiting', detail: 'Needs your permission', waitKind: 'elicitation' })).toBe('input');
    // A record that says what it waits on wins over its detail.
    expect(look({ state: 'waiting', detail: 'Claude needs your permission', waitKind: 'question' })).toBe('question');
    expect(look({ state: 'waiting', detail: 'Claude needs your permission', waitKind: 'plan' })).toBe('plan');
    expect(look({ state: 'waiting', detail: 'Asking: which one?', waitKind: 'permission' })).toBe('permission');
    expect(look({ state: 'waiting', detail: 'Needs your permission? no', waitKind: 'elicitation' })).toBe('input');
    expect(look({ state: 'blocked', detail: 'rate_limit: Too many requests' })).toBe('limited');
    expect(look({ state: 'blocked', detail: 'You have reached your usage limit' })).toBe('limited');
    expect(look({ state: 'blocked', detail: 'API Error: 500' })).toBe('error');
    expect(look({ state: 'working' })).toBe('working');
    expect(look({ state: 'working', updatedAt: NOW - STUCK - 1 })).toBe('stuck');
    expect(look({ state: 'stopped', crashed: true })).toBe('crashed');
    expect(look({ state: 'stopped' })).toBe('stopped');
    // A finished turn stays done however old (it only sorts lower); Esc's interrupt is done in its own colour.
    expect(look({ state: 'done', updatedAt: NOW - IDLE - 1 })).toBe('done');
    expect(look({ state: 'done', detail: 'Interrupted' })).toBe('interrupted');
    // A reply that ends with a question is done in its own look (it stays in the review lane, not "needs you").
    expect(look({ state: 'done', detail: 'Should I implement these?', asksQuestion: true })).toBe('asked');
    expect(look({ state: 'done', asksQuestion: true, children: [{ id: 'sh', kind: 'shell', label: 'sleep', state: 'running', background: true, children: [] }] })).toBe('background');
    expect(look({ state: 'done', detail: 'Interrupted', updatedAt: NOW - IDLE - 1 })).toBe('interrupted');
    expect(look({ state: 'idle', detail: 'Ready' })).toBe('idle');
  });

  it('shows a done session with running background work as waiting on it, never idle, and sorts it with working ones', () => {
    const shell = (state: 'running' | 'done', background = true) => ({ id: `sh-${state}`, kind: 'shell' as const, label: 'sleep 600', state, background, children: [] });
    const look = (over: Partial<SessionCard>) => stateLook(card({ updatedAt: NOW - 1000, ...over }), NOW, STUCK);
    // The turn ended (Stop: done) while a background shell it started still runs: Claude wakes when it finishes.
    expect(look({ state: 'done', children: [shell('running')] })).toBe('background');
    expect(look({ state: 'done', updatedAt: NOW - IDLE - STUCK - 1, children: [shell('running')] })).toBe('background');
    expect(displayState(card({ state: 'done', updatedAt: NOW - IDLE - 1, children: [shell('running')] }), NOW, IDLE)).toBe('done');
    // Finished background work, or none, is an ordinary done session.
    expect(look({ state: 'done', children: [shell('done')] })).toBe('done');
    // A foreground child still marked running (an interrupted turn) is not background work Claude comes back for.
    expect(look({ state: 'done', children: [shell('running', false)] })).toBe('done');
    // Children not listed (`devdesk.sessions.showChildren` off): the refresh still marks what runs in the background.
    expect(look({ state: 'done', runsInBackground: true })).toBe('background');
    expect(look({ state: 'done', updatedAt: NOW - IDLE - STUCK - 1, runsInBackground: true })).toBe('background');
    // Input and errors still come first.
    expect(look({ state: 'waiting', detail: 'Asking: which one?', children: [shell('running')] })).toBe('question');
    const cards = [
      card({ id: 'done', state: 'done', updatedAt: NOW - 1000 }),
      card({ id: 'bg', state: 'done', updatedAt: NOW - 5000, children: [shell('running')] }),
      card({ id: 'working', state: 'working', updatedAt: NOW - 3000 }),
    ];
    expect(attentionOrder(cards, NOW, IDLE, new Set()).map((c) => c.id)).toEqual(['working', 'bg', 'done']);
  });
});

describe('shownChange', () => {
  it('names what a session shows differently', () => {
    const before = cardShown(card({ state: 'working', detail: 'Running Bash', children: [] }));
    expect(shownChange(before, before)).toBe('');
    const after = cardShown(card({ state: 'done', detail: 'Fixed.', crashed: true, children: [] }));
    expect(shownChange(before, after)).toBe('state working→done; detail "Running Bash"→"Fixed."; crashed');
  });

  it('names subagents that started, finished or went away', () => {
    const child = (id: string, state: 'running' | 'done') => ({ id, kind: 'agent' as const, label: id, state, background: false, children: [] });
    const before = cardShown(card({ children: [child('a', 'running'), child('b', 'running')] }));
    const after = cardShown(card({ children: [child('a', 'done'), child('c', 'running')] }));
    expect(shownChange(before, after)).toBe('child a running→done; child c running (new); child b gone');
    expect(shownChange(cardShown(card({})), cardShown(card({ children: [] })))).toBe('children listed');
  });

  it('keeps the signature saved by earlier versions', () => {
    // sha1 of JSON [state, detail, crashed, children] as before the readable parts existed.
    const c = card({ state: 'done', detail: 'Fixed.' });
    const old = createHash('sha1').update(JSON.stringify([c.state, c.detail, c.crashed, undefined])).digest('base64url').slice(0, 16);
    expect(cardSignature(c)).toBe(old);
  });
});

describe('readDecoration', () => {
  it('badges unread rows and greys read ones, each by its own setting', () => {
    const both = { dimRead: true, badge: true };
    expect(readDecoration(true, both)).toEqual({ badge: '\u25CF', tooltip: 'Unread' });
    expect(readDecoration(false, both)).toEqual({ color: 'descriptionForeground', tooltip: 'Read' });
    expect(readDecoration(true, { dimRead: true, badge: false })).toBeUndefined();
    expect(readDecoration(false, { dimRead: false, badge: true })).toBeUndefined();
  });
});

describe('shownLook', () => {
  const STUCK = 10 * 60_000;
  it('keeps the look a parked session finished with, in its label too', () => {
    expect(shownLook(card({ state: 'parked', lastState: 'done', detail: 'All set' }), NOW, STUCK)).toEqual({ look: 'done', label: 'DONE · PARKED (NOT RUNNING)' });
    expect(shownLook(card({ state: 'parked', lastState: 'done', asksQuestion: true }), NOW, STUCK).look).toBe('asked');
    expect(shownLook(card({ state: 'parked', lastState: 'blocked', detail: 'rate_limit: usage limit reached' }), NOW, STUCK).look).toBe('limited');
  });
  it('shows parked when the turn never ended or it crashed, and the plain look otherwise', () => {
    expect(shownLook(card({ state: 'parked', lastState: 'working' }), NOW, STUCK).look).toBe('parked');
    expect(shownLook(card({ state: 'parked' }), NOW, STUCK).look).toBe('parked');
    expect(shownLook(card({ state: 'parked', lastState: 'done', crashed: true }), NOW, STUCK).look).toBe('crashed');
    expect(shownLook(card({ state: 'done', detail: 'Finished' }), NOW, STUCK)).toEqual({ look: 'done', label: 'DONE' });
  });
});
