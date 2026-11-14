import { basename, join } from 'node:path';
import { parseObject } from '../json';
import type { SessionCard } from '../sessions';
import { featureDirs, type Feature } from '../worktrees';

/**
 * The projects web access can switch between: `<stateDir>/web-v2/projects.json`, where every VS Code window with this
 * extension records its workspace root and when it last did. The daemon lists the roots recorded in the last
 * `devdesk.web.projectDays` days whose folder is still there, the one its Start came from first.
 */

export interface ProjectEntry {
  root: string;
  /** When a window last recorded it (ms since the epoch). */
  seenAt: number;
}

/** `devdesk.web.projectDays`' default. */
export const DEFAULT_PROJECT_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

export const projectsPath = (webDir: string) => join(webDir, 'projects.json');

/** The entries in projects.json; [] when it is missing or not projects.json. Later duplicates of a root are dropped. */
export function parseProjects(text: string): ProjectEntry[] {
  const list = parseObject(text)?.projects;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ProjectEntry[] = [];
  for (const e of list) {
    const r = e as Partial<ProjectEntry> | null;
    if (!r || typeof r.root !== 'string' || !r.root || typeof r.seenAt !== 'number' || !Number.isFinite(r.seenAt) || seen.has(r.root)) continue;
    seen.add(r.root);
    out.push({ root: r.root, seenAt: r.seenAt });
  }
  return out;
}

export function projectsJson(entries: readonly ProjectEntry[]): string {
  return `${JSON.stringify({ version: 1, projects: entries })}\n`;
}

/** `days` as milliseconds (0: none but the daemon's own project are served). */
export const projectMaxAgeMs = (days: number) => Math.max(0, days) * DAY_MS;

/** The entries recorded in the last `maxAgeMs` whose folder `exists`, newest first. */
export function recentProjects(entries: readonly ProjectEntry[], now: number, maxAgeMs: number, exists: (dir: string) => boolean): ProjectEntry[] {
  return entries.filter((e) => now - e.seenAt < maxAgeMs && exists(e.root)).sort((a, b) => b.seenAt - a.seenAt);
}

/** `entries` with `root` recorded at `now` (first), and the others gone or too old dropped. */
export function recordProject(entries: readonly ProjectEntry[], root: string, now: number, maxAgeMs: number, exists: (dir: string) => boolean): ProjectEntry[] {
  return [{ root, seenAt: now }, ...recentProjects(entries.filter((e) => e.root !== root), now, maxAgeMs, exists)];
}

/** The roots to serve: `first` (the daemon's own), then the recorded ones, once each. */
export function projectRoots(first: string | undefined, recorded: readonly string[]): string[] {
  return [...new Set([...(first ? [first] : []), ...recorded])];
}

/** A project as the daemon serves it: its root and its worktrees (discoverFeatures). */
export interface Project {
  root: string;
  features: Feature[];
}

/** What the page calls each project: the root's folder name, with its parent's when two share one. */
export function projectNames(roots: readonly string[]): Map<string, string> {
  const base = (r: string) => basename(r.replace(/\/+$/, '')) || r;
  const counts = new Map<string, number>();
  for (const r of roots) counts.set(base(r), (counts.get(base(r)) ?? 0) + 1);
  return new Map(roots.map((r) => {
    if ((counts.get(base(r)) ?? 0) < 2) return [r, base(r)];
    const parts = r.replace(/\/+$/, '').split('/');
    return [r, parts.slice(-2).join('/')];
  }));
}

const trim = (d: string) => d.replace(/\/+$/, '');
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** The root of the project `card` works in: the one whose folder (or worktree's) holds it most closely; undefined for none. */
export function projectOf(card: Pick<SessionCard, 'cwd' | 'featureDir'>, projects: readonly Project[]): string | undefined {
  const path = card.featureDir ?? card.cwd;
  if (!path) return undefined;
  let best: { root: string; length: number } | undefined;
  for (const p of projects) {
    for (const dir of [p.root, ...p.features.flatMap(featureDirs)].map(trim).filter(Boolean)) {
      if (within(trim(path), dir) && (!best || dir.length > best.length)) best = { root: p.root, length: dir.length };
    }
  }
  return best?.root;
}
