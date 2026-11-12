import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ChecksContext, ChecksUnavailable, type RunResult } from '../src/core/checks';
import { actionsJob, checkBucket, githubChecks, parseCheckRollup, parseGitHubRemote, parsePrView, parseReviewThreads, pullRequestOf, remoteUrls } from '../src/core/github';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/gh/${name}`, import.meta.url), 'utf8');

/** A context whose commands answer from `answers` (by `file args…`), recording what ran. */
function fake(answers: Record<string, Partial<RunResult>>, reviewComments = true) {
  const ran: string[] = [];
  const c: ChecksContext = {
    gh: 'gh',
    timeoutMs: 1000,
    reviewComments,
    run: async (file, args) => {
      const key = [file, ...args].join(' ');
      ran.push(key);
      const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
      return { code: 0, stdout: '', stderr: '', ...(hit?.[1] ?? { code: 1, stderr: `unexpected: ${key}` }) };
    },
  };
  return { c, ran };
}

describe('GitHub remotes', () => {
  it('reads https, scp-like and ssh URLs of GitHub hosts', () => {
    expect(parseGitHubRemote('https://github.com/cli/cli.git')).toEqual({ host: 'github.com', owner: 'cli', repo: 'cli' });
    expect(parseGitHubRemote('git@github.com:roniburd/devdesk-agent.git')).toEqual({ host: 'github.com', owner: 'roniburd', repo: 'devdesk-agent' });
    expect(parseGitHubRemote('ssh://git@github.com/o/r')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' });
    expect(parseGitHubRemote('https://github.example.com/team/app')).toEqual({ host: 'github.example.com', owner: 'team', repo: 'app' });
  });

  it('leaves other hosts alone', () => {
    expect(parseGitHubRemote('https://gitlab.com/o/r.git')).toBeUndefined();
    expect(parseGitHubRemote('ssh://git.example.com:2222/pkg/Thing')).toBeUndefined();
    expect(parseGitHubRemote('/local/path')).toBeUndefined();
  });

  it('lists the URLs of git remote -v once each', () => {
    expect(remoteUrls('origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\nfork\thttps://github.com/me/r (fetch)\n')).toEqual([
      'git@github.com:o/r.git',
      'https://github.com/me/r',
    ]);
  });
});

describe('gh pr view', () => {
  it('reads the pull request and its checks (check runs and status contexts)', () => {
    const p = parsePrView(fixture('pr-view.json'));
    expect(p.change).toEqual({ provider: 'GitHub', kind: 'pull request', id: '#14927', title: 'Add guided multi-account setup and evaluation', url: 'https://github.com/cli/cli/pull/14927', state: 'OPEN' });
    expect(p.checks.map((c) => [c.name, c.bucket, c.state])).toEqual([
      ['lint', 'pass', 'SUCCESS'],
      ['build (ubuntu-latest)', 'pass', 'SUCCESS'],
      ['build (windows-latest)', 'fail', 'FAILURE'],
      ['check-requirements / check-requirements', 'skipping', 'SKIPPED'],
      ['CodeQL', 'pass', 'SUCCESS'],
      ['integration-tests (macos-latest)', 'pending', 'IN_PROGRESS'],
      ['ci/external', 'fail', 'ERROR'],
    ]);
    expect(p.checks.find((c) => c.name === 'ci/external')).toMatchObject({ link: 'https://ci.example.com/build/7', description: 'The build errored' });
  });

  it("keeps a re-run check's latest run only", () => {
    const checks = parseCheckRollup([
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T00:00:00Z' },
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-02T00:00:00Z' },
      { __typename: 'CheckRun', name: 'test', workflowName: 'Other', status: 'QUEUED', conclusion: '' },
    ]);
    expect(checks.map((c) => [c.workflow, c.bucket])).toEqual([['CI', 'pass'], ['Other', 'pending']]);
  });

  it('buckets states as gh pr checks does', () => {
    expect(['TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].map((c) => checkBucket('COMPLETED', c))).toEqual(['fail', 'fail', 'fail']);
    expect(checkBucket('COMPLETED', 'CANCELLED')).toBe('cancel');
    expect(checkBucket('COMPLETED', 'NEUTRAL')).toBe('skipping');
    expect(checkBucket('IN_PROGRESS', '')).toBe('pending');
    expect(checkBucket('PENDING', undefined)).toBe('pending');
  });

  it('refuses an answer without a pull request', () => {
    expect(() => parsePrView('{}')).toThrow(/no pull request/);
  });
});

describe('review threads', () => {
  it('keeps the threads not resolved yet, with their comments', () => {
    const threads = parseReviewThreads(fixture('review-threads.json'));
    expect(threads.map((t) => [t.path, t.line, t.outdated, t.comments.length])).toEqual([
      ['script/identity-e2e/fixture_test.go', 133, false, 1],
      ['acceptance/acceptance_test.go', 939, false, 1],
      ['old.go', undefined, true, 2],
    ]);
    expect(threads[2]).toMatchObject({ originalLine: 9, comments: [{ author: 'someone', body: 'on an older line' }, { body: 'reply here' }] });
  });
});

describe('links', () => {
  it('finds the job of an Actions link, and the pull request of its URL', () => {
    expect(actionsJob('https://github.com/cli/cli/actions/runs/41720844033/job/126212878432')).toEqual({ repo: 'cli/cli', job: '126212878432' });
    expect(actionsJob('https://github.example.com/t/a/actions/runs/1/job/2')).toEqual({ repo: 'github.example.com/t/a', job: '2' });
    expect(actionsJob('https://ci.example.com/build/7')).toBeUndefined();
    expect(actionsJob(undefined)).toBeUndefined();
    expect(pullRequestOf('https://github.com/cli/cli/pull/14927')).toEqual({ host: 'github.com', owner: 'cli', repo: 'cli', number: 14927 });
  });
});

describe('the GitHub provider', () => {
  it('handles repositories with a GitHub remote', async () => {
    expect(await githubChecks.handles('/r', fake({ 'git remote -v': { stdout: 'origin\tgit@github.com:o/r.git (fetch)\n' } }).c)).toBe(true);
    expect(await githubChecks.handles('/r', fake({ 'git remote -v': { stdout: 'origin\tssh://git.example.com/x (fetch)\n' } }).c)).toBe(false);
    expect(await githubChecks.handles('/r', fake({ 'git remote -v': { code: 128 } }).c)).toBe(false);
  });

  it('reads the pull request, then its open review threads, with read-only calls', async () => {
    const { c, ran } = fake({ 'gh pr view': { stdout: fixture('pr-view.json') }, 'gh api graphql': { stdout: fixture('review-threads.json') } });
    const p = await githubChecks.status('/r', c);
    expect(p?.change.id).toBe('#14927');
    expect(p?.threads).toHaveLength(3);
    expect(ran[0]).toBe('gh pr view --json number,title,url,state,headRefName,statusCheckRollup');
    expect(ran[1]).toMatch(/^gh api graphql -F owner=cli -F name=cli -F number=14927 -f query=query\(/);
    expect(ran[1]).not.toMatch(/mutation/);
  });

  it('reads no review threads when they are off', async () => {
    const { c, ran } = fake({ 'gh pr view': { stdout: fixture('pr-view.json') } }, false);
    expect((await githubChecks.status('/r', c))?.threads).toBeUndefined();
    expect(ran).toHaveLength(1);
  });

  it('has nothing for a branch without a pull request, or a merged one', async () => {
    expect(await githubChecks.status('/r', fake({ 'gh pr view': { code: 1, stderr: 'no pull requests found for branch "x"' } }).c)).toBeUndefined();
    const merged = JSON.stringify({ ...JSON.parse(fixture('pr-view.json')), state: 'MERGED' });
    expect(await githubChecks.status('/r', fake({ 'gh pr view': { stdout: merged } }).c)).toBeUndefined();
  });

  it('is unavailable without gh, or signed out; other failures are errors', async () => {
    await expect(githubChecks.status('/r', fake({ 'gh pr view': { code: null, missing: true } }).c)).rejects.toBeInstanceOf(ChecksUnavailable);
    await expect(githubChecks.status('/r', fake({ 'gh pr view': { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } }).c)).rejects.toThrow(/not signed in/);
    const offline = githubChecks.status('/r', fake({ 'gh pr view': { code: 1, stderr: 'error connecting to api.github.com\nmore' } }).c);
    await expect(offline).rejects.toThrow('gh pr view: error connecting to api.github.com');
    await expect(offline).rejects.not.toBeInstanceOf(ChecksUnavailable);
  });

  it("reads an Actions check's failed log and quotes its excerpt", async () => {
    const { c, ran } = fake({ 'gh run view': { stdout: fixture('run-log-failed.txt') } });
    const p = parsePrView(fixture('pr-view.json'));
    const windows = p.checks.find((x) => x.name === 'build (windows-latest)')!;
    const lines = await githubChecks.failureLog('/r', windows, { ...c, maxLines: 10 });
    expect(ran).toEqual(['gh run view --job 126212878432 --log-failed -R cli/cli']);
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toBe('##[error]Process completed with exit code 1.');
    // A status context links elsewhere: no log.
    expect(await githubChecks.failureLog('/r', p.checks.find((x) => x.name === 'ci/external')!, { ...c, maxLines: 10 })).toEqual([]);
  });
});
