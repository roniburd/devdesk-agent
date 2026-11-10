// The Claude Board's search box (media/board.js bundled, in jsdom, the page's markup from src/board/html.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { matchesQuery, parseQuery, searchFields } from '../src/core/boardSearch';
import { narrowScope, scopeSelects } from '../src/core/usageScope';
import { projectFolder } from './boardProjectFolder';
import { webviewBody } from './webviewBody';
import { webviewScript } from './webviewScript';

const ROOT = join(__dirname, '..');

const boardHtml = () => webviewBody('src/board/html.ts');

type S = Record<string, unknown>;
const session = (id: string, title: string, o: { worktree?: string; lane?: string; look?: string; state?: string; texts?: string[] } = {}): S => ({
  id,
  title,
  worktree: o.worktree ?? 'main',
  look: o.look ?? 'done',
  lookLabel: o.look ?? 'done',
  ago: '1m',
  detail: '',
  insight: '',
  hoverParts: [{ text: title }],
  unread: false,
  running: 0,
  canOpen: true,
  canFork: true,
  canEnd: true,
  parked: o.state === 'parked',
  search: searchFields({ title, worktree: o.worktree ?? 'main', laneTitle: o.lane ?? 'Done / to review', lookLabel: o.look ?? 'done', state: o.state ?? 'done', texts: o.texts ?? [] }),
});

/** The board's lanes; `idle` sessions go in the Done / idle lane, under its divider, after the `review` ones. */
const LANES = (sessions: { needs?: S[]; review?: S[]; idle?: S[]; hidden?: S[] }) => [
  { id: 'backlog', title: 'Prompts for later', sessions: [], tasks: [] },
  { id: 'needs', title: 'Needs you', sessions: sessions.needs ?? [], tasks: [] },
  { id: 'working', title: 'Working', sessions: [], tasks: [] },
  {
    id: 'review',
    title: 'Done / idle',
    divider: 'Idle / stopped',
    sessions: [...(sessions.review ?? []), ...(sessions.idle ?? []).map((s) => ({ ...s, idle: true as const }))],
    tasks: [],
    ...(sessions.hidden ? { hidden: sessions.hidden.map((s) => ({ ...s, idle: true as const })), more: sessions.hidden.length } : {}),
  },
];

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

/** `saved`: what the project folder kept (its filter and search, as after a reload or the tab closed). */
async function board(lanes: ReturnType<typeof LANES>, saved?: Record<string, unknown>) {
  dom = new JSDOM(boardHtml(), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown; acquireVsCodeApi: unknown };
  const posted: Array<Record<string, unknown>> = [];
  const folder = projectFolder(saved);
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.acquireVsCodeApi = () => ({
    getState: () => undefined,
    setState: () => undefined,
    postMessage: (m: Record<string, unknown>) => {
      posted.push(m);
      folder.answer(m, (answer) => win.postMessage(answer, '*'));
    },
  });
  win.eval(webviewScript('board'));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const host = async (m: Record<string, unknown>) => {
    win.postMessage(m, '*');
    await settle();
  };
  const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: [] };
  await host({ type: 'board', loaded: true, board: { lanes, needYou: 0, working: 0, worktrees: ['feat-a'] }, composer });
  const input = win.document.getElementById('search') as HTMLInputElement;
  const shown = () => [...win.document.querySelectorAll<HTMLElement>('#lanes .card[data-session]')].map((c) => c.dataset.session);
  const type = async (text: string) => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle();
  };
  const key = async (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}, target: EventTarget = input) => {
    const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
    target.dispatchEvent(ev);
    await settle();
    return ev;
  };
  const banner = () => win.document.getElementById('search-banner')!;
  return { win, input, shown, type, key, host, posted, banner, state: () => folder.flat() };
}

const auth = session('a', 'Fix the auth test', { worktree: 'feat-a', lane: 'Needs you', look: 'question', state: 'waiting' });
const parser = session('p', 'Parser refactor', { texts: ['Run the café benchmarks'] });
const old = session('o', 'Old auth spike', { lane: 'Idle / stopped', look: 'parked', state: 'parked' });

describe('board search box: as you type', () => {
  it('filters the lanes in place, keeping each lane and its order', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    expect(b.shown()).toEqual(['a', 'p']);
    await b.type('cafe');
    expect(b.shown()).toEqual(['p']);
    await b.type('AUTH');
    expect(b.shown()).toEqual(['a']);
    await b.type('');
    expect(b.shown()).toEqual(['a', 'p']);
  });

  it('collapses the lanes a query leaves empty to their heading (title and count), and expands them when it clears', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    const lane = (title: string) => b.win.document.querySelector<HTMLElement>(`#lanes .lane[aria-label="${title}"]`)!;
    const collapsed = () => [...b.win.document.querySelectorAll<HTMLElement>('#lanes .lane.collapsed')].map((l) => l.getAttribute('aria-label'));
    expect(collapsed()).toEqual([]);
    await b.type('cafe');
    expect(collapsed()).toEqual(['Needs you', 'Working']);
    const needs = lane('Needs you');
    expect(needs.querySelector('h2')!.textContent).toContain('Needs you');
    expect(needs.querySelector('h2 .count')!.textContent).toBe('0');
    expect(needs.querySelector('.empty')).toBeNull();
    expect(lane('Done / idle').classList.contains('collapsed')).toBe(false);
    await b.type('');
    expect(collapsed()).toEqual([]);
    expect(lane('Working').querySelector('.empty')!.textContent).toBe('Nothing here');
  });

  it('shows hidden parked sessions only while a query matches them, and hides the "more parked" line then', async () => {
    const b = await board(LANES({ needs: [auth], hidden: [old] }));
    expect(b.shown()).toEqual(['a']);
    expect(b.win.document.querySelector('.more')).not.toBeNull();
    await b.type('auth');
    expect(b.shown()).toEqual(['a', 'o']);
    expect(b.win.document.querySelector('.more')).toBeNull();
  });

  it('says when nothing matches and that Enter asks', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.type('nothing-like-this');
    expect(b.shown()).toEqual([]);
    expect(b.banner().hidden).toBe(false);
    expect(b.banner().textContent).toContain('No sessions match. ⏎ to ask ✨');
  });

  it('combines with the Worktree filter', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    const filter = b.win.document.getElementById('filter') as HTMLSelectElement;
    filter.value = 'feat-a';
    filter.dispatchEvent(new b.win.Event('change', { bubbles: true }));
    await b.type('a');
    expect(b.shown()).toEqual(['a']);
  });

  it('Escape clears the query; Escape again leaves the box for the prompt box', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('cafe');
    await b.key('Escape');
    expect(b.input.value).toBe('');
    expect(b.shown()).toEqual(['a', 'p']);
    await b.key('Escape');
    expect(b.win.document.activeElement?.id).toBe('prompt');
  });

  it('⌘F / Ctrl+F focuses the box', async () => {
    const b = await board(LANES({ needs: [auth] }));
    (b.win.document.getElementById('prompt') as HTMLElement).focus();
    const ev = await b.key('f', { metaKey: true }, b.win.document);
    expect(ev.defaultPrevented).toBe(true);
    expect(b.win.document.activeElement).toBe(b.input);
  });

  it('remembers the query across a reload', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('parser');
    const again = await board(LANES({ needs: [auth], review: [parser] }), b.state());
    expect(again.input.value).toBe('parser');
    expect(again.shown()).toEqual(['p']);
  });

  it('puts the divider above the first idle card shown, only with cards to review above it', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser], idle: [old] }));
    const body = () => [...b.win.document.querySelectorAll<HTMLElement>('#lanes .lane[aria-label="Done / idle"] .body > *')].map((e) => (e.classList.contains('divider') ? `-- ${e.textContent}` : e.dataset.session ?? e.className));
    expect(body()).toEqual(['p', '-- Idle / stopped', 'o']);
    expect(b.win.document.querySelector('#lanes .divider')!.getAttribute('role')).toBe('separator');
    await b.type('old');
    expect(body()).toEqual(['o']);
    await b.type('');
    expect(body()).toEqual(['p', '-- Idle / stopped', 'o']);
  });

  it('filters with the core matcher (src/core/boardQuery.ts, bundled in)', async () => {
    const all = [auth, parser, old];
    const b = await board(LANES({ needs: [auth], review: [parser], idle: [old] }));
    for (const q of ['auth', 'wt:feat', 'is:needs', 'is:parked auth', 'café', 'fix(auth', 'wt:', '"x"', 'refactor parser']) {
      await b.type(q);
      const want = all.filter((s) => matchesQuery(s.search as never, parseQuery(q))).map((s) => s.id);
      expect(b.shown(), q).toEqual(want);
    }
  });

  const TYPING = ['a', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];

  it('keys typed in the box stay in the box, untouched and without reaching other handlers', async () => {
    const b = await board(LANES({ needs: [auth] }));
    b.input.focus();
    await b.host({ type: 'ping' }); // let the first render's own 'rendered' report go out
    const before = b.posted.length;
    for (const k of TYPING) {
      const ev = await b.key(k);
      expect(ev.defaultPrevented, k).toBe(false);
      expect(b.win.document.activeElement, k).toBe(b.input);
    }
    expect(b.posted.slice(before).filter((m) => m.type !== 'rendered' && m.type !== 'keep')).toEqual([]);
  });

  it('Enter in the box asks ✨ (and only that) when it has text, and does nothing when empty', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.host({ type: 'ping' });
    const before = b.posted.length;
    expect((await b.key('Enter')).defaultPrevented).toBe(true);
    expect(b.posted.slice(before).filter((m) => m.type !== 'rendered' && m.type !== 'keep')).toEqual([]);
    await b.type('auth');
    expect((await b.key('Enter')).defaultPrevented).toBe(true);
    expect(b.posted.slice(before).filter((m) => m.type !== 'rendered' && m.type !== 'keep')).toEqual([{ type: 'search', query: 'auth' }]);
    expect(b.win.document.activeElement).toBe(b.input);
  });

  it('with the composer popup open, keys in the box do not drive the popup', async () => {
    const b = await board(LANES({ needs: [auth] }));
    b.win.document.getElementById('model')!.click();
    await new Promise((r) => setTimeout(r, 20));
    const popup = b.win.document.getElementById('popup')!;
    expect(popup.hidden).toBe(false);
    b.input.focus();
    for (const k of TYPING) {
      const ev = await b.key(k);
      expect(ev.defaultPrevented, k).toBe(false);
      expect(popup.hidden, k).toBe(false);
      expect(b.win.document.activeElement, k).toBe(b.input);
    }
    // Enter asks ✨ and leaves the popup alone.
    await b.type('auth');
    await b.key('Enter');
    expect(popup.hidden).toBe(false);
    expect(b.posted.filter((m) => m.type === 'compose' || m.type === 'start')).toEqual([]);
  });

  it('Escape in the box does not close the open token usage popover', async () => {
    const b = await board(LANES({ needs: [auth] }));
    b.win.document.getElementById('stats')!.click();
    await new Promise((r) => setTimeout(r, 20));
    const pop = b.win.document.getElementById('stats-pop')!;
    expect(pop.hidden).toBe(false);
    b.input.focus();
    await b.key('Escape');
    expect(pop.hidden).toBe(false);
  });
});

describe('board 📊 popup: scope', () => {
  const zeroT = { total: 0, cached: 0, requests: 0, totalText: '0', cachedText: '0' };
  const day = (places: unknown[]) => ({ key: 'k', label: 'Today', short: 'Today', sessions: zeroT, devdesk: { ...zeroT, failed: 0 }, models: [], top: [], places });
  type Loose = { scope: never; windowProject: string; choices: never; today: { places: { project: string; worktree?: string }[] } };
  /** The popover as `scopedPopover` sends it: with its selects, and the scope each breakdown row narrows to. */
  const scoped = (u: Loose) => ({
    ...u,
    selects: scopeSelects(u.scope, u.windowProject, u.choices),
    today: { ...u.today, places: u.today.places.map((p) => ({ ...p, ...(narrowScope(p, u.scope) ? { narrow: narrowScope(p, u.scope) } : {}) })) },
  });

  it('the 📊 popup picks a project and a worktree, and narrows from a breakdown row', async () => {
    const b = await board(LANES({ needs: [auth] }));
    const pop = b.win.document.getElementById('stats-pop')!;
    b.win.document.getElementById('stats')!.click();
    const choice = (project: string, label: string, worktrees: string[]) => ({
      project,
      kind: 'workspace',
      kindLabel: 'Acme',
      label,
      title: project,
      total: 1,
      totalText: '1',
      worktrees: worktrees.map((w) => ({ worktree: w, total: 1, totalText: '1' })),
    });
    const usage = {
      scope: { kind: 'project', project: '/w/ws' },
      windowProject: '/w/ws',
      choices: [choice('/w/ws', 'ws', ['main', 'feat-a']), choice('/x/other', 'other', ['main'])],
      periods: [{ label: 'Today', sessions: zeroT, devdesk: { ...zeroT, failed: 0 } }],
      today: day([
        { project: '/w/ws', kind: 'workspace', worktree: 'main', label: 'main', title: '/w/ws', share: 0, ...zeroT },
        { project: '/w/ws', kind: 'workspace', worktree: 'feat-a', label: 'feat-a', title: '/w/ws · feat-a', share: 100, ...zeroT },
      ]),
    };
    await b.host({ type: 'usage', usage: scoped(usage as never) });
    const [project, worktree] = [...pop.querySelectorAll('select')] as HTMLSelectElement[];
    expect([...project.options].map((o) => o.textContent)).toEqual(['ws (this window) · Acme', 'All projects', 'other · Acme']);
    expect([...worktree.options].map((o) => o.textContent)).toEqual(['All worktrees', 'main', 'feat-a']);
    expect(pop.textContent).toContain('Today by worktree');
    expect(pop.textContent).not.toContain('DevDesk insights');
    worktree.value = 'feat-a';
    worktree.dispatchEvent(new b.win.Event('change'));
    expect(b.posted).toContainEqual({ type: 'usageScope', scope: { kind: 'project', project: '/w/ws', worktree: 'feat-a' } });
    project.value = '__all__';
    project.dispatchEvent(new b.win.Event('change'));
    expect(b.posted).toContainEqual({ type: 'usageScope', scope: { kind: 'all' } });
    const before = b.posted.length;
    (pop.querySelectorAll('.stats-place')[1] as HTMLElement).click();
    expect(b.posted.slice(before)).toEqual([{ type: 'usageScope', scope: { kind: 'project', project: '/w/ws', worktree: 'feat-a' } }]);
    expect(pop.hidden).toBe(false);
  });

  it('under All projects, shows DevDesk insights and a breakdown by project whose DevDesk row does not narrow, and keeps the focused select', async () => {
    const b = await board(LANES({ needs: [auth] }));
    const pop = b.win.document.getElementById('stats-pop')!;
    b.win.document.getElementById('stats')!.click();
    const usage = {
      scope: { kind: 'all' },
      windowProject: '/w/ws',
      choices: [{ project: '/w/ws', kind: 'git', kindLabel: 'git', label: 'ws', title: '/w/ws', total: 1, totalText: '1', worktrees: [{ worktree: 'main', total: 1, totalText: '1' }] }],
      periods: [{ label: 'Today', sessions: zeroT, devdesk: { ...zeroT, failed: 0 } }],
      today: day([
        { project: '/w/ws', kind: 'git', label: 'ws', title: '/w/ws', share: 60, ...zeroT },
        { project: '(DevDesk)', kind: 'folder', label: 'DevDesk insights', title: 'DevDesk', share: 40, ...zeroT },
      ]),
    };
    await b.host({ type: 'usage', usage: scoped(usage as never) });
    expect(pop.textContent).toContain('Today by project');
    expect(pop.textContent).toContain('DevDesk insights (Haiku)');
    const selects = pop.querySelectorAll('select');
    expect(selects.length).toBe(1);
    expect([...selects[0].options].map((o) => o.textContent)).toEqual(['ws (this window) · git', 'All projects']);
    expect(selects[0].value).toBe('__all__');
    const rows = pop.querySelectorAll('.stats-place');
    expect(rows.length).toBe(1);
    const before = b.posted.length;
    (rows[0] as HTMLElement).click();
    expect(b.posted.slice(before)).toEqual([{ type: 'usageScope', scope: { kind: 'project', project: '/w/ws' } }]);
    selects[0].focus();
    await b.host({ type: 'usage', usage: scoped(usage as never) });
    const again = pop.querySelector('select')!;
    expect(again).not.toBe(selects[0]);
    expect(b.win.document.activeElement).toBe(again);
  });

  it('labels rows that narrow as buttons, keeps All worktrees on a one-worktree scope, and keeps focus in the popup when its element goes', async () => {
    const b = await board(LANES({ needs: [auth] }));
    const pop = b.win.document.getElementById('stats-pop')!;
    b.win.document.getElementById('stats')!.click();
    const ws = { project: '/w/ws', kind: 'git', kindLabel: 'git', label: 'ws', title: '/w/ws', total: 1, totalText: '1', worktrees: [{ worktree: 'main', total: 1, totalText: '1' }] };
    const base = { windowProject: '/w/ws', choices: [ws], periods: [{ label: 'Today', sessions: zeroT, devdesk: { ...zeroT, failed: 0 } }] };
    const all = { ...base, scope: { kind: 'all' }, today: day([{ project: '/w/ws', kind: 'git', label: 'ws', title: '/w/ws', share: 100, ...zeroT }]) };
    await b.host({ type: 'usage', usage: scoped(all as never) });
    const row = pop.querySelector('.stats-place') as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('aria-label')).toBe('Show ws: 0 total, 0 cached, 100%');
    row.focus();
    row.dispatchEvent(new b.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(b.posted).toContainEqual({ type: 'usageScope', scope: { kind: 'project', project: '/w/ws' } });
    const one = { ...base, scope: { kind: 'project', project: '/w/ws', worktree: 'main' }, today: day([]) };
    await b.host({ type: 'usage', usage: scoped(one as never) });
    expect(b.win.document.activeElement).toBe(pop.querySelector('select[aria-label="Project"]'));
    const wt = pop.querySelector('select[aria-label="Worktree"]') as HTMLSelectElement;
    expect([...wt.options].map((o) => o.textContent)).toEqual(['All worktrees', 'main']);
    expect(wt.value).toBe('main');
    wt.focus();
    wt.value = '';
    wt.dispatchEvent(new b.win.Event('change'));
    expect(b.posted).toContainEqual({ type: 'usageScope', scope: { kind: 'project', project: '/w/ws' } });
    await b.host({ type: 'usage', usage: scoped({ ...one, scope: { kind: 'project', project: '/w/ws' } } as never) });
    expect(pop.querySelector('select[aria-label="Worktree"]')).toBeNull();
    expect(b.win.document.activeElement).toBe(pop.querySelector('select[aria-label="Project"]'));
  });
});

describe('board search box: ✨ search', () => {
  it('Enter asks the extension; ✨ spins until the answer, which filters in place with reasons', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser], hidden: [old] }));
    await b.type('the flaky one');
    await b.key('Enter');
    expect(b.posted.filter((m) => m.type === 'search')).toEqual([{ type: 'search', query: 'the flaky one' }]);
    expect(b.win.document.getElementById('ask')!.classList.contains('busy')).toBe(true);
    expect(b.banner().textContent).toContain('Searching');
    await b.host({ type: 'searchResult', query: 'the flaky one', matches: [{ id: 'o', reason: 'An old auth spike' }, { id: 'p', reason: 'Benchmarks' }], note: 'Two old ones' });
    expect(b.win.document.getElementById('ask')!.classList.contains('busy')).toBe(false);
    // Attention order (lane order), not the model's order; a hidden parked one shows.
    expect(b.shown()).toEqual(['p', 'o']);
    const reasons = [...b.win.document.querySelectorAll('#lanes .card .reason')].map((r) => r.textContent);
    expect(reasons).toEqual(['✨ Benchmarks', '✨ An old auth spike']);
    expect(b.banner().textContent).toContain('✨ 2 sessions');
    expect(b.banner().textContent).toContain('Two old ones');
  });

  it('the ✨ button asks too; an empty box asks nothing', async () => {
    const b = await board(LANES({ needs: [auth] }));
    (b.win.document.getElementById('ask') as HTMLButtonElement).click();
    expect(b.posted.some((m) => m.type === 'search')).toBe(false);
    await b.type('auth');
    (b.win.document.getElementById('ask') as HTMLButtonElement).click();
    expect(b.posted.filter((m) => m.type === 'search').length).toBe(1);
  });

  it('keeps the matches when the board is posted again', async () => {
    const lanes = LANES({ needs: [auth], review: [parser] });
    const b = await board(lanes);
    await b.type('q');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: 'r' }] });
    const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: [] };
    await b.host({ type: 'board', loaded: true, board: { lanes, needYou: 0, working: 0, worktrees: [] }, composer });
    expect(b.shown()).toEqual(['a']);
  });

  it('drops an answer to an older query, and typing goes back to the as-you-type filter', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('first');
    await b.key('Enter');
    await b.type('parser');
    expect(b.posted.filter((m) => m.type !== 'keep').at(-1)).toEqual({ type: 'cancelSearch' });
    await b.host({ type: 'searchResult', query: 'first', matches: [{ id: 'a', reason: 'r' }] });
    expect(b.shown()).toEqual(['p']);
    expect(b.win.document.querySelector('.reason')).toBeNull();
  });

  it('Escape while it searches cancels; Clear in the banner empties the search', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('q');
    await b.key('Enter');
    await b.key('Escape');
    expect(b.posted.filter((m) => m.type !== 'keep').at(-1)).toEqual({ type: 'cancelSearch' });
    expect(b.input.value).toBe('');
    await b.type('q');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: 'r' }] });
    (b.banner().querySelector('button') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(b.input.value).toBe('');
    expect(b.shown()).toEqual(['a', 'p']);
    expect(b.banner().hidden).toBe(true);
  });

  it('shows a failure in the banner and keeps the as-you-type filter', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('parser');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'parser', error: 'timed out after 30s' });
    expect(b.banner().textContent).toContain('✨ search failed: timed out after 30s');
    expect(b.shown()).toEqual(['p']);
  });

  it('a failure after an answer drops the answer: the as-you-type filter applies again, without reasons', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('parser');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'parser', matches: [{ id: 'a', reason: 'Because' }] });
    expect(b.shown()).toEqual(['a']);
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'parser', error: 'timed out after 30s' });
    expect(b.shown()).toEqual(['p']);
    expect(b.win.document.querySelectorAll('#lanes .reason').length).toBe(0);
    expect(b.banner().textContent).toContain('✨ search failed: timed out after 30s');
  });

  it('shows model text as text, never as HTML', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.type('q');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: '<img src=x onerror=alert(1)>' }], note: '<b>bold</b>' });
    expect(b.win.document.querySelector('#lanes img, #search-banner b')).toBeNull();
    expect(b.win.document.querySelector('.reason')!.textContent).toBe('✨ <img src=x onerror=alert(1)>');
  });

  it('a long query cut on whitespace is answered under the same string the extension echoes', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.type('a'.repeat(499) + ' b');
    await b.key('Enter');
    const sent = b.posted.find((m) => m.type === 'search')!.query as string;
    expect(sent).toBe('a'.repeat(499));
    await b.host({ type: 'searchResult', query: sent, matches: [{ id: 'a', reason: 'r' }] });
    expect(b.win.document.getElementById('ask')!.classList.contains('busy')).toBe(false);
    expect(b.shown()).toEqual(['a']);
  });
});

const hhit = (id: string, title: string, o: Record<string, unknown> = {}) => ({ id, title, worktree: 'main', ago: '3d', at: 1000, excerpts: [{ text: `the auth token expired for ${title}`, spans: [[4, 8]] }], files: ['/w/a.ts'], score: 1, ...o });
const historyCards = (b: Awaited<ReturnType<typeof board>>) => [...b.win.document.querySelectorAll<HTMLElement>('#lanes .lane.history .card[data-history]')].map((c) => c.dataset.history);

describe('board search box: history lane', () => {
  it('asks for history 120 ms after typing, shows the newest first, and drops stale answers', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.type('auth');
    await b.type('auth t');
    await new Promise((r) => setTimeout(r, 160));
    const queries = b.posted.filter((m) => m.type === 'historyQuery');
    expect(queries).toEqual([{ type: 'historyQuery', query: 'auth t', seq: queries[0].seq }]);
    const seq = queries[0].seq as number;
    await b.host({ type: 'historyResults', seq: seq - 1, query: 'auth', results: [hhit('stale', 'Stale')] });
    expect(historyCards(b)).toEqual([]);
    await b.host({ type: 'historyResults', seq, query: 'auth t', results: [hhit('old', 'Old', { at: 1 }), hhit('new', 'New', { at: 9 })] });
    expect(historyCards(b)).toEqual(['new', 'old']);
    expect(b.win.document.querySelector('.lane.history h2')!.textContent).toContain('Found in history');
  });

  it('highlights matches as text, never as HTML', async () => {
    const b = await board(LANES({}));
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    const seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query: 'auth', results: [hhit('x', '<img src=x onerror=alert(1)>', { excerpts: [{ text: '<b>auth</b> here', spans: [[3, 7]] }] })] });
    const card = b.win.document.querySelector('.card.history')!;
    expect(card.querySelector('img, b')).toBeNull();
    expect([...card.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['auth']);
    expect(card.textContent).toContain('<b>auth</b> here');
  });

  it('goes away when the box is cleared, and is hidden when history is off', async () => {
    const b = await board(LANES({}));
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    let seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query: 'auth', results: [hhit('x', 'X')] });
    await b.type('');
    expect(b.win.document.querySelector('.lane.history')).toBeNull();
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query: 'auth', results: [], off: true });
    expect(b.win.document.querySelector('.lane.history')).toBeNull();
  });

  it('tells the extension to drop its history query when the box is cleared (typed away or Escape)', async () => {
    const b = await board(LANES({}));
    const queries = () => b.posted.filter((m) => m.type === 'historyQuery').map((m) => m.query);
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    await b.type('');
    expect(queries()).toEqual(['auth', '']);
    await b.type('');
    expect(queries()).toEqual(['auth', '']);
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    await b.key('Escape');
    expect(queries()).toEqual(['auth', '', 'auth', '']);
  });

  it('shows a past session\'s hover (title, matches, files), kept up as answers come, and hides it when the pointer leaves', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await answer(b, 'auth', { results: [hhit('a', 'Past auth')] }); // the same id as the board card `a`
    const doc = b.win.document;
    const card = doc.querySelector<HTMLElement>('.card[data-history="a"]')!;
    const hover = doc.querySelector('.hovercard') as HTMLElement;
    card.dispatchEvent(new b.win.MouseEvent('pointerover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(hover.hidden).toBe(false);
    expect(hover.querySelector('.hc-title')!.textContent).toBe('Past auth');
    expect([...hover.querySelectorAll('.hc-label')].map((x) => x.textContent)).toEqual(['Matches', 'Files']);
    const seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query: 'auth', results: [hhit('a', 'Past auth, renamed')] });
    expect(hover.hidden).toBe(false);
    expect(hover.querySelector('.hc-title')!.textContent).toBe('Past auth, renamed');
    doc.querySelector('.card[data-history="a"]')!.dispatchEvent(new b.win.MouseEvent('pointerout', { bubbles: true, relatedTarget: doc.body }));
    await new Promise((r) => setTimeout(r, 100));
    expect(hover.hidden).toBe(true);
  });

  it('shows each excerpt of a past session\'s hover as its own row, matches marked as text, and the files on their own row', async () => {
    const b = await board(LANES({}));
    const excerpts = [
      { text: 'the <i>auth</i> token', spans: [[7, 11]] },
      { text: 'auth again, and auth', spans: [[0, 4], [16, 20]] },
    ];
    await answer(b, 'auth', { results: [hhit('x', 'X', { excerpts, files: ['/w/src/a.ts', '/w/src/b.ts'] })] });
    const doc = b.win.document;
    doc.querySelector<HTMLElement>('.card[data-history="x"]')!.dispatchEvent(new b.win.MouseEvent('pointerover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const hover = doc.querySelector('.hovercard') as HTMLElement;
    const rows = [...hover.querySelectorAll('.hc-row')];
    expect(rows.map((r) => r.querySelector('.hc-label')!.textContent)).toEqual(['Matches', 'Files']);
    const lines = [...rows[0].querySelectorAll('.hc-excerpt')];
    expect(lines.map((l) => l.textContent)).toEqual(['the <i>auth</i> token', 'auth again, and auth']);
    expect(lines.map((l) => [...l.querySelectorAll('mark')].map((m) => m.textContent))).toEqual([['auth'], ['auth', 'auth']]);
    expect(hover.querySelector('i')).toBeNull();
    expect(rows[1].querySelector('.hc-text')!.textContent).toBe('a.ts, b.ts');
  });

  it('shows the indexing note', async () => {
    const b = await board(LANES({}));
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    const seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query: 'auth', results: [], indexing: { indexed: 3, total: 10 } });
    expect(b.win.document.querySelector('.lane.history')!.textContent).toContain('Indexing history… (3 of 10 sessions)');
  });

  it('Resume, Fork, Copy id and Enter post the history actions', async () => {
    const b = await board(LANES({}));
    await b.type('auth');
    await new Promise((r) => setTimeout(r, 160));
    const seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query: 'auth', results: [hhit('h1', 'H1')] });
    const card = b.win.document.querySelector<HTMLElement>('.card.history')!;
    for (const [label, type] of [['▶ Resume', 'resumeHistory'], ['Fork', 'forkHistory'], ['Copy id', 'copyHistoryId']]) {
      [...card.querySelectorAll('button')].find((x) => x.textContent === label)!.click();
      expect(b.posted.at(-1)).toEqual({ type, id: 'h1' });
    }
    card.focus();
    await b.key('Enter', {}, card);
    expect(b.posted.at(-1)).toEqual({ type: 'resumeHistory', id: 'h1' });
  });

  it('shows ✨ history matches with reasons and counts them in the banner', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('q');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: 'r' }], historyMatches: [{ ...hhit('h1', 'H1'), reason: 'The old auth work' }] });
    expect(historyCards(b)).toEqual(['h1']);
    expect(b.win.document.querySelector('.card.history .reason')!.textContent).toBe('✨ The old auth work');
    expect(b.banner().textContent).toContain('✨ 1 on the board · 1 in history');
  });

  const answer = async (b: Awaited<ReturnType<typeof board>>, query: string, extra: Record<string, unknown>) => {
    await b.type(query);
    await new Promise((r) => setTimeout(r, 160));
    const seq = b.posted.filter((m) => m.type === 'historyQuery').at(-1)!.seq;
    await b.host({ type: 'historyResults', seq, query, results: [], ...extra });
  };

  it('a ✨ answer with no history picks shows no past sessions, not the typed results', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await answer(b, 'q', { results: [hhit('t1', 'T1'), hhit('t2', 'T2')] });
    expect(historyCards(b)).toEqual(['t1', 't2']);
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: 'r' }], historyMatches: [] });
    expect(historyCards(b)).toEqual([]);
    expect(b.win.document.querySelector('.lane.history')!.textContent).toContain('No past sessions match');
    expect(b.banner().textContent).toContain('✨ 1 session');
    expect(b.banner().textContent).not.toContain('in history');
  });

  it('says it is searching, with no count, until the first answer', async () => {
    const b = await board(LANES({}));
    await b.type('auth');
    const lane = b.win.document.querySelector('.lane.history')!;
    expect(lane.textContent).toContain('Searching history…');
    expect(lane.textContent).not.toContain('No past sessions match');
    expect(lane.querySelector('.count')!.textContent).toBe('');
  });

  it('keeps knowing history is off across a clear', async () => {
    const b = await board(LANES({}));
    await answer(b, 'auth', { off: true });
    await b.type('');
    await b.type('auth');
    expect(b.win.document.querySelector('.lane.history')).toBeNull();
  });

  it('shows a board card whose transcript has the words, with where, and applies its card\'s wt: and is: to it', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    const ex = { text: 'this is the ticket: https://issues.example.com/issues/V24', spans: [[20, 57]] };
    await answer(b, 'https://issues.example.com/issues/v24', { onBoard: [{ id: 'p', excerpt: ex }] });
    expect(b.shown()).toEqual(['p']);
    const card = b.win.document.querySelector<HTMLElement>('#lanes .card[data-session="p"]')!;
    expect(card.querySelector('.excerpt mark')!.textContent).toBe('https://issues.example.com/issues/V24');
    // Not listed again as a past session.
    expect(historyCards(b)).toEqual([]);
    // `wt:` and `is:` still go by the card: `parser` is in main and done.
    await answer(b, 'ticket wt:feat', { onBoard: [{ id: 'p', excerpt: ex }] });
    expect(b.shown()).toEqual([]);
    await answer(b, 'ticket is:review', { onBoard: [{ id: 'p', excerpt: ex }] });
    expect(b.shown()).toEqual(['p']);
  });

  it('does not show the transcript\'s excerpt on a card its own texts match', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await answer(b, 'auth', { onBoard: [{ id: 'a', excerpt: { text: 'auth in the transcript', spans: [[0, 4]] } }] });
    expect(b.shown()).toEqual(['a']);
    expect(b.win.document.querySelector('#lanes .card[data-session="a"] .excerpt')).toBeNull();
  });

  it('asks for history when the page reloads with a query', async () => {
    const b = await board(LANES({}), { query: 'auth' });
    await new Promise((r) => setTimeout(r, 160));
    expect(b.posted.filter((m) => m.type === 'historyQuery')).toEqual([{ type: 'historyQuery', query: 'auth', seq: expect.any(Number) }]);
  });

  it('a ✨ answer of only past sessions empties the board lanes and counts the history ones', async () => {
    const b = await board(LANES({ needs: [auth], review: [parser] }));
    await b.type('q');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [], historyMatches: [{ ...hhit('h1', 'H1'), reason: 'x' }, { ...hhit('h2', 'H2'), reason: 'y' }] });
    expect(b.shown()).toEqual([]);
    expect(historyCards(b).sort()).toEqual(['h1', 'h2']);
    expect(b.banner().textContent).toContain('✨ 0 on the board · 2 in history');
  });

  it('skips empty, inverted and overlapping spans, keeping the excerpt text whole', async () => {
    const b = await board(LANES({}));
    const ex = { text: 'auth then token here', spans: [[0, 4], [6, 6], [9, 7], [2, 8], [10, 15]] };
    await answer(b, 'auth', { results: [hhit('x', 'X', { excerpts: [ex] })] });
    const line = b.win.document.querySelector('.card.history .excerpt')!;
    expect(line.textContent).toBe(ex.text);
    expect([...line.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['auth', 'token']);
  });

  it('a query of only facets with no value (`wt:`) asks nothing and shows no history lane', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.type('wt:');
    await new Promise((r) => setTimeout(r, 160));
    expect(b.posted.filter((m) => m.type === 'historyQuery')).toEqual([]);
    expect(b.win.document.querySelector('.lane.history')).toBeNull();
  });

  it('a ✨ past session resumed leaves the lane, and shows as its board card once it is on the board', async () => {
    const b = await board(LANES({ needs: [auth] }));
    await b.type('q');
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: 'r' }], historyMatches: [{ ...hhit('h1', 'H1'), reason: 'old' }, { ...hhit('h2', 'H2'), reason: 'other' }] });
    const card = b.win.document.querySelector<HTMLElement>('.card.history[data-history="h1"]')!;
    [...card.querySelectorAll('button')].find((x) => x.textContent === '▶ Resume')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(historyCards(b)).toEqual(['h2']);
    const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: [] };
    await b.host({ type: 'board', loaded: true, board: { lanes: LANES({ needs: [auth, session('h1', 'H1 resumed')] }), needYou: 0, working: 0, worktrees: [] }, composer });
    expect(b.shown()).toEqual(['a', 'h1']);
  });

  it('applies the Worktree filter to past sessions, typed and ✨', async () => {
    const b = await board(LANES({ needs: [auth] }), { filter: 'feat-a' });
    await answer(b, 'q', { results: [hhit('m', 'M'), hhit('f', 'F', { worktree: 'feat-a' })] });
    expect(historyCards(b)).toEqual(['f']);
    await b.key('Enter');
    await b.host({ type: 'searchResult', query: 'q', matches: [{ id: 'a', reason: 'r' }], historyMatches: [{ ...hhit('m', 'M'), reason: 'x' }, { ...hhit('f', 'F', { worktree: 'feat-a' }), reason: 'y' }] });
    expect(historyCards(b)).toEqual(['f']);
    expect(b.banner().textContent).toContain('1 on the board · 1 in history');
  });
});

describe('board.css: history cards', () => {
  const css = readFileSync(join(ROOT, 'media/board.css'), 'utf8');
  const rules = (selector: string) => css.split('\n').filter((l) => l.startsWith(`${selector} {`));
  it('has one `.card .meta` rule, and ends a long worktree name on a history card in an ellipsis', () => {
    expect(rules('.card .meta')).toHaveLength(1);
    expect(rules('.lane.history .card .meta').join('')).toMatch(/text-overflow: ellipsis/);
  });

  it('folds the lanes a query empties, and lets history buttons wrap whole', () => {
    expect(rules('.lane.collapsed').join('')).toMatch(/flex: 0 0 auto/);
    expect(rules('.acts').join('')).toMatch(/flex-wrap: wrap/);
    expect(rules('.lane.history .acts .act').join('')).toMatch(/max-width: 100%/);
  });
});
