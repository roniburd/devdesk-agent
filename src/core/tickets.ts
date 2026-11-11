import { parseObject } from './json';

/**
 * Tickets linked to worktrees and sessions: an issue tracker's key or URL (`ABC-123`, `#123`, a URL), shown as a chip on
 * the worktree's row and its sessions' board cards. Each tracker is a `TicketProvider`: it recognises its keys and URLs,
 * and may read a ticket's title and status (read-only, through a CLI the user has, never with a token DevDesk keeps).
 * `ticketRegistry` asks the providers that are on, in order. No `vscode`.
 */

/** Runs a program (no shell), bounded in time and output: `runBounded` (`boundedRun.ts`). Never rejects. */
export type TicketRun = (
  file: string,
  args: string[],
  o: { cwd: string; timeoutMs: number; maxBytes: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

/** A ticket as a provider recognised it. */
export interface TicketRef {
  /** The provider's id (`github`, `jira`, `linear`, a pattern's name). */
  system: string;
  /** As the chip shows it: `ABC-123`, `#123`, `owner/repo#123`. */
  key: string;
  /** Where Open Ticket goes. */
  url: string;
}

/** What a provider read about a ticket. */
export interface TicketInfo {
  title: string;
  status: string;
  assignee?: string;
}

/** Where a key or URL was found, for the keys that need it (a bare `#123` is an issue of the worktree's GitHub repo). */
export interface TicketContext {
  github?: { host: string; owner: string; repo: string };
}

/** What a provider fetches with. */
export interface TicketFetchContext {
  run: TicketRun;
  /** The worktree the ticket is linked to (commands run there). */
  cwd: string;
  timeoutMs: number;
  /** The GitHub CLI (`devdesk.checks.ghPath`). */
  gh: string;
}

export interface TicketProvider {
  /** Its id: `devdesk.tickets.providers` names it, and links keep it as their `system`. */
  readonly id: string;
  /** As messages and hovers name it (`Jira`, `GitHub issue`). */
  readonly label: string;
  /** True when `input` (a pasted key or URL, trimmed) is one of its tickets. */
  matches(input: string, ctx?: TicketContext): boolean;
  /** The ticket a pasted key or URL (the whole input) names, if it is one of its own. */
  parse(input: string, ctx?: TicketContext): TicketRef | undefined;
  /** Its tickets named somewhere in free text (a branch name, a prompt), in the order they appear. */
  find(text: string, ctx?: TicketContext): TicketRef[];
  /** Reads the ticket's title and status, read-only; undefined when it can't be read this way. Absent: link only. */
  fetch?(ref: TicketRef, c: TicketFetchContext): Promise<TicketInfo | undefined>;
  /** The URL Open Ticket opens. */
  openUrl(ref: TicketRef): string;
}

/** The text `find` looks at: a prompt can be long, and user patterns run on it. */
export const MAX_SCAN_CHARS = 4000;
/** Stdout kept of a fetch. */
const FETCH_BYTES = 1024 * 1024;

const clip = (text: string) => (text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text);

/** All matches of the global regex `re` in `text`, as `[match, index]`, skipping empty ones. */
function* matchesOf(re: RegExp, text: string): Generator<RegExpExecArray> {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m; m = g.exec(text)) {
    if (!m[0]) {
      g.lastIndex++;
      continue;
    }
    yield m;
  }
}

/** A provider from its parts, `matches` being `parse` finding something, and `openUrl` the ref's URL. */
export function defineProvider(p: Omit<TicketProvider, 'matches' | 'openUrl'> & Partial<Pick<TicketProvider, 'openUrl'>>): TicketProvider {
  return {
    ...p,
    matches: (input, ctx) => p.parse(input.trim(), ctx) !== undefined,
    openUrl: p.openUrl ?? ((ref) => ref.url),
  };
}

/** `https://…` with no spaces, quotes or a closing bracket. */
const URL_RE = /https?:\/\/[^\s"'<>()\[\]]+/g;
/** URLs in `text`, without the punctuation a sentence puts after one. */
export const urlsIn = (text: string): string[] => [...matchesOf(URL_RE, clip(text))].map((m) => m[0].replace(/[.,;:!?]+$/, ''));

// ---- GitHub issues -----------------------------------------------------------------------------------------------

/** A GitHub issue URL: `https://<host>/<owner>/<repo>/issues/<n>` on github.com or a GitHub Enterprise host. */
function githubIssueUrl(url: string): TicketRef | undefined {
  const m = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#][^\s]*)?$/.exec(url);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  if (host !== 'github.com' && !/(^|\.)github\./.test(host)) return undefined;
  return githubRef({ host, owner: m[2], repo: m[3] }, Number(m[4]), true);
}

function githubRef(repo: { host: string; owner: string; repo: string }, n: number, qualified: boolean): TicketRef {
  return { system: 'github', key: qualified ? `${repo.owner}/${repo.repo}#${n}` : `#${n}`, url: `https://${repo.host}/${repo.owner}/${repo.repo}/issues/${n}` };
}

/** The repository of a GitHub issue link, for `gh issue view -R`. */
export function githubRepoOf(url: string): { repoArg: string; number: number } | undefined {
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url);
  if (!m) return undefined;
  return { repoArg: m[1] === 'github.com' ? `${m[2]}/${m[3]}` : `${m[1]}/${m[2]}/${m[3]}`, number: Number(m[4]) };
}

/** `gh issue view --json title,state,assignees`'s answer. */
export function parseGhIssue(json: string): TicketInfo | undefined {
  const o = parseObject(json);
  if (!o || typeof o.title !== 'string') return undefined;
  const assignees = Array.isArray(o.assignees) ? (o.assignees as { login?: unknown }[]).map((a) => a?.login).filter((l): l is string => typeof l === 'string') : [];
  const state = typeof o.state === 'string' ? o.state : '';
  return { title: o.title, status: state ? state[0] + state.slice(1).toLowerCase() : '', ...(assignees.length ? { assignee: assignees.join(', ') } : {}) };
}

/**
 * GitHub issues: issue URLs anywhere; `owner/repo#123` and `GH-123`; and, for the worktree's own GitHub repository,
 * `#123` when pasted, or in text after `issue`, `fixes`, `closes` or `resolves` (a bare `#1` in a prompt is often not an
 * issue), and branch names like `issue-123` or `123-fix-login`. Read with `gh issue view` (read-only).
 */
export const githubTickets: TicketProvider = defineProvider({
  id: 'github',
  label: 'GitHub issue',
  parse(input, ctx) {
    const s = input.trim();
    if (/^https?:\/\//.test(s)) return githubIssueUrl(s);
    const q = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(s);
    if (q) return githubRef({ host: ctx?.github?.host ?? 'github.com', owner: q[1], repo: q[2] }, Number(q[3]), true);
    const n = /^(?:#|GH-)(\d+)$/i.exec(s);
    return n && ctx?.github ? githubRef(ctx.github, Number(n[1]), false) : undefined;
  },
  find(text, ctx) {
    const t = clip(text);
    const found: { at: number; ref: TicketRef }[] = [];
    for (const m of matchesOf(URL_RE, t)) {
      const ref = githubIssueUrl(m[0].replace(/[.,;:!?]+$/, ''));
      if (ref) found.push({ at: m.index, ref });
    }
    for (const m of matchesOf(/(?<![\w/.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/, t)) {
      found.push({ at: m.index, ref: githubRef({ host: ctx?.github?.host ?? 'github.com', owner: m[1], repo: m[2] }, Number(m[3]), true) });
    }
    if (ctx?.github) {
      const repo = ctx.github;
      for (const m of matchesOf(/\b(?:issues?|fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i, t)) found.push({ at: m.index, ref: githubRef(repo, Number(m[1]), false) });
      for (const m of matchesOf(/(?<![\w-])GH-(\d+)\b/i, t)) found.push({ at: m.index, ref: githubRef(repo, Number(m[1]), false) });
      // Branch names: `issue-123`, `issues/123`, `123-fix-login`, `feat/123-login`. Only a single word (no spaces).
      if (!/\s/.test(t.trim())) {
        const b = /(?:^|\/)(?:issues?[-_/]?)(\d+)\b/i.exec(t) ?? /(?:^|\/)(\d+)[-_][a-z]/i.exec(t);
        if (b) found.push({ at: b.index, ref: githubRef(repo, Number(b[1]), false) });
      }
    }
    return found.sort((a, b) => a.at - b.at).map((f) => f.ref);
  },
  async fetch(ref, c) {
    const where = githubRepoOf(ref.url);
    if (!where) return undefined;
    const r = await c.run(c.gh, ['issue', 'view', String(where.number), '-R', where.repoArg, '--json', 'title,state,assignees'], { cwd: c.cwd, timeoutMs: c.timeoutMs, maxBytes: FETCH_BYTES });
    if (r.missing) throw new Error(`${c.gh} is not installed`);
    if (r.code !== 0) throw new Error(`gh issue view: ${r.stderr.trim().split('\n')[0] || `exit code ${r.code}`}`);
    return parseGhIssue(r.stdout);
  },
});

// ---- Jira-style keys (Jira, Linear) ------------------------------------------------------------------------------

/** `ABC-123` as Jira and Linear write their keys: an uppercase project key (letter first), a dash, a number. */
const PROJECT_KEY = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{1,9})-(\d{1,7})(?![A-Za-z0-9_]|-\d)/;
/** Words that look like a project key in ordinary text (`UTF-8`, `SHA-256`, `ISO-8601`) and are never taken as one. */
const NOT_PROJECTS: ReadonlySet<string> = new Set([
  'UTF', 'ISO', 'SHA', 'MD', 'RFC', 'CVE', 'CWE', 'HTTP', 'TLS', 'SSL', 'IPV', 'WIN', 'GPT', 'ES', 'PEP', 'CP', 'AES', 'RSA',
  'X', 'GH', 'PR', 'MR', 'CR', 'COVID', 'IE', 'Y2K', 'H', 'P', 'V', 'D',
]);

/**
 * The project keys `projects` lets through: `[A-Z][A-Z0-9_]+-<n>` in text, except NOT_PROJECTS. With `projects` set,
 * only those projects, matched in any case (branch names are often lowercase: `abc-123-login`).
 */
function projectKeys(text: string, projects: readonly string[]): { at: number; key: string }[] {
  const wanted = new Set(projects.map((p) => p.toUpperCase()));
  const re = wanted.size ? new RegExp(PROJECT_KEY.source, 'i') : PROJECT_KEY;
  const out: { at: number; key: string }[] = [];
  for (const m of matchesOf(re, clip(text))) {
    const project = m[1].toUpperCase();
    if (wanted.size ? !wanted.has(project) : NOT_PROJECTS.has(project)) continue;
    out.push({ at: m.index, key: `${project}-${Number(m[2])}` });
  }
  return out;
}

/** A base URL without its trailing slashes, or '' when it is not http(s). */
export const baseUrl = (url: string): string => (/^https?:\/\/[^\s]+$/.test(url.trim()) ? url.trim().replace(/\/+$/, '') : '');

export interface JiraOptions {
  /** `devdesk.tickets.jira.baseUrl`: `https://example.atlassian.net`. Empty: no Jira. */
  baseUrl: string;
  /** `devdesk.tickets.jira.projects`: the project keys bare keys are taken for; empty: any (but NOT_PROJECTS). */
  projects: readonly string[];
  /** `devdesk.tickets.jira.command`: prints the issue `$DEVDESK_TICKET` as JSON; empty: link only. */
  command: string;
}

/** A Jira CLI's JSON for an issue: Jira's REST shape (`fields.summary`, `fields.status.name`), or flat fields. */
export function parseJiraIssue(json: string): TicketInfo | undefined {
  const o = parseObject(json);
  if (!o) return undefined;
  const fields = (typeof o.fields === 'object' && o.fields !== null ? o.fields : o) as Record<string, unknown>;
  const name = (v: unknown, ...keys: string[]): string => {
    if (typeof v === 'string') return v;
    if (typeof v !== 'object' || v === null) return '';
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'string' && x) return x;
    }
    return '';
  };
  const title = name(fields.summary) || name(fields.title);
  if (!title) return undefined;
  const assignee = name(fields.assignee, 'displayName', 'name', 'emailAddress');
  return { title, status: name(fields.status, 'name'), ...(assignee ? { assignee } : {}) };
}

/** Runs the user's `command` with the ticket key in `$DEVDESK_TICKET` (passed as an argument, never in the command text). */
export async function runTicketCommand(command: string, key: string, c: TicketFetchContext): Promise<string> {
  const r = await c.run('/bin/sh', ['-c', `DEVDESK_TICKET="$1"; export DEVDESK_TICKET; ${command}`, 'devdesk-ticket', key], { cwd: c.cwd, timeoutMs: c.timeoutMs, maxBytes: FETCH_BYTES });
  if (r.code !== 0) throw new Error(`${command.split(/\s+/)[0]}: ${r.stderr.trim().split('\n')[0] || `exit code ${r.code}`}`);
  return r.stdout;
}

/**
 * Jira: browse URLs on `baseUrl` (`/browse/ABC-123`, and `selectedIssue=ABC-123` board links), and bare keys when a base
 * URL is set. Fetch: `command` (a Jira CLI the user signed in to), when set; DevDesk keeps no Jira token.
 */
export function jiraTickets(o: JiraOptions): TicketProvider {
  const base = baseUrl(o.baseUrl);
  const ref = (key: string): TicketRef => ({ system: 'jira', key, url: `${base}/browse/${key}` });
  const fromUrl = (url: string): TicketRef | undefined => {
    if (!base || !url.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return undefined;
    const m = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)\b/.exec(url) ?? /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]+-\d+)\b/.exec(url);
    return m ? ref(m[1].toUpperCase()) : undefined;
  };
  return defineProvider({
    id: 'jira',
    label: 'Jira',
    parse(input) {
      if (!base) return undefined;
      const s = input.trim();
      if (/^https?:\/\//.test(s)) return fromUrl(s);
      const keys = projectKeys(s, o.projects);
      return keys.length === 1 && keys[0].at === 0 && s.length <= keys[0].key.length + 2 ? ref(keys[0].key) : undefined;
    },
    find(text) {
      if (!base) return [];
      const urls = [...matchesOf(URL_RE, clip(text))].flatMap((m) => {
        const r = fromUrl(m[0]);
        return r ? [{ at: m.index, ref: r }] : [];
      });
      // Keys inside a URL (another tracker's) are not Jira keys.
      const outside = clip(text).replace(URL_RE, (u) => ' '.repeat(u.length));
      const keys = projectKeys(outside, o.projects).map((k) => ({ at: k.at, ref: ref(k.key) }));
      return [...urls, ...keys].sort((a, b) => a.at - b.at).map((f) => f.ref);
    },
    ...(o.command.trim()
      ? {
          fetch: async (r: TicketRef, c: TicketFetchContext) => parseJiraIssue(await runTicketCommand(o.command, r.key, c)),
        }
      : {}),
  });
}

/**
 * Linear: issue URLs (`https://linear.app/<workspace>/issue/ENG-123/…`) anywhere, and bare keys when
 * `devdesk.tickets.linear.workspace` names the workspace (`ENG-123` → its issue URL). Link only: Linear's API needs a
 * token, which DevDesk does not keep.
 */
export function linearTickets(o: { workspace: string; teams: readonly string[] }): TicketProvider {
  const ws = o.workspace.trim().replace(/^https?:\/\/linear\.app\//, '').replace(/\/.*$/, '');
  const ref = (key: string, workspace = ws): TicketRef => ({ system: 'linear', key, url: `https://linear.app/${workspace}/issue/${key}` });
  const fromUrl = (url: string): TicketRef | undefined => {
    const m = /^https:\/\/linear\.app\/([A-Za-z0-9_-]+)\/issue\/([A-Za-z][A-Za-z0-9]+-\d+)/.exec(url);
    return m ? ref(m[2].toUpperCase(), m[1]) : undefined;
  };
  return defineProvider({
    id: 'linear',
    label: 'Linear',
    parse(input) {
      const s = input.trim();
      if (/^https?:\/\//.test(s)) return fromUrl(s);
      if (!ws) return undefined;
      const keys = projectKeys(s, o.teams);
      return keys.length === 1 && keys[0].at === 0 && s.length <= keys[0].key.length + 2 ? ref(keys[0].key) : undefined;
    },
    find(text) {
      const t = clip(text);
      const urls = [...matchesOf(URL_RE, t)].flatMap((m) => {
        const r = fromUrl(m[0]);
        return r ? [{ at: m.index, ref: r }] : [];
      });
      const keys = ws ? projectKeys(t.replace(URL_RE, (u) => ' '.repeat(u.length)), o.teams).map((k) => ({ at: k.at, ref: ref(k.key) })) : [];
      return [...urls, ...keys].sort((a, b) => a.at - b.at).map((f) => f.ref);
    },
  });
}

// ---- URL patterns from settings ----------------------------------------------------------------------------------

/** One entry of `devdesk.tickets.patterns`. */
export interface TicketPattern {
  name: string;
  regex: string;
  url: string;
}

/** `devdesk.tickets.patterns` as set: the entries with a name, a regex that compiles, and an http(s) URL template. */
export function validPatterns(raw: unknown): { patterns: TicketPattern[]; problems: string[] } {
  const patterns: TicketPattern[] = [];
  const problems: string[] = [];
  for (const [i, p] of (Array.isArray(raw) ? raw : []).entries()) {
    const e = p as Partial<TicketPattern> | null;
    if (!e || typeof e.name !== 'string' || !e.name.trim() || typeof e.regex !== 'string' || typeof e.url !== 'string') {
      problems.push(`entry ${i + 1}: needs a name, a regex and a url`);
      continue;
    }
    try {
      new RegExp(e.regex);
    } catch (err) {
      problems.push(`${e.name}: ${(err as Error).message}`);
      continue;
    }
    if (!/^https?:\/\//.test(e.url)) {
      problems.push(`${e.name}: its url must start with http:// or https://`);
      continue;
    }
    patterns.push({ name: e.name.trim(), regex: e.regex, url: e.url });
  }
  return { patterns, problems };
}

/** The pattern's URL for a match: `{key}` is the first group (or the match), `{0}`…`{9}` the groups, URL-encoded. */
export function patternUrl(template: string, m: RegExpExecArray): string {
  const key = m[1] ?? m[0];
  return template.replace(/\{(key|\d)\}/g, (_, g: string) => encodeURIComponent(g === 'key' ? key : (m[Number(g)] ?? '')));
}

/**
 * A provider from a `devdesk.tickets.patterns` entry: its regex finds keys in text and in a pasted input (the key being
 * the first group, else the match), and its URL template makes the link. Link only.
 */
export function patternTickets(p: TicketPattern): TicketProvider {
  const re = new RegExp(p.regex);
  const ref = (m: RegExpExecArray): TicketRef => ({ system: p.name, key: m[1] ?? m[0], url: patternUrl(p.url, m) });
  return defineProvider({
    id: p.name,
    label: p.name,
    parse(input) {
      const s = input.trim();
      const m = new RegExp(re.source, re.flags.replace('g', '')).exec(s);
      // The whole input: a pasted key or URL, not a sentence that has one.
      return m && m[0] === s ? ref(m) : undefined;
    },
    find: (text) => [...matchesOf(re, clip(text))].map(ref),
  });
}

// ---- The registry ------------------------------------------------------------------------------------------------

/**
 * The providers that are on, in order: the patterns first (the user's own rules win), then the built-in ones.
 * `enabled` (`devdesk.tickets.providers`) names the built-in ones on, and `patterns` for all the patterns; empty: all.
 */
export function enabledProviders(builtIn: readonly TicketProvider[], patterns: readonly TicketProvider[], enabled: readonly string[]): TicketProvider[] {
  if (!enabled.length) return [...patterns, ...builtIn];
  const on = new Set(enabled.map((e) => e.trim().toLowerCase()));
  return [...(on.has('patterns') ? patterns : []), ...builtIn.filter((p) => on.has(p.id.toLowerCase()))];
}

export interface TicketRegistry {
  readonly providers: readonly TicketProvider[];
  /** The ticket a pasted key or URL names: the first provider's that takes it. */
  parse(input: string, ctx?: TicketContext): TicketRef | undefined;
  /** The tickets named in `text`, first found first, each once (by URL). */
  find(text: string, ctx?: TicketContext): TicketRef[];
  /** The provider of a link's `system`. */
  provider(system: string): TicketProvider | undefined;
}

/** Asks `providers` in order; an earlier provider's key wins over a later one's at the same place in the text. */
export function ticketRegistry(providers: readonly TicketProvider[]): TicketRegistry {
  return {
    providers,
    parse(input, ctx) {
      const s = input.trim();
      if (!s) return undefined;
      for (const p of providers) {
        const r = p.parse(s, ctx);
        if (r) return r;
      }
      return undefined;
    },
    find(text, ctx) {
      const seen = new Set<string>();
      const keys = new Set<string>();
      const out: TicketRef[] = [];
      for (const p of providers) {
        for (const r of p.find(text, ctx)) {
          // The same key from two providers (Jira and Linear both take `ENG-12`): the earlier one's.
          if (seen.has(r.url) || keys.has(r.key)) continue;
          seen.add(r.url);
          keys.add(r.key);
          out.push(r);
        }
      }
      return out;
    },
    provider: (system) => providers.find((p) => p.id === system),
  };
}

/** A worktree's ticket found in its name and branch: the branch's first, else the name's. */
export function detectFromWorktree(registry: TicketRegistry, names: { name: string; branch?: string }, ctx?: TicketContext): TicketRef | undefined {
  for (const text of [names.branch, names.name]) {
    if (!text) continue;
    const found = registry.find(text, ctx);
    if (found.length) return found[0];
  }
  return undefined;
}

/** A session's ticket found in its first prompt: the first one named there. */
export const detectFromPrompt = (registry: TicketRegistry, prompt: string | undefined, ctx?: TicketContext): TicketRef | undefined =>
  prompt ? registry.find(prompt, ctx)[0] : undefined;

/**
 * The host, owner and repository of a GitHub remote URL (`https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://…`):
 * github.com, and GitHub Enterprise hosts named for it (github.example.com). The same as `parseGitHubRemote` of the
 * checks (`github.ts`), kept here too so this file stands alone on both release lines.
 */
export function githubRemote(url: string): { host: string; owner: string; repo: string } | undefined {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  if (host !== 'github.com' && !/(^|\.)github\./.test(host)) return undefined;
  return { host, owner: m[2], repo: m[3] };
}

/** The GitHub repository of `git remote -v`'s output (origin's first), for `#123`. */
export function githubContext(remotes: string): TicketContext {
  const lines = remotes.split('\n').filter(Boolean);
  const ordered = [...lines.filter((l) => l.startsWith('origin\t')), ...lines.filter((l) => !l.startsWith('origin\t'))];
  for (const l of ordered) {
    const gh = githubRemote(l.split(/\s+/)[1] ?? '');
    if (gh) return { github: gh };
  }
  return {};
}

// ---- Links, as kept ----------------------------------------------------------------------------------------------

/** A ticket linked to a worktree or a session, as both DevDesk Claude versions keep it (shared state). */
export interface TicketLink extends TicketRef {
  /** How it was linked: found in a name or prompt, by hand (Link Ticket…), or by Claude (`devdesk ticket`). */
  source: 'auto' | 'manual' | 'cli';
  at: number;
  /** What was last read about it, and when (a title given by hand has no `fetchedAt`). */
  title?: string;
  status?: string;
  assignee?: string;
  fetchedAt?: number;
}

/** A link removed by hand: auto-detection leaves the worktree or session alone afterwards. */
export interface TicketUnlinked {
  unlinked: true;
  at: number;
}

export type TicketEntry = TicketLink | TicketUnlinked;

/** The shared `globalState` key the links are kept under: `[target, entry]` pairs (see `sharedState.ts`). */
export const TICKET_LINKS_KEY = 'devdesk.tickets.links';
/** A link's target: a worktree directory, or a Claude session id. */
export const worktreeTarget = (dir: string) => `worktree:${dir}`;
export const sessionTarget = (sessionId: string) => `session:${sessionId}`;

export const isLink = (e: TicketEntry | undefined): e is TicketLink => !!e && !('unlinked' in e);

/** The saved entries, those that look right only. */
export function parseLinks(raw: unknown): Map<string, TicketEntry> {
  const out = new Map<string, TicketEntry>();
  if (!Array.isArray(raw)) return out;
  for (const e of raw) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'object' || e[1] === null) continue;
    const v = e[1] as Record<string, unknown>;
    if (v.unlinked === true && typeof v.at === 'number') out.set(e[0], { unlinked: true, at: v.at });
    else if (typeof v.system === 'string' && typeof v.key === 'string' && typeof v.url === 'string' && /^https?:\/\//.test(v.url)) {
      out.set(e[0], {
        system: v.system,
        key: v.key,
        url: v.url,
        source: v.source === 'manual' || v.source === 'cli' ? v.source : 'auto',
        at: typeof v.at === 'number' ? v.at : 0,
        ...(typeof v.title === 'string' ? { title: v.title } : {}),
        ...(typeof v.status === 'string' ? { status: v.status } : {}),
        ...(typeof v.assignee === 'string' ? { assignee: v.assignee } : {}),
        ...(typeof v.fetchedAt === 'number' ? { fetchedAt: v.fetchedAt } : {}),
      });
    }
  }
  return out;
}

/** The most links kept: the oldest go first. */
export const MAX_LINKS = 2000;

/** The entries as saved: newest last, at most MAX_LINKS. */
export function serializeLinks(links: ReadonlyMap<string, TicketEntry>): [string, TicketEntry][] {
  return [...links].sort((a, b) => a[1].at - b[1].at).slice(-MAX_LINKS);
}

/** The chip's text: `ABC-123 · In progress`. */
export const ticketChip = (l: Pick<TicketLink, 'key' | 'status'>): string => (l.status ? `${l.key} · ${l.status}` : l.key);

/** The hover's lines: the key and title, then the status and assignee, then the URL. */
export function ticketHover(l: TicketLink, label?: string): string {
  return [
    `${label ? `${label} ` : ''}${l.key}${l.title ? `: ${l.title}` : ''}`,
    [l.status && `Status: ${l.status}`, l.assignee && `Assignee: ${l.assignee}`].filter(Boolean).join(' · '),
    l.url,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The line a new session's prompt gets (`devdesk.tickets.includeInPrompt`). */
export function ticketPromptLine(l: TicketLink): string {
  return `Ticket: ${l.key}${l.title ? ` "${l.title}"` : ''}${l.status ? ` (${l.status})` : ''} ${l.url}`;
}

/** `prompt` with its ticket line after it; a prompt naming the ticket already is left as it is. */
export function withTicketLine(prompt: string, l: TicketLink | undefined): string {
  if (!l || prompt.includes(l.url) || new RegExp(`(?<![\\w-])${l.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(prompt)) return prompt;
  return `${prompt}\n\n${ticketPromptLine(l)}`;
}

// ---- Fetching, cached --------------------------------------------------------------------------------------------

/** What a fetch gave: the ticket's fields, nothing (the provider can't read it), or why it failed. */
export type FetchResult = { info: TicketInfo | undefined; at: number } | { error: string; at: number };

/**
 * Fetches tickets at most once per `ttlMs` each (by URL), a failure too (so a missing CLI is not run on every redraw),
 * with one fetch in flight per ticket.
 */
export class TicketFetchCache {
  private readonly results = new Map<string, FetchResult>();
  private readonly inFlight = new Map<string, Promise<FetchResult>>();
  /** Fetches started (the tests check the cache holds). */
  fetches = 0;

  constructor(
    private readonly fetchOne: (ref: TicketRef) => Promise<TicketInfo | undefined>,
    private readonly ttlMs: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last result for `ref`, however old. */
  cached(ref: Pick<TicketRef, 'url'>): FetchResult | undefined {
    return this.results.get(ref.url);
  }

  /** True when `ref` has no result younger than the TTL and none is being fetched. */
  due(ref: Pick<TicketRef, 'url'>): boolean {
    const r = this.results.get(ref.url);
    return !this.inFlight.has(ref.url) && (!r || this.now() - r.at >= this.ttlMs());
  }

  /** The result for `ref`: the cached one while fresh (unless `force`), else a fetch (shared with one in flight). */
  get(ref: TicketRef, force = false): Promise<FetchResult> {
    const running = this.inFlight.get(ref.url);
    if (running) return running;
    const r = this.results.get(ref.url);
    if (r && !force && this.now() - r.at < this.ttlMs()) return Promise.resolve(r);
    this.fetches++;
    const p = this.fetchOne(ref).then(
      (info): FetchResult => ({ info, at: this.now() }),
      (err: unknown): FetchResult => ({ error: (err as Error).message, at: this.now() }),
    );
    this.inFlight.set(ref.url, p);
    return p.then((res) => {
      this.inFlight.delete(ref.url);
      this.results.set(ref.url, res);
      return res;
    });
  }

  clear(): void {
    this.results.clear();
  }
}
