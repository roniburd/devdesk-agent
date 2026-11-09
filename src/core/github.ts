import { type CheckBucket, type CheckResult, type ChecksContext, type ChecksProvider, ChecksUnavailable, logExcerpt, type PackageChecks, type ReviewThread } from './checks';
import { truncate } from './text';

/** What `gh pr view --json` is asked for (one call per refresh). */
export const PR_FIELDS = 'number,title,url,state,headRefName,statusCheckRollup';

/** The open review threads of a pull request (`gh api graphql`, read-only), at most 100, with up to 20 comments each. */
export const REVIEW_THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:20){nodes{body author{login} url}}}}}}}';

/** Stdout kept of a `gh` call answering JSON, and of a failed log (its end). */
const JSON_BYTES = 8 * 1024 * 1024;
const LOG_BYTES = 2 * 1024 * 1024;
/** A review comment's body is cut to this many characters in the prompt. */
const COMMENT_CHARS = 2000;

/** The host, owner and repository of a GitHub remote URL (`https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://…`). */
export function parseGitHubRemote(url: string): { host: string; owner: string; repo: string } | undefined {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  // github.com, and GitHub Enterprise hosts named for it (github.example.com).
  if (host !== 'github.com' && !/(^|\.)github\./.test(host)) return undefined;
  return { host, owner: m[2], repo: m[3] };
}

/** The URLs of `git remote -v`'s output. */
export const remoteUrls = (out: string): string[] => [...new Set(out.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean))];

/** A check run's or status context's state, bucketed as `gh pr checks` does. */
export function checkBucket(status: string | undefined, conclusion: string | undefined): CheckBucket {
  const s = (status ?? '').toUpperCase();
  const c = (conclusion ?? '').toUpperCase();
  if (s && s !== 'COMPLETED') {
    // A status context has only `state`: passed in as the status.
    if (s === 'SUCCESS') return 'pass';
    if (s === 'FAILURE' || s === 'ERROR') return 'fail';
    return 'pending';
  }
  if (c === 'SUCCESS') return 'pass';
  if (c === 'SKIPPED' || c === 'NEUTRAL') return 'skipping';
  if (c === 'CANCELLED') return 'cancel';
  if (c === 'FAILURE' || c === 'TIMED_OUT' || c === 'STARTUP_FAILURE' || c === 'ACTION_REQUIRED' || c === 'STALE') return 'fail';
  return 'pending';
}

type Rollup = {
  __typename?: string;
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  description?: string;
  startedAt?: string;
};

/** The checks of `gh pr view --json statusCheckRollup`: check runs and status contexts, a re-run's latest only. */
export function parseCheckRollup(rollup: unknown): CheckResult[] {
  if (!Array.isArray(rollup)) return [];
  const byKey = new Map<string, CheckResult>();
  for (const r of rollup as Rollup[]) {
    if (!r || typeof r !== 'object') continue;
    const context = r.__typename === 'StatusContext' || (r.context !== undefined && r.name === undefined);
    const name = (context ? r.context : r.name) ?? '';
    if (!name) continue;
    const check: CheckResult = {
      name,
      ...(r.workflowName ? { workflow: r.workflowName } : {}),
      bucket: context ? checkBucket(r.state || 'PENDING', undefined) : checkBucket(r.status, r.conclusion),
      state: (context ? r.state : r.status === 'COMPLETED' ? r.conclusion : r.status) || 'PENDING',
      ...((context ? r.targetUrl : r.detailsUrl) ? { link: (context ? r.targetUrl : r.detailsUrl)! } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    };
    const key = `${check.workflow ?? ''}\0${name}`;
    const seen = byKey.get(key);
    if (!seen || (check.startedAt ?? '') >= (seen.startedAt ?? '')) byKey.set(key, check);
  }
  return [...byKey.values()];
}

/** `gh pr view --json PR_FIELDS`'s answer: the pull request and its checks. */
export function parsePrView(json: string): PackageChecks {
  const o = JSON.parse(json) as { number?: number; title?: string; url?: string; state?: string; statusCheckRollup?: unknown };
  if (typeof o.number !== 'number' || typeof o.url !== 'string') throw new Error('gh pr view: no pull request number or URL in its answer');
  return {
    change: { provider: 'GitHub', kind: 'pull request', id: `#${o.number}`, title: o.title ?? '', url: o.url, state: o.state ?? '' },
    checks: parseCheckRollup(o.statusCheckRollup),
  };
}

/** The review threads not resolved yet of `REVIEW_THREADS_QUERY`'s answer, comments cut to `COMMENT_CHARS`. */
export function parseReviewThreads(json: string): ReviewThread[] {
  type Node = { isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number | null; originalLine?: number | null; comments?: { nodes?: { body?: string; author?: { login?: string } | null; url?: string }[] } };
  const o = JSON.parse(json) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Node[] } } } } };
  const nodes = o.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes
    .filter((n) => n && !n.isResolved && n.path)
    .map((n) => ({
      path: n.path!,
      ...(typeof n.line === 'number' ? { line: n.line } : {}),
      ...(typeof n.originalLine === 'number' ? { originalLine: n.originalLine } : {}),
      outdated: !!n.isOutdated,
      comments: (n.comments?.nodes ?? [])
        .filter((c) => c?.body?.trim())
        .map((c) => ({ body: truncate(c.body!.trim(), COMMENT_CHARS), ...(c.author?.login ? { author: c.author.login } : {}), ...(c.url ? { url: c.url } : {}) })),
    }))
    .filter((t) => t.comments.length);
}

/** The repository (`[host/]owner/repo`) and job of a GitHub Actions job link, for `gh run view --job`. */
export function actionsJob(link: string | undefined): { repo: string; job: string } | undefined {
  const m = link && /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)/.exec(link);
  if (!m) return undefined;
  return { repo: m[1] === 'github.com' ? `${m[2]}/${m[3]}` : `${m[1]}/${m[2]}/${m[3]}`, job: m[4] };
}

/** The host, owner, repository and number of a pull request URL. */
export function pullRequestOf(url: string): { host: string; owner: string; repo: string; number: number } | undefined {
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) } : undefined;
}

/** True when gh says it is not signed in (or has no token for the host). */
const notSignedIn = (text: string) => /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(text);
/** True when gh found no pull request for the branch (or there is no branch: a detached HEAD). */
const noPullRequest = (text: string) => /no pull requests? found|could not determine current branch|not on any branch/i.test(text);

function fail(what: string, r: { code: number | null; stderr: string; missing?: boolean }, gh: string): never {
  if (r.missing) throw new ChecksUnavailable(`${gh} is not installed (setting devdesk.checks.ghPath)`);
  if (notSignedIn(r.stderr)) throw new ChecksUnavailable(`${gh} is not signed in: run gh auth login`);
  throw new Error(`${what}: ${r.stderr.trim().split('\n')[0] || `exit code ${r.code}`}`);
}

/** GitHub pull requests through the `gh` CLI: read-only calls only (`pr view`, `api graphql` queries, `run view`). */
export const githubChecks: ChecksProvider = {
  name: 'GitHub',
  async handles(dir, c) {
    const r = await c.run('git', ['remote', '-v'], { cwd: dir, timeoutMs: c.timeoutMs, maxBytes: 64 * 1024 });
    return r.code === 0 && remoteUrls(r.stdout).some((u) => parseGitHubRemote(u) !== undefined);
  },
  async status(dir, c) {
    const r = await c.run(c.gh, ['pr', 'view', '--json', PR_FIELDS], { cwd: dir, timeoutMs: c.timeoutMs, maxBytes: JSON_BYTES });
    if (r.code !== 0) {
      if (!r.missing && noPullRequest(r.stderr)) return undefined;
      fail('gh pr view', r, c.gh);
    }
    const pr = parsePrView(r.stdout);
    if (pr.change.state && pr.change.state !== 'OPEN') return undefined; // merged or closed: nothing to fix there
    const where = c.reviewComments ? pullRequestOf(pr.change.url) : undefined;
    if (where) {
      const args = ['api', 'graphql', ...(where.host === 'github.com' ? [] : ['--hostname', where.host]), '-F', `owner=${where.owner}`, '-F', `name=${where.repo}`, '-F', `number=${where.number}`, '-f', `query=${REVIEW_THREADS_QUERY}`];
      const t = await c.run(c.gh, args, { cwd: dir, timeoutMs: c.timeoutMs, maxBytes: JSON_BYTES });
      if (t.code !== 0) fail('gh api graphql (review threads)', t, c.gh);
      pr.threads = parseReviewThreads(t.stdout);
    }
    return pr;
  },
  async failureLog(dir, check, c) {
    const job = actionsJob(check.link);
    if (!job) return [];
    const r = await c.run(c.gh, ['run', 'view', '--job', job.job, '--log-failed', '-R', job.repo], { cwd: dir, timeoutMs: c.timeoutMs, maxBytes: LOG_BYTES });
    if (r.code !== 0) fail('gh run view --log-failed', r, c.gh);
    return logExcerpt(r.stdout, c.maxLines);
  },
};
