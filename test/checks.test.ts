import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkKey,
  checksCounts,
  checksHint,
  cleanLogLine,
  failingChecks,
  fixPrompt,
  hasFixes,
  logExcerpt,
  nextFetchAt,
  type PackageChecks,
  type PackageStatus,
} from '../src/core/checks';
import { parsePrView, parseReviewThreads } from '../src/core/github';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/gh/${name}`, import.meta.url), 'utf8');
const pr = (): PackageChecks => ({ ...parsePrView(fixture('pr-view.json')), threads: parseReviewThreads(fixture('review-threads.json')) });
const change = (checks: PackageChecks): PackageStatus => ({ kind: 'change', pkg: 'repo', pkgDir: '/r', checks });

describe('checks hint', () => {
  it('counts the failing checks (failed, errored, cancelled) and the open review threads', () => {
    const p = pr();
    expect(failingChecks(p).map((c) => c.name)).toEqual(['build (windows-latest)', 'ci/external']);
    expect(checksCounts([change(p)])).toEqual({ failing: 2, comments: 3, pending: 1 });
    expect(checksHint([change(p)])).toBe('2 checks failing · 3 comments');
    expect(hasFixes([change(p)])).toBe(true);
  });

  it('says one, adds up packages, and is empty with nothing to fix', () => {
    const one: PackageChecks = { ...pr(), checks: [{ name: 'lint', bucket: 'fail', state: 'FAILURE' }], threads: [] };
    expect(checksHint([change(one)])).toBe('1 check failing');
    expect(checksHint([change(one), change(one), { kind: 'none', pkg: 'b', pkgDir: '/b' }])).toBe('2 checks failing');
    const green: PackageChecks = { ...pr(), checks: [{ name: 'lint', bucket: 'pass', state: 'SUCCESS' }, { name: 'e2e', bucket: 'pending', state: 'IN_PROGRESS' }], threads: [] };
    expect(checksHint([change(green)])).toBe('');
    expect(hasFixes([change(green), { kind: 'error', pkg: 'x', pkgDir: '/x', provider: 'GitHub', message: 'offline' }])).toBe(false);
    expect(checksHint([])).toBe('');
  });
});

describe('log excerpt', () => {
  it('strips the job, step and timestamp gh puts before each line, and escape codes', () => {
    expect(cleanLogLine('build (ubuntu)\tRun tests\t2026-11-03T21:26:16.1737290Z \u001b[31m--- FAIL: TestX (0.03s)\u001b[0m  ')).toBe('--- FAIL: TestX (0.03s)');
    expect(cleanLogLine('x'.repeat(10), 5)).toBe('xxxx…');
  });

  it('goes from just before the first failure to the last error annotation, leaving out the cleanup after it', () => {
    const lines = logExcerpt(fixture('run-log-failed.txt'), 60);
    expect(lines[3]).toBe('--- FAIL: TestResetExperimentDetachesIntegrationWithoutDeletingAccounts (0.03s)');
    expect(lines.at(-1)).toBe('##[error]Process completed with exit code 1.');
    expect(lines.some((l) => l.includes('Cleaning up orphan processes'))).toBe(false);
    expect(lines.every((l) => !/^\d{4}-\d\d-\d\dT/.test(l) && !l.startsWith('build ('))).toBe(true);
  });

  it('keeps the first and last lines of a long one, saying how many were left out', () => {
    const lines = logExcerpt(fixture('run-log-failed.txt'), 9);
    expect(lines).toHaveLength(9);
    expect(lines[3]).toBe('--- FAIL: TestResetExperimentDetachesIntegrationWithoutDeletingAccounts (0.03s)');
    expect(lines[4]).toMatch(/^… \d+ lines left out …$/);
    expect(lines.at(-1)).toBe('##[error]Process completed with exit code 1.');
  });

  it('takes the end of a log with no failure in it, and nothing of an empty one', () => {
    expect(logExcerpt('a\nb\nc\nd\n\n', 2)).toEqual(['c', 'd']);
    expect(logExcerpt('', 5)).toEqual([]);
    expect(logExcerpt('Error: boom', 0)).toEqual([]);
  });
});

describe('fix prompt', () => {
  it('names the pull request, each failing check with its log, and each open comment, in a fixed order', () => {
    const p = pr();
    const windows = p.checks.find((c) => c.name === 'build (windows-latest)')!;
    const prompt = fixPrompt([{ pkgPath: '', checks: p, logs: new Map([[checkKey(windows), ['--- FAIL: TestX', 'FAIL']]]) }]);
    expect(prompt.split('\n\n')[0]).toBe('The pull request for your changes has 2 failing checks and 3 open review comments. Please find why each check fails and fix it, and address each comment:');
    expect(prompt).toContain('GitHub pull request #14927: "Add guided multi-account setup and evaluation"\nURL: https://github.com/cli/cli/pull/14927');
    expect(prompt).toContain(
      'Failing check: build (windows-latest)\nWorkflow: Unit and Integration Tests\nStatus: FAILURE\nDetails: https://github.com/cli/cli/actions/runs/41720844033/job/126212878432\nLog excerpt:\n    --- FAIL: TestX\n    FAIL',
    );
    expect(prompt).toContain('Failing check: ci/external\nStatus: ERROR\nDescription: "The build errored"\nDetails: https://ci.example.com/build/7');
    expect(prompt).toContain('File: old.go\nLine: 9 (outdated: the code changed since)\nComment by someone: "on an older line"\nComment: "reply here"');
    // The same items, the same prompt.
    expect(fixPrompt([{ pkgPath: '', checks: pr(), logs: new Map([[checkKey(windows), ['--- FAIL: TestX', 'FAIL']]]) }])).toBe(prompt);
  });

  it("puts a package's comment paths under its folder, and asks only for what there is", () => {
    const p: PackageChecks = { ...pr(), checks: [] };
    const prompt = fixPrompt([{ pkgPath: 'src/Pkg', checks: p, logs: new Map() }]);
    expect(prompt.split('\n\n')[0]).toBe('The pull request for your changes has 3 open review comments. Please address each comment:');
    expect(prompt).toContain('Package: src/Pkg');
    expect(prompt).toContain('File: src/Pkg/acceptance/acceptance_test.go\nLine: 939');
    const one: PackageChecks = { ...pr(), checks: [{ name: 'lint', bucket: 'fail', state: 'FAILURE' }], threads: [] };
    expect(fixPrompt([{ pkgPath: '', checks: one, logs: new Map() }]).split('\n\n')[0]).toBe('The pull request for your changes has 1 failing check. Please find why each check fails and fix it:');
  });

  it('leaves out changes with nothing to fix', () => {
    const green: PackageChecks = { ...pr(), checks: [{ name: 'lint', bucket: 'pass', state: 'SUCCESS' }], threads: [] };
    const one: PackageChecks = { ...pr(), checks: [{ name: 'lint', bucket: 'fail', state: 'FAILURE' }], threads: [] };
    expect(fixPrompt([{ pkgPath: 'src/A', checks: green, logs: new Map() }, { pkgPath: 'src/B', checks: one, logs: new Map() }])).not.toContain('src/A');
  });
});

describe('fetch schedule', () => {
  it('is due at once the first time, then an interval after the last fetch', () => {
    expect(nextFetchAt(undefined, 300_000, 3_600_000)).toBe(0);
    expect(nextFetchAt({ at: 1000, failures: 0 }, 300_000, 3_600_000)).toBe(301_000);
  });

  it('waits twice as long after each failure in a row, up to the longest wait', () => {
    expect(nextFetchAt({ at: 0, failures: 1 }, 300_000, 3_600_000)).toBe(600_000);
    expect(nextFetchAt({ at: 0, failures: 3 }, 300_000, 3_600_000)).toBe(2_400_000);
    expect(nextFetchAt({ at: 0, failures: 10 }, 300_000, 3_600_000)).toBe(3_600_000);
    // A longest wait below the interval waits the interval.
    expect(nextFetchAt({ at: 0, failures: 2 }, 300_000, 60_000)).toBe(300_000);
  });
});
