import { basename } from 'node:path';
import { formatTokens } from './usage';
import { addDays, addTokens, type DayUsage, type HistoryInfo, noTokens, type PlaceGroup, placesOf, type UsagePage, type UsagePopover, usagePage, usagePopover } from './usageHistory';
import { DEVDESK, OTHER, type Place, type PlaceKind, placeKindLabel, projectLabels, projectTitle, UNKNOWN } from './usagePlace';

/**
 * Which usage the 📊 popup and the Claude Usage page show: every project's, or one project's (one of its worktrees'
 * with `worktree`). A project's never includes DevDesk's own calls.
 */
export type UsageScope = { kind: 'all' } | { kind: 'project'; project: string; worktree?: string };
export const ALL_SCOPE: UsageScope = { kind: 'all' };

/** A scope sent by a webview (or kept in the window's state), checked field by field. DevDesk's calls are never a scope. */
export function parseScope(v: unknown): UsageScope | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind === 'all') return ALL_SCOPE;
  if (o.kind !== 'project' || typeof o.project !== 'string' || !o.project || o.project === DEVDESK || o.project.length > 4096) return undefined;
  return typeof o.worktree === 'string' && o.worktree ? { kind: 'project', project: o.project, worktree: o.worktree.slice(0, 256) } : { kind: 'project', project: o.project };
}

/** The scope a window shows: the one chosen in it, else the window's project (setting `devdesk.usage.defaultScope`). */
export function resolveScope(stored: UsageScope | undefined, defaultScope: 'project' | 'all', windowPlace: Place | undefined): UsageScope {
  if (stored) return stored;
  return defaultScope === 'project' && windowPlace ? { kind: 'project', project: windowPlace.project } : ALL_SCOPE;
}

const groupOf = (scope: UsageScope): PlaceGroup => (scope.kind === 'all' ? 'project' : 'worktree');

/** The days as a scope sees them: for a project, only its places' tokens, models and sessions, and no DevDesk calls. */
export function scopeDays(days: readonly DayUsage[], scope: UsageScope): DayUsage[] {
  if (scope.kind === 'all') return [...days];
  return days.map((d) => {
    const rows = placesOf(d).filter((p) => p.project === scope.project && (!scope.worktree || p.worktree === scope.worktree));
    const sessions = noTokens();
    for (const p of rows) addTokens(sessions, p.tokens);
    // `sumDays` adds up models and sessions that appear in more than one place.
    return { day: d.day, sessions, byModel: rows.flatMap((p) => p.byModel), bySession: rows.flatMap((p) => p.bySession), devdesk: { ...noTokens(), failed: 0 }, byPlace: rows };
  });
}

export interface ProjectChoice {
  project: string;
  kind: PlaceKind;
  /** How the views name `kind`. */
  kindLabel: string;
  label: string;
  title: string;
  total: number;
  totalText: string;
  /** `main` first, then by total. */
  worktrees: { worktree: string; total: number; totalText: string }[];
}

/**
 * The projects to choose from, with their worktrees and totals over `days`: the window's first, then by total, then
 * the Unknown project and the other projects; never DevDesk. The window's project and the chosen one are there even
 * with no usage; the chosen one's kind then comes from `known` (every stored day), else it is a folder.
 */
export function scopeChoices(days: readonly DayUsage[], scope: UsageScope, windowPlace: Place | undefined, known: readonly DayUsage[] = days): ProjectChoice[] {
  const projects = new Map<string, { kind: PlaceKind; total: number; worktrees: Map<string, number> }>();
  const entry = (project: string, kind: PlaceKind) => {
    let e = projects.get(project);
    if (!e) projects.set(project, (e = { kind, total: 0, worktrees: new Map() }));
    return e;
  };
  for (const d of days) {
    for (const p of placesOf(d)) {
      if (p.project === DEVDESK) continue;
      const e = entry(p.project, p.kind);
      e.total += p.tokens.total;
      e.worktrees.set(p.worktree, (e.worktrees.get(p.worktree) ?? 0) + p.tokens.total);
    }
  }
  if (windowPlace) entry(windowPlace.project, windowPlace.kind);
  if (scope.kind === 'project' && scope.project !== DEVDESK) {
    const project = scope.project;
    const e = projects.get(project) ?? entry(project, known.flatMap(placesOf).find((p) => p.project === project)?.kind ?? 'folder');
    if (scope.worktree && !e.worktrees.has(scope.worktree)) e.worktrees.set(scope.worktree, 0);
  }
  const last = (p: string) => (p === UNKNOWN ? 1 : p === OTHER ? 2 : 0);
  const order = [...projects.keys()].sort(
    (a, b) => Number(b === windowPlace?.project) - Number(a === windowPlace?.project) || last(a) - last(b) || projects.get(b)!.total - projects.get(a)!.total || basename(a).localeCompare(basename(b)),
  );
  const labels = projectLabels(order);
  return order.map((project) => {
    const e = projects.get(project)!;
    const worktrees = [...e.worktrees]
      .sort(([a, x], [b, y]) => Number(b === 'main') - Number(a === 'main') || y - x || a.localeCompare(b))
      .map(([worktree, total]) => ({ worktree, total, totalText: formatTokens(total) }));
    return { project, kind: e.kind, kindLabel: placeKindLabel(e.kind), label: labels.get(project)!, title: projectTitle(project), total: e.total, totalText: formatTokens(e.total), worktrees };
  });
}

export interface ScopeView {
  scope: UsageScope;
  /** The window's project, as places name it (undefined with no folder open). */
  windowProject?: string;
  choices: ProjectChoice[];
}

export type ScopedPopover = UsagePopover & ScopeView;
export type ScopedPage = UsagePage & ScopeView;

/** The 📊 popover for a scope; its choices are the last 30 days' projects. */
export function scopedPopover(days: readonly DayUsage[], today: string, scope: UsageScope, windowPlace: Place | undefined): ScopedPopover {
  const recent = days.filter((d) => d.day >= addDays(today, -29));
  return { ...usagePopover(scopeDays(days, scope), today, 5, groupOf(scope)), scope, windowProject: windowPlace?.project, choices: scopeChoices(recent, scope, windowPlace, days) };
}

/** The Claude Usage page for a scope; its choices are every stored day's projects. */
export function scopedPage(days: readonly DayUsage[], today: string, history: HistoryInfo, scope: UsageScope, windowPlace: Place | undefined): ScopedPage {
  return { ...usagePage(scopeDays(days, scope), today, history, groupOf(scope)), scope, windowProject: windowPlace?.project, choices: scopeChoices(days, scope, windowPlace) };
}
