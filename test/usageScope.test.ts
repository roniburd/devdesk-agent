import { describe, expect, it } from 'vitest';
import type { DayUsage, PlaceDay } from '../src/core/usageHistory';
import { DEVDESK, type Place, UNKNOWN } from '../src/core/usagePlace';
import { ALL_SCOPE, narrowScope, parseScope, type ProjectChoice, resolveScope, scopeChoices, scopedPage, scopedPopover, scopeDays, scopeSelects } from '../src/core/usageScope';

const t = (total: number, requests = 1) => ({ total, cached: 0, requests });
const place = (project: string, worktree: string, total: number, session: string, kind: PlaceDay['kind'] = 'git'): PlaceDay => ({
  project,
  kind,
  worktree,
  tokens: t(total),
  byModel: [{ model: project === DEVDESK ? 'haiku (DevDesk)' : 'opus', tokens: t(total) }],
  bySession: project === DEVDESK ? [] : [{ sessionId: session, name: session, ...t(total) }],
});
const day = (key: string, places: PlaceDay[]): DayUsage => {
  const sessions = places.filter((p) => p.project !== DEVDESK).reduce((n, p) => n + p.tokens.total, 0);
  const devdesk = places.filter((p) => p.project === DEVDESK).reduce((n, p) => n + p.tokens.total, 0);
  return {
    day: key,
    sessions: t(sessions, places.length),
    byModel: places.flatMap((p) => p.byModel),
    bySession: places.flatMap((p) => p.bySession),
    devdesk: { ...t(devdesk), failed: 0 },
    byPlace: places,
  };
};
const today = '2026-11-04';
const days = [
  day('2026-11-03', [place('/w/ws', 'main', 100, 'a', 'workspace'), place('/w/ws', 'feat-a', 40, 'b', 'workspace'), place('/x/other', 'main', 10, 'c', 'folder')]),
  day(today, [place('/w/ws', 'feat-a', 5, 'b', 'workspace'), place(DEVDESK, 'main', 7, '', 'folder')]),
  // Stored before places were counted.
  { day: '2026-11-02', sessions: t(1000), byModel: [{ model: 'opus', tokens: t(1000) }], bySession: [], devdesk: { ...t(0, 0), failed: 0 } },
];
const ws: Place = { project: '/w/ws', kind: 'workspace', worktree: 'main' };

describe('scopes', () => {
  it('parses only well-formed scopes from webviews', () => {
    expect(parseScope({ kind: 'all' })).toEqual(ALL_SCOPE);
    expect(parseScope({ kind: 'project', project: '/w/ws', worktree: 'feat-a' })).toEqual({ kind: 'project', project: '/w/ws', worktree: 'feat-a' });
    expect(parseScope({ kind: 'project', project: '/w/ws', worktree: '' })).toEqual({ kind: 'project', project: '/w/ws' });
    expect(parseScope({ kind: 'project', project: '' })).toBeUndefined();
    expect(parseScope({ kind: 'project', project: DEVDESK })).toBeUndefined();
    expect(parseScope('all')).toBeUndefined();
  });

  it('starts on the window’s project unless set to all or no folder is open', () => {
    expect(resolveScope(undefined, 'project', ws)).toEqual({ kind: 'project', project: '/w/ws' });
    expect(resolveScope(undefined, 'all', ws)).toEqual(ALL_SCOPE);
    expect(resolveScope(undefined, 'project', undefined)).toEqual(ALL_SCOPE);
    expect(resolveScope({ kind: 'project', project: '/x/other' }, 'project', ws)).toEqual({ kind: 'project', project: '/x/other' });
    // The scope chosen in the window wins over the setting, both ways.
    expect(resolveScope({ kind: 'project', project: '/x/other' }, 'all', ws)).toEqual({ kind: 'project', project: '/x/other' });
    expect(resolveScope(ALL_SCOPE, 'project', ws)).toEqual(ALL_SCOPE);
  });

  it('restricts days to a project or one of its worktrees, without DevDesk’s calls', () => {
    const project = scopeDays(days, { kind: 'project', project: '/w/ws' });
    expect(project.map((d) => [d.day, d.sessions.total, d.devdesk.total])).toEqual([
      ['2026-11-03', 140, 0],
      [today, 5, 0],
      ['2026-11-02', 0, 0],
    ]);
    expect(project[0].bySession.map((s) => s.sessionId)).toEqual(['a', 'b']);
    const wt = scopeDays(days, { kind: 'project', project: '/w/ws', worktree: 'feat-a' });
    expect(wt.map((d) => d.sessions.total)).toEqual([40, 5, 0]);
    expect(scopeDays(days, ALL_SCOPE)).toEqual(days);
    // The old day's usage is the Unknown project's.
    expect(scopeDays(days, { kind: 'project', project: UNKNOWN }).map((d) => d.sessions.total)).toEqual([0, 0, 1000]);
  });

  it('offers the window’s project first, then the others by usage, Unknown last, and never DevDesk', () => {
    const choices = scopeChoices(days, ALL_SCOPE, ws);
    expect(choices.map((c) => [c.label, c.total])).toEqual([
      ['ws', 145],
      ['other', 10],
      ['Unknown project', 1000],
    ]);
    expect(choices[0].worktrees.map((w) => [w.worktree, w.total])).toEqual([
      ['main', 100],
      ['feat-a', 45],
    ]);
  });

  it('still offers a chosen project with no usage in the range', () => {
    const choices = scopeChoices(days, { kind: 'project', project: '/gone/proj' }, ws);
    expect(choices.find((c) => c.project === '/gone/proj')).toMatchObject({ label: 'proj', total: 0 });
  });

  it('keeps the kind of a chosen project with no usage in the range, from the stored days', () => {
    const recent = days.filter((d) => d.day === today);
    const old = scopeChoices(recent, { kind: 'project', project: '/x/other' }, ws, days);
    expect(old.find((c) => c.project === '/x/other')).toMatchObject({ kind: 'folder', total: 0 });
    const choices = scopeChoices([], { kind: 'project', project: '/w/ws' }, undefined, days);
    expect(choices.find((c) => c.project === '/w/ws')).toMatchObject({ kind: 'workspace', total: 0 });
    // A popover's choices are the last 30 days', their kinds every stored day's.
    const pop = scopedPopover([day('2026-09-01', [place('/r/repo', 'main', 1, 'c', 'git')]), ...days], today, { kind: 'project', project: '/r/repo' }, ws);
    expect(pop.choices.find((c) => c.project === '/r/repo')).toMatchObject({ kind: 'git', total: 0 });
  });

  it('never offers DevDesk, even as the chosen scope', () => {
    expect(scopeChoices(days, { kind: 'project', project: DEVDESK }, ws).map((c) => c.project)).not.toContain(DEVDESK);
  });

  it('breaks the popover down by project for all, by worktree for a project', () => {
    const all = scopedPopover(days, today, ALL_SCOPE, ws);
    expect(all.today.places.map((p) => [p.label, p.total])).toEqual([
      ['DevDesk insights', 7],
      ['ws', 5],
    ]);
    const mine = scopedPopover(days, today, { kind: 'project', project: '/w/ws' }, ws);
    expect(mine.scope).toEqual({ kind: 'project', project: '/w/ws' });
    expect(mine.windowProject).toBe('/w/ws');
    expect(mine.periods[0].devdesk.total).toBe(0);
    expect(mine.today.places.map((p) => [p.worktree, p.label, p.total, p.share])).toEqual([['feat-a', 'feat-a', 5, 100]]);
    const page = scopedPage(days, today, { days: 2, bytes: 1, maxBytes: 10, keepDays: 365 }, { kind: 'project', project: '/w/ws' }, ws);
    const yesterday = page.units.day.find((p) => p.key === '2026-11-03')!;
    expect(yesterday.places.map((p) => [p.worktree, p.share])).toEqual([
      ['main', 71],
      ['feat-a', 29],
    ]);
  });
});

describe('the scope selects', () => {
  const choice = (project: string, label: string, worktrees: string[], kindLabel = 'git'): ProjectChoice => ({
    project,
    kind: 'git',
    kindLabel,
    label,
    title: project,
    total: 1,
    totalText: '1',
    worktrees: worktrees.map((worktree) => ({ worktree, total: 1, totalText: '1' })),
  });
  const ws = choice('/w/ws', 'ws', ['main', 'feat-a'], 'Acme');
  const other = choice('/x/other', 'other', ['main']);
  const unknown = choice(UNKNOWN, 'Unknown project', ['main']);
  const texts = (o: { options: { text: string }[] } | undefined) => o?.options.map((x) => x.text);

  it("lists this window's project first, then All projects and the others, the special ones without a kind", () => {
    const s = scopeSelects(ALL_SCOPE, '/w/ws', [ws, other, unknown]);
    expect(texts(s.project)).toEqual(['ws (this window) · Acme', 'All projects', 'other · git', 'Unknown project']);
    expect(s.project.value).toBe(s.project.options[1].value);
    expect(s.project.options.map((o) => o.scope)).toEqual([{ kind: 'project', project: '/w/ws' }, ALL_SCOPE, { kind: 'project', project: '/x/other' }, { kind: 'project', project: UNKNOWN }]);
    expect(s.worktree).toBeUndefined();
    // Not this window's: All projects first.
    expect(texts(scopeSelects(ALL_SCOPE, undefined, [ws, other]).project)).toEqual(['All projects', 'ws · Acme', 'other · git']);
  });

  it("offers the chosen project's worktrees when it has more than one, or one is chosen", () => {
    const s = scopeSelects({ kind: 'project', project: '/w/ws' }, '/w/ws', [ws, other]);
    expect(s.project.value).toBe('/w/ws');
    expect(texts(s.worktree)).toEqual(['All worktrees', 'main', 'feat-a']);
    expect(s.worktree!.value).toBe('');
    expect(s.worktree!.options.map((o) => o.scope)).toEqual([
      { kind: 'project', project: '/w/ws' },
      { kind: 'project', project: '/w/ws', worktree: 'main' },
      { kind: 'project', project: '/w/ws', worktree: 'feat-a' },
    ]);
    expect(scopeSelects({ kind: 'project', project: '/x/other' }, '/w/ws', [ws, other]).worktree).toBeUndefined();
    const one = scopeSelects({ kind: 'project', project: '/x/other', worktree: 'gone' }, '/w/ws', [ws, other]);
    expect(texts(one.worktree)).toEqual(['All worktrees', 'main', 'gone']);
    expect(one.worktree!.value).toBe('gone');
  });

  it('narrows from a breakdown row to its project or worktree, except for DevDesk, the other projects, or under a worktree', () => {
    expect(narrowScope({ project: '/w/ws' }, ALL_SCOPE)).toEqual({ kind: 'project', project: '/w/ws' });
    expect(narrowScope({ project: '/w/ws', worktree: 'feat-a' }, { kind: 'project', project: '/w/ws' })).toEqual({ kind: 'project', project: '/w/ws', worktree: 'feat-a' });
    expect(narrowScope({ project: DEVDESK }, ALL_SCOPE)).toBeUndefined();
    expect(narrowScope({ project: '*' }, ALL_SCOPE)).toBeUndefined();
    expect(narrowScope({ project: '/w/ws', worktree: 'main' }, { kind: 'project', project: '/w/ws', worktree: 'main' })).toBeUndefined();
  });
});
