import { quoteNote } from './reviewNotes';

/**
 * A worktree's pull requests (or other change requests), their checks and the review comments not resolved yet, and
 * the prompt that asks Claude to fix them. The providers (GitHub's `gh`, and any the workspace kind adds) fill these in;
 * everything here is pure.
 */

/** What a check's state comes to (as `gh pr checks` buckets them). */
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface CheckResult {
  name: string;
  /** The workflow (or pipeline) it is part of, when it has one. */
  workflow?: string;
  bucket: CheckBucket;
  /** The provider's own word for its state (`FAILURE`, `TIMED_OUT`, `ERROR`…). */
  state: string;
  /** Where to see it. */
  link?: string;
  description?: string;
  startedAt?: string;
}

/** A review comment thread not resolved yet: where it is, and what was said in it, in order. */
export interface ReviewThread {
  /** The file, relative to its repository. */
  path: string;
  /** Its line in the current version; undefined when the thread is on code that changed since (outdated). */
  line?: number;
  /** Its line in the version it was written on. */
  originalLine?: number;
  outdated: boolean;
  comments: { author?: string; body: string; url?: string }[];
}

/** A change under review: a pull request, or what the provider calls it. */
export interface ChangeRequest {
  /** The provider (`GitHub`). */
  provider: string;
  /** What the provider calls one (`pull request`). */
  kind: string;
  /** How it is named (`#12`). */
  id: string;
  title: string;
  url: string;
  /** `OPEN`, `MERGED`, `CLOSED`… */
  state: string;
}

/** One package's change request, its checks and (when asked for) its open review threads. */
export interface PackageChecks {
  change: ChangeRequest;
  checks: CheckResult[];
  threads?: ReviewThread[];
}

/** What a worktree's package has: its change's checks, no change (`none`), a provider that can't tell (`unavailable`), or an error. */
export type PackageStatus =
  | { kind: 'change'; pkg: string; pkgDir: string; checks: PackageChecks }
  | { kind: 'none'; pkg: string; pkgDir: string }
  | { kind: 'unavailable'; pkg: string; pkgDir: string; provider: string; reason: string }
  | { kind: 'error'; pkg: string; pkgDir: string; provider: string; message: string };

/** How a command ended (see `runBounded`). */
export interface RunResult {
  /** The exit code; null when it was killed (timeout) or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program does not exist (ENOENT). */
  missing?: boolean;
  /** `stdout` is only the end of what it wrote. */
  truncated?: boolean;
}

/** Runs `file` with `args` in `cwd`; never rejects. */
export type Run = (file: string, args: string[], o: { cwd: string; timeoutMs: number; maxBytes: number }) => Promise<RunResult>;

/** What a provider runs commands with, and what it is asked to fetch. */
export interface ChecksContext {
  run: Run;
  /** The `gh` program (`devdesk.checks.ghPath`). */
  gh: string;
  timeoutMs: number;
  /** Fetch the review threads not resolved yet too (`devdesk.checks.reviewComments`). */
  reviewComments: boolean;
}

/** A provider can't be used here at all (its CLI is missing or not signed in): it says why, and is asked less often. */
export class ChecksUnavailable extends Error {}

/** Where a package's change requests and checks come from (GitHub through `gh`, or the workspace kind's own). */
export interface ChecksProvider {
  /** The provider's name, as messages show it. */
  readonly name: string;
  /** True when it handles the git repository at `dir` (cheap: reads its remotes). */
  handles(dir: string, c: ChecksContext): Promise<boolean>;
  /**
   * The change request of the branch checked out at `dir`, with its checks (and its open review threads when
   * `c.reviewComments`); undefined when the branch has none. Throws `ChecksUnavailable`, or an Error on a failure.
   */
  status(dir: string, c: ChecksContext): Promise<PackageChecks | undefined>;
  /** The end of the failed log of `check`, as lines (empty when there is none). */
  failureLog(dir: string, check: CheckResult, c: ChecksContext & { maxLines: number }): Promise<string[]>;
}

/** The checks that failed (failed, timed out, errored, cancelled), in their order. */
export const failingChecks = (p: PackageChecks): CheckResult[] => p.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');

/** How many failing checks and open review threads a worktree's packages have. */
export function checksCounts(statuses: readonly PackageStatus[]): { failing: number; comments: number; pending: number } {
  let failing = 0;
  let comments = 0;
  let pending = 0;
  for (const s of statuses) {
    if (s.kind !== 'change') continue;
    failing += failingChecks(s.checks).length;
    pending += s.checks.checks.filter((c) => c.bucket === 'pending').length;
    comments += s.checks.threads?.length ?? 0;
  }
  return { failing, comments, pending };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A worktree row's hint (`2 checks failing · 1 comment`); empty when nothing needs fixing. */
export function checksHint(statuses: readonly PackageStatus[]): string {
  const { failing, comments } = checksCounts(statuses);
  return [failing ? `${plural(failing, 'check')} failing` : '', comments ? plural(comments, 'comment') : ''].filter(Boolean).join(' · ');
}

/** True when the worktree has something to ask Claude to fix. */
export const hasFixes = (statuses: readonly PackageStatus[]): boolean => !!checksHint(statuses);

// eslint-disable-next-line no-control-regex -- ANSI escapes, taken out of log lines
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** `gh run view --log-failed` lines start with the job, the step and a timestamp. */
const LOG_PREFIX = /^[^\t]*\t[^\t]*\t/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
/** Lines that tell what failed: test failures, errors, panics, and GitHub Actions' error annotations. */
const MARKER = /##\[error\]|\bFAIL(?:ED|URE)?\b|\bERROR\b|\b[Ee]rror:|\bfailed\b|\bpanic:|\bTraceback\b|\bAssertionError\b|✗|✘/;
const ANNOTATION = '##[error]';

/** A log line without its job, step and timestamp, or escape codes, cut to `maxChars`. */
export function cleanLogLine(line: string, maxChars = 300): string {
  const text = line.replace(ANSI, '').replace(LOG_PREFIX, '').replace(TIMESTAMP, '').replace(/\s+$/, '');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * The part of a failed log that says what failed, at most `maxLines` lines: from a few lines before the first line
 * that looks like a failure to the last error annotation (what comes after it is the runner cleaning up), or the end.
 * When that is longer, its first and last halves with how many lines were left out between them. Without any such
 * line, the last `maxLines` lines.
 */
export function logExcerpt(text: string, maxLines: number, maxChars = 300): string[] {
  const lines = text.split(/\r?\n/).map((l) => cleanLogLine(l, maxChars));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length || maxLines <= 0) return [];
  let end = lines.length - 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(ANNOTATION)) {
      end = i;
      break;
    }
  }
  const first = lines.findIndex((l, i) => i <= end && MARKER.test(l));
  const start = first < 0 ? Math.max(0, end - maxLines + 1) : Math.max(0, first - 3);
  const count = end - start + 1;
  if (count <= maxLines) return lines.slice(start, end + 1);
  const head = Math.ceil((maxLines - 1) / 2);
  const tail = maxLines - 1 - head;
  return [...lines.slice(start, start + head), `… ${count - head - tail} lines left out …`, ...(tail ? lines.slice(end - tail + 1, end + 1) : [])];
}

/** A package's change request, its failing checks with their log excerpts, for the prompt. */
export interface FixItem {
  /** The package's folder relative to the worktree (`''` when it is the worktree itself): paths in comments are under it. */
  pkgPath: string;
  checks: PackageChecks;
  /** Log excerpts of failing checks, by check (name and workflow, see `checkKey`). */
  logs: ReadonlyMap<string, readonly string[]>;
}

/** A check's key among a change's checks. */
export const checkKey = (c: Pick<CheckResult, 'name' | 'workflow'>): string => `${c.workflow ?? ''}\0${c.name}`;

const joinPath = (dir: string, path: string) => (dir ? `${dir.replace(/\/+$/, '')}/${path}` : path);

function formatCheck(c: CheckResult, log: readonly string[] | undefined): string {
  const lines = [`Failing check: ${c.name}`];
  if (c.workflow) lines.push(`Workflow: ${c.workflow}`);
  lines.push(`Status: ${c.state}`);
  if (c.description) lines.push(`Description: ${quoteNote(c.description)}`);
  if (c.link) lines.push(`Details: ${c.link}`);
  if (log?.length) lines.push('Log excerpt:', ...log.map((l) => `    ${l}`));
  return lines.join('\n');
}

function formatThread(t: ReviewThread, pkgPath: string): string {
  const line = t.line ?? t.originalLine;
  const lines = [`File: ${joinPath(pkgPath, t.path)}`];
  if (line !== undefined) lines.push(t.outdated ? `Line: ${line} (outdated: the code changed since)` : `Line: ${line}`);
  for (const c of t.comments) lines.push(`${c.author ? `Comment by ${c.author}` : 'Comment'}: ${quoteNote(c.body)}`);
  return lines.join('\n');
}

/**
 * The prompt that asks Claude to fix a worktree's failing checks and address its open review comments: a line saying
 * what follows, then for each change request its name and link, each failing check (name, workflow, status, link and
 * the excerpt of its failed log) and each open review thread (file, line, comments), a blank line between them.
 * Deterministic: the same items give the same prompt.
 */
export function fixPrompt(items: readonly FixItem[]): string {
  const withFixes = items
    .map((i) => ({ ...i, failing: failingChecks(i.checks), threads: i.checks.threads ?? [] }))
    .filter((i) => i.failing.length || i.threads.length);
  const failing = withFixes.reduce((n, i) => n + i.failing.length, 0);
  const comments = withFixes.reduce((n, i) => n + i.threads.length, 0);
  const kind = withFixes[0]?.checks.change.kind ?? 'pull request';
  const what = [failing ? plural(failing, 'failing check') : '', comments ? plural(comments, 'open review comment') : ''].filter(Boolean).join(' and ');
  const asks = [failing ? 'find why each check fails and fix it' : '', comments ? 'address each comment' : ''].filter(Boolean).join(', and ');
  const intro = `The ${withFixes.length > 1 ? `${kind}s for your changes have` : `${kind} for your changes has`} ${what || 'nothing to fix'}. Please ${asks || 'check'}:`;
  const blocks = [intro];
  for (const i of withFixes) {
    const c = i.checks.change;
    blocks.push([`${c.provider} ${c.kind} ${c.id}: ${quoteNote(c.title)}`, `URL: ${c.url}`, ...(i.pkgPath ? [`Package: ${i.pkgPath}`] : [])].join('\n'));
    for (const check of i.failing) blocks.push(formatCheck(check, i.logs.get(checkKey(check))));
    for (const t of [...i.threads].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0)))) {
      blocks.push(formatThread(t, i.pkgPath));
    }
  }
  return blocks.join('\n\n');
}

/** When a worktree's checks were last fetched, and how often in a row that failed. */
export interface FetchState {
  at: number;
  failures: number;
}

/**
 * When a worktree's checks are due again: `intervalMs` after the last fetch, doubled for each failure in a row (a
 * missing `gh`, a network error) up to `maxBackoffMs`. Never fetched: now.
 */
export function nextFetchAt(state: FetchState | undefined, intervalMs: number, maxBackoffMs: number): number {
  if (!state) return 0;
  const wait = state.failures ? Math.min(Math.max(maxBackoffMs, intervalMs), intervalMs * 2 ** state.failures) : intervalMs;
  return state.at + wait;
}
