// The Claude Usage page (media/usage.js) in jsdom: the page's own markup from src/usagePanel.ts, with the extension
// played by this test (it posts progress, partial pages and the final page).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { dayKey } from '../src/core/usageHistory';
import { scopedPage } from '../src/core/usageScope';

const ROOT = join(__dirname, '..');

function usageHtml(): string {
  const src = readFileSync(join(ROOT, 'src/usagePanel.ts'), 'utf8');
  const body = /<body>([\s\S]*?)<script/.exec(src)![1];
  return `<!DOCTYPE html><html><body>${body.replace(/\$\{[^}]*\}/g, '')}</body></html>`;
}

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

/** Opens the page; `saved` plays VS Code's webview state, kept across a hidden tab (what the page last `setState`). */
function open(saved: { state?: unknown } = {}) {
  dom = new JSDOM(usageHtml(), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown; acquireVsCodeApi: unknown };
  const posted: Array<Record<string, unknown>> = [];
  win.acquireVsCodeApi = () => ({
    getState: () => (saved.state === undefined ? undefined : structuredClone(saved.state)),
    setState: (s: unknown) => {
      saved.state = structuredClone(s);
    },
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  });
  win.eval(readFileSync(join(ROOT, 'media/usage.js'), 'utf8'));
  const main = win.document.getElementById('main')!;
  const send = async (m: unknown) => {
    win.postMessage(m, '*');
    await new Promise((r) => setTimeout(r, 20));
  };
  return { posted, main, send };
}

const today = dayKey(Date.now());
const page = () => scopedPage([], today, { days: 0, bytes: 0, maxBytes: 1, keepDays: 365 }, { kind: 'all' }, undefined);
const reading = {
  phase: 'reading',
  found: 900,
  listed: 900,
  files: 120,
  totalFiles: 900,
  bytes: 3 * 1024 ** 3,
  totalBytes: 12 * 1024 ** 3,
  savedDays: 4,
  savedThrough: '2026-10-21',
  elapsedMs: 95_000,
  etaMs: 240_000,
};

describe('the Claude Usage page', () => {
  it('asks for the page once loaded', () => {
    const { posted } = open();
    expect(posted).toContainEqual({ type: 'ready' });
  });

  it('says what a count is doing and how long it has left, then shows the days counted so far under it', async () => {
    const { main, send } = open();
    await send({ type: 'progress', progress: { ...reading, phase: 'listing', listed: 0, totalFiles: 0, bytes: 0, totalBytes: 0, savedThrough: undefined, etaMs: undefined, elapsedMs: 2000 } });
    expect(main.textContent).toContain('Listing Claude transcripts: 900 found');

    await send({ type: 'progress', progress: reading });
    expect(main.textContent).toContain('Reading 120 of 900 transcripts: 3.0 GB of 12.0 GB');
    expect(main.textContent).toContain('about 4 min left');
    expect(main.querySelector('progress')).not.toBeNull();

    await send({ type: 'partial', page: page(), progress: reading });
    expect(main.querySelector('.status')?.textContent).toContain('counted and shown below');
    expect(main.querySelector('.tiles')).not.toBeNull();

    await send({ type: 'page', page: page() });
    expect(main.querySelector('.status')).toBeNull();
    expect(main.querySelector('.tiles')).not.toBeNull();
  });

  it('shows nothing new for a count under a second', async () => {
    const { main, send } = open();
    await send({ type: 'progress', progress: { ...reading, elapsedMs: 100 } });
    expect(main.textContent).toBe('Counting tokens…');
  });

  it('chooses a project and a worktree, and shows the period by project or by worktree', async () => {
    const { main, posted, send } = open();
    const place = (project: string, worktree: string, total: number) => ({ project, kind: 'git' as const, worktree, tokens: { total, cached: 0, requests: 1 }, byModel: [], bySession: [] });
    const days = [{ day: today, sessions: { total: 15, cached: 0, requests: 2 }, byModel: [], bySession: [], devdesk: { total: 0, cached: 0, requests: 0, failed: 0 }, byPlace: [place('/w/a', 'main', 10), place('/w/b', 'x', 5)] }];
    const win = { project: '/w/a', kind: 'git' as const, worktree: 'main' };
    const info = { days: 0, bytes: 0, maxBytes: 1, keepDays: 365 };
    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'all' }, win) });
    const doc = main.ownerDocument;
    const project = doc.getElementById('scope-project') as HTMLSelectElement;
    expect([...project.options].map((o) => o.textContent)).toEqual(['a (this window) · git', 'All projects', 'b · git']);
    expect(main.textContent).toContain('Projects ·');
    project.value = '/w/b';
    project.dispatchEvent(new doc.defaultView!.Event('change'));
    expect(posted).toContainEqual({ type: 'setScope', scope: { kind: 'project', project: '/w/b' } });
    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'project', project: '/w/b' }, win) });
    expect(main.textContent).toContain('Worktrees ·');
    expect(main.textContent).not.toContain('DevDesk insights');
  });

  it("picks a project's worktree, and sorts the every-day table by a column", async () => {
    const { main, posted, send } = open();
    const place = (project: string, worktree: string, total: number) => ({ project, kind: 'git' as const, worktree, tokens: { total, cached: 0, requests: 1 }, byModel: [], bySession: [] });
    const day = (key: string, ...byPlace: ReturnType<typeof place>[]) => ({
      day: key,
      sessions: { total: byPlace.reduce((n, p) => n + p.tokens.total, 0), cached: 0, requests: byPlace.length },
      byModel: [],
      bySession: [],
      devdesk: { total: 0, cached: 0, requests: 0, failed: 0 },
      byPlace,
    });
    const yesterday = dayKey(Date.now() - 86_400_000);
    const days = [day(yesterday, place('/w/a', 'main', 30)), day(today, place('/w/a', 'feat', 10), place('/w/b', 'main', 50))];
    const win = { project: '/w/a', kind: 'git' as const, worktree: 'main' };
    const info = { days: 2, bytes: 0, maxBytes: 1, keepDays: 365 };
    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'project', project: '/w/a' }, win) });
    const doc = main.ownerDocument;
    const worktree = doc.getElementById('scope-worktree') as HTMLSelectElement;
    expect(worktree.hidden).toBe(false);
    expect([...worktree.options].map((o) => o.textContent)).toEqual(['All worktrees', 'main', 'feat']);
    worktree.value = 'feat';
    worktree.dispatchEvent(new doc.defaultView!.Event('change'));
    expect(posted).toContainEqual({ type: 'setScope', scope: { kind: 'project', project: '/w/a', worktree: 'feat' } });

    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'all' }, win) });
    expect(worktree.hidden).toBe(true);
    const every = () => [...main.querySelectorAll('details tbody tr')].slice(0, 3).map((r) => [...r.children].slice(1, 3).map((c) => c.textContent));
    // Newest first: today's projects, then yesterday's.
    expect(every()).toEqual([
      ['b', '50'],
      ['a', '10'],
      ['a', '30'],
    ]);
    const total = [...main.querySelectorAll('details th')].find((th) => th.textContent === 'Total') as HTMLElement;
    total.click();
    expect(total.getAttribute('aria-sort')).toBe('descending');
    expect(every()).toEqual([
      ['b', '50'],
      ['a', '30'],
      ['a', '10'],
    ]);
    total.click();
    expect(every()).toEqual([
      ['a', '10'],
      ['a', '30'],
      ['b', '50'],
    ]);
    // The period column's first click sorts oldest first (the table starts newest first).
    const period = [...main.querySelectorAll('details th')].find((th) => th.textContent === 'Day') as HTMLElement;
    period.click();
    expect(period.getAttribute('aria-sort')).toBe('ascending');
    expect(every()[0]).toEqual(['a', '30']);
  });

  it('keeps the every-day table open and sorted when the tab is hidden and shown again', async () => {
    const place = (project: string, total: number) => ({ project, kind: 'git' as const, worktree: 'main', tokens: { total, cached: 0, requests: 1 }, byModel: [], bySession: [] });
    const yesterday = dayKey(Date.now() - 86_400_000);
    const days = [yesterday, today].map((key, i) => ({
      day: key,
      sessions: { total: i ? 10 : 30, cached: 0, requests: 1 },
      byModel: [],
      bySession: [],
      devdesk: { total: 0, cached: 0, requests: 0, failed: 0 },
      byPlace: [place('/w/a', i ? 10 : 30)],
    }));
    const info = { days: 2, bytes: 0, maxBytes: 1, keepDays: 365 };
    const pageMsg = { type: 'page', page: scopedPage(days, today, info, { kind: 'project', project: '/w/a' }, undefined) };
    const saved = {};
    const first = open(saved);
    await first.send(pageMsg);
    const details = () => first.main.querySelector('details') as HTMLDetailsElement;
    details().open = true;
    details().dispatchEvent(new first.main.ownerDocument.defaultView!.Event('toggle'));
    const totals = (main: HTMLElement) => [...main.querySelectorAll('details tbody tr')].map((r) => r.children[1].textContent);
    expect(totals(first.main)).toEqual(['10', '30']);
    ([...first.main.querySelectorAll('details th')].find((th) => th.textContent === 'Total') as HTMLElement).click();
    expect(totals(first.main)).toEqual(['30', '10']);

    // VS Code drops a hidden webview (no retainContextWhenHidden) and loads it again with its state.
    dom!.window.close();
    const again = open(saved);
    await again.send(pageMsg);
    expect((again.main.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(totals(again.main)).toEqual(['30', '10']);
  });

  it('hides the Project select until a page arrives', async () => {
    const { main, send } = open();
    const select = () => main.ownerDocument.getElementById('scope-project') as HTMLSelectElement;
    expect(select().hidden).toBe(true);
    await send({ type: 'progress', progress: reading });
    expect(select().hidden).toBe(true);
    await send({ type: 'page', page: page() });
    expect(select().hidden).toBe(false);
  });

  it('labels a project the same in every period, with its path as the tooltip, and sorts empty periods last', async () => {
    const { main, send } = open();
    const place = (project: string, total: number) => ({ project, kind: 'git' as const, worktree: 'main', tokens: { total, cached: 0, requests: 1 }, byModel: [], bySession: [] });
    const day = (key: string, ...byPlace: ReturnType<typeof place>[]) => ({
      day: key,
      sessions: { total: byPlace.reduce((n, p) => n + p.tokens.total, 0), cached: 0, requests: byPlace.length },
      byModel: [],
      bySession: [],
      devdesk: { total: 0, cached: 0, requests: 0, failed: 0 },
      byPlace,
    });
    const ago = (n: number) => dayKey(Date.now() - n * 86_400_000);
    // /w/a and /v/a ran together two days ago, /w/a alone yesterday; nothing today.
    const days = [day(ago(2), place('/w/a', 30), place('/v/a', 20)), day(ago(1), place('/w/a', 10))];
    const info = { days: 2, bytes: 0, maxBytes: 1, keepDays: 365 };
    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'all' }, undefined) });
    const cells = () => [...main.querySelectorAll('details tbody tr')].map((r) => r.children[1] as HTMLElement);
    expect(cells().filter((c) => c.title === '/w/a').map((c) => c.textContent)).toEqual(['w/a', 'w/a']);
    // The project column takes the spare width and is cut with an ellipsis; the day column doesn't wrap.
    const first = main.querySelector('details tbody tr') as HTMLElement;
    expect([...first.children].slice(0, 2).map((c) => c.className)).toEqual(['text', 'name']);
    const project = [...main.querySelectorAll('details th')].find((th) => th.textContent === 'Project') as HTMLElement;
    project.click();
    expect(cells().slice(0, 3).map((c) => c.textContent)).toEqual(['v/a', 'w/a', 'w/a']);
    expect(cells()[cells().length - 1].textContent).toBe('—');
    project.click();
    expect(cells()[0].textContent).toBe('w/a');
    expect(cells()[cells().length - 1].textContent).toBe('—');
  });

  it('keeps the selects as they are while the pages it gets show the same choices', async () => {
    const { main, send } = open();
    const byPlace = [{ project: '/w/a', kind: 'git' as const, worktree: 'main', tokens: { total: 5, cached: 0, requests: 1 }, byModel: [], bySession: [] }];
    const days = [{ day: today, sessions: { total: 5, cached: 0, requests: 1 }, byModel: [], bySession: [], devdesk: { total: 0, cached: 0, requests: 0, failed: 0 }, byPlace }];
    const info = { days: 1, bytes: 0, maxBytes: 1, keepDays: 365 };
    const select = () => main.ownerDocument.getElementById('scope-project') as HTMLSelectElement;
    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'all' }, undefined) });
    const first = select().options[1];
    await send({ type: 'partial', page: scopedPage(days, today, info, { kind: 'all' }, undefined), progress: reading });
    expect(select().options[1]).toBe(first);
    await send({ type: 'page', page: scopedPage(days, today, info, { kind: 'project', project: '/w/a' }, undefined) });
    expect(select().options[1]).not.toBe(first);
  });
});
