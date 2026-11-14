import { describe, expect, it } from 'vitest';
import {
  parseProjects,
  projectMaxAgeMs,
  projectNames,
  projectOf,
  projectRoots,
  projectsJson,
  recentProjects,
  recordProject,
} from '../../src/core/web/projects';
import type { Feature } from '../../src/core/worktrees';

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;
const all = () => true;

describe('projects.json', () => {
  it('round-trips, dropping bad entries and later duplicates', () => {
    const text = JSON.stringify({
      version: 1,
      projects: [{ root: '/a', seenAt: 1 }, { root: '/a', seenAt: 2 }, { root: '', seenAt: 3 }, { root: '/b' }, null, { root: '/c', seenAt: 4 }],
    });
    expect(parseProjects(text)).toEqual([{ root: '/a', seenAt: 1 }, { root: '/c', seenAt: 4 }]);
    expect(parseProjects(projectsJson([{ root: '/x', seenAt: 5 }]))).toEqual([{ root: '/x', seenAt: 5 }]);
  });

  it('is empty when missing or not projects.json', () => {
    expect(parseProjects('')).toEqual([]);
    expect(parseProjects('not json')).toEqual([]);
    expect(parseProjects('{"projects": 3}')).toEqual([]);
  });
});

describe('recentProjects', () => {
  it('keeps the recent ones whose folder is there, newest first', () => {
    const entries = [
      { root: '/old', seenAt: NOW - 15 * DAY },
      { root: '/a', seenAt: NOW - 2 * DAY },
      { root: '/gone', seenAt: NOW },
      { root: '/b', seenAt: NOW - DAY },
    ];
    expect(recentProjects(entries, NOW, projectMaxAgeMs(14), (d) => d !== '/gone').map((e) => e.root)).toEqual(['/b', '/a']);
  });

  it('keeps none with 0 days', () => {
    expect(recentProjects([{ root: '/a', seenAt: NOW }], NOW, projectMaxAgeMs(0), all)).toEqual([]);
  });
});

describe('recordProject', () => {
  it('puts the root first with the time now, once, and drops the stale ones', () => {
    const entries = [
      { root: '/a', seenAt: NOW - DAY },
      { root: '/b', seenAt: NOW - 2 * DAY },
      { root: '/old', seenAt: NOW - 20 * DAY },
    ];
    expect(recordProject(entries, '/b', NOW, projectMaxAgeMs(14), all)).toEqual([
      { root: '/b', seenAt: NOW },
      { root: '/a', seenAt: NOW - DAY },
    ]);
  });

  it('records the root even with 0 days', () => {
    expect(recordProject([{ root: '/a', seenAt: NOW }], '/b', NOW, 0, all)).toEqual([{ root: '/b', seenAt: NOW }]);
  });
});

describe('projectRoots', () => {
  it("serves the daemon's root first, then the recorded ones, once each", () => {
    expect(projectRoots('/main', ['/b', '/main', '/c'])).toEqual(['/main', '/b', '/c']);
    expect(projectRoots(undefined, ['/b'])).toEqual(['/b']);
  });
});

describe('projectNames', () => {
  it('names each by its folder, with the parent when two share a name', () => {
    expect(projectNames(['/w/one/src', '/w/two/src', '/w/app/'])).toEqual(
      new Map([
        ['/w/one/src', 'one/src'],
        ['/w/two/src', 'two/src'],
        ['/w/app/', 'app'],
      ]),
    );
  });
});

describe('projectOf', () => {
  const f = (dir: string, realDir?: string): Feature => ({ name: dir, dir, isMain: false, packages: [], ...(realDir ? { realDir } : {}) });
  const projects = [
    { root: '/w/a', features: [f('/w/a'), f('/elsewhere/a-wt', '/private/elsewhere/a-wt')] },
    { root: '/w/a/nested', features: [f('/w/a/nested')] },
    { root: '/w/b', features: [] },
  ];

  it("finds the project of the session's worktree or folder, the closest one when nested", () => {
    expect(projectOf({ cwd: '/w/a/src' }, projects)).toBe('/w/a');
    expect(projectOf({ cwd: '/w/a/nested/x' }, projects)).toBe('/w/a/nested');
    expect(projectOf({ cwd: '/private/elsewhere/a-wt/pkg' }, projects)).toBe('/w/a');
    expect(projectOf({ featureDir: '/elsewhere/a-wt', cwd: '/tmp' }, projects)).toBe('/w/a');
    expect(projectOf({ cwd: '/w/b' }, projects)).toBe('/w/b');
  });

  it('is none outside every project, and for a sibling sharing a prefix', () => {
    expect(projectOf({ cwd: '/w/abc' }, projects)).toBeUndefined();
    expect(projectOf({ cwd: '/tmp' }, projects)).toBeUndefined();
    expect(projectOf({}, projects)).toBeUndefined();
  });
});
