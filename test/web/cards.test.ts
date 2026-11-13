import { describe, expect, it } from 'vitest';
import { toWebCard, webCards, webFolders, webGroup } from '../../src/core/web/cards';
import type { SessionCard } from '../../src/core/sessions';
import { attentionOrder } from '../../src/core/sessionsView';
import { sortSessions } from '../../src/core/urgency';
import type { Feature } from '../../src/core/worktrees';

const NOW = 1_000_000_000;
const SORT = { mode: 'attention' as const, recentMs: 15 * 60_000, unreadFirst: false };
const o = { now: NOW, stuckMs: 600_000, idleMs: 30 * 60_000, unread: new Set<string>(), ...SORT };
const IDLE = 30 * 60_000;
const view = (unread: string[] = []) => ({ now: NOW, stuckMs: 600_000, idleMs: IDLE, unread: new Set(unread), ...SORT });
const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({
  id,
  sessionId: id,
  state: 'idle',
  detail: 'Ready',
  attached: false,
  tmuxSession: `cc-${id}`,
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  featureName: 'main',
  featureDir: '/w',
  cwd: '/w',
  updatedAt: NOW - 1000,
  ...over,
});

describe('webGroup', () => {
  it('puts what needs you first: waiting, blocked, and done sessions you have not read', () => {
    const v = view(['a']);
    expect(webGroup(card('a', { state: 'waiting' }), v)).toBe('needs');
    expect(webGroup(card('a', { state: 'blocked' }), v)).toBe('needs');
    expect(webGroup(card('a', { state: 'done' }), v)).toBe('needs');
    expect(webGroup(card('a', { state: 'working' }), v)).toBe('working');
    expect(webGroup(card('a', { state: 'idle' }), v)).toBe('rest');
    expect(webGroup(card('a', { state: 'unknown' }), v)).toBe('rest');
    expect(webGroup(card('a', { state: 'parked' }), v)).toBe('parked');
  });

  it('leaves a done session you have read in the rest, even when it asked a question', () => {
    expect(webGroup(card('a', { state: 'done', asksQuestion: true }), view())).toBe('rest');
  });

  it('leaves an unread done session not updated for idleMs in the rest (it sorts as idle)', () => {
    expect(webGroup(card('a', { state: 'done', updatedAt: NOW - IDLE - 1 }), view(['a']))).toBe('rest');
  });

  it('counts a done session waiting on background work as working', () => {
    expect(webGroup(card('a', { state: 'done', runsInBackground: true }), view(['a']))).toBe('working');
  });
});

describe('toWebCard', () => {
  it('maps a working card', () => {
    const c = toWebCard(card('s1', { state: 'working', detail: 'Running Bash', name: 'Fix the build', prompt: 'fix it', updatedAt: NOW - 120_000 }), o);
    expect(c).toEqual({
      id: 's1',
      title: 'Fix the build',
      state: 'working',
      look: 'working',
      label: 'WORKING',
      glyph: '⟳',
      tone: 'blue',
      spin: true,
      feature: 'main',
      line: 'Running Bash',
      group: 'working',
      updatedAt: NOW - 120_000,
      ago: '2m ago',
      pane: '%1',
      tmuxSession: 'cc-s1',
      canSend: true,
    });
  });

  it('shows a stuck session in orange', () => {
    const c = toWebCard(card('s', { state: 'working', updatedAt: NOW - 3_600_000 }), o);
    expect(c).toMatchObject({ look: 'stuck', tone: 'orange', spin: false, group: 'working' });
  });

  it('takes the line from the ask, else the live status, else the detail', () => {
    const base = card('s', { state: 'waiting', detail: 'Needs permission', liveStatus: 'Editing files', askSummary: 'May I run rm?' });
    expect(toWebCard(base, o).line).toBe('May I run rm?');
    expect(toWebCard({ ...base, askSummary: undefined }, o).line).toBe('Editing files');
    expect(toWebCard({ ...base, askSummary: undefined, liveStatus: undefined }, o).line).toBe('Needs permission');
  });

  it('puts the line on one line, at most 200 characters', () => {
    const c = toWebCard(card('s', { detail: `a\n\n  b ${'x'.repeat(300)}` }), o);
    expect(c.line.startsWith('a b x')).toBe(true);
    expect(c.line.length).toBe(200);
  });

  it('cannot send without a pane or once Claude is gone', () => {
    expect(toWebCard(card('s', { tmuxPane: undefined, tmuxSession: undefined }), o).canSend).toBe(false);
    expect(toWebCard(card('s', { state: 'stopped' }), o).canSend).toBe(false);
    expect(toWebCard(card('s', { tmuxPane: undefined }), o).canSend).toBe(true);
  });

  it('uses the dim tone without a colour', () => {
    expect(toWebCard(card('s', { state: 'unknown' }), o)).toMatchObject({ tone: 'dim', spin: false, look: 'unknown' });
    expect(toWebCard(card('s', { state: 'idle' }), o)).toMatchObject({ tone: 'dim', label: 'READY' });
  });

  it('leaves out what the card does not have', () => {
    const c = toWebCard(card('s', { featureName: undefined, tmuxPane: undefined, tmuxSession: undefined, updatedAt: undefined }), o);
    expect(c).not.toHaveProperty('feature');
    expect(c).not.toHaveProperty('pane');
    expect(c).not.toHaveProperty('tmuxSession');
    expect(c).not.toHaveProperty('updatedAt');
    expect(c.ago).toBe('');
  });

  it('keeps markup in titles as text (the page renders it with textContent)', () => {
    expect(toWebCard(card('s', { name: '<img src=x onerror=alert(1)>' }), o).title).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('webCards', () => {
  const cards = [
    card('idle-new', { state: 'idle', updatedAt: NOW - 1 }),
    card('working-old', { state: 'working', updatedAt: NOW - 50_000 }),
    card('done-read', { state: 'done', updatedAt: NOW - 10 }),
    card('done-unread', { state: 'done', updatedAt: NOW - 20 }),
    card('asked-read', { state: 'done', asksQuestion: true, updatedAt: NOW - 90_000 }),
    card('done-stale', { state: 'done', updatedAt: NOW - IDLE - 5 }),
    card('working-new', { state: 'working', updatedAt: NOW - 5_000 }),
    card('blocked', { state: 'blocked', updatedAt: NOW - 70_000 }),
    card('unknown', { state: 'unknown', updatedAt: undefined }),
    card('waiting', { state: 'waiting', updatedAt: NOW - 80_000 }),
  ];
  const v = view(['done-unread', 'done-stale', 'waiting']);

  it('orders sessions exactly as the Claude view does (attentionOrder)', () => {
    expect(webCards(cards, v).map((c) => c.id)).toEqual(attentionOrder(cards, v).map((c) => c.id));
  });

  it('follows devdesk.sessions.sort: urgency order, with its recently finished window', () => {
    const u = { ...v, mode: 'urgency' as const, recentMs: 60_000, unreadFirst: true };
    const ids = webCards(cards, u).map((c) => c.id);
    expect(ids).toEqual(sortSessions(cards, u).map((c) => c.id));
    expect(ids).not.toEqual(webCards(cards, v).map((c) => c.id));
  });

  it('puts unread done above working, and read done below it', () => {
    expect(webCards(cards, v).map((c) => c.id)).toEqual([
      'waiting',
      'blocked',
      'done-unread',
      'working-new',
      'working-old',
      'done-read',
      'asked-read',
      'done-stale',
      'idle-new',
      'unknown',
    ]);
  });

  it('groups match the order: needs, then working, then the rest', () => {
    const groups = webCards(cards, v).map((c) => c.group);
    expect(groups).toEqual(['needs', 'needs', 'needs', 'working', 'working', 'rest', 'rest', 'rest', 'rest', 'rest']);
  });
});

describe('webFolders', () => {
  it('lists main first, then the others by name', () => {
    const f = (name: string, isMain = false): Feature => ({ name, dir: `/w/${name}`, isMain, packages: [] });
    expect(webFolders([f('zeta'), f('alpha'), f('main', true)])).toEqual([
      { dir: '/w/main', name: 'main', isMain: true },
      { dir: '/w/alpha', name: 'alpha', isMain: false },
      { dir: '/w/zeta', name: 'zeta', isMain: false },
    ]);
    expect(webFolders([])).toEqual([]);
  });
});
