import { describe, expect, it } from 'vitest';
import {
  detectFromPrompt,
  detectFromWorktree,
  enabledProviders,
  githubContext,
  githubRemote,
  githubTickets,
  jiraTickets,
  linearTickets,
  MAX_SCAN_CHARS,
  parseGhIssue,
  parseJiraIssue,
  parseLinks,
  patternTickets,
  serializeLinks,
  TicketFetchCache,
  ticketChip,
  ticketHover,
  type TicketLink,
  type TicketRun,
  ticketRegistry,
  validPatterns,
  withTicketLine,
} from '../src/core/tickets';
import { isSharedGlobalKey } from '../src/core/sharedState';

const repo = { github: { host: 'github.com', owner: 'acme', repo: 'shop' } };
const jira = jiraTickets({ baseUrl: 'https://acme.atlassian.net/', projects: [], command: '' });
const linear = linearTickets({ workspace: 'acme', teams: [] });

describe('GitHub issues', () => {
  it('parses issue URLs, owner/repo#n, and #n or GH-n for the worktree repo', () => {
    expect(githubTickets.parse('https://github.com/acme/shop/issues/42')).toEqual({ system: 'github', key: 'acme/shop#42', url: 'https://github.com/acme/shop/issues/42' });
    expect(githubTickets.parse('https://github.example.com/a/b/issues/7#issuecomment-1')?.url).toBe('https://github.example.com/a/b/issues/7');
    expect(githubTickets.parse('acme/shop#9')?.url).toBe('https://github.com/acme/shop/issues/9');
    expect(githubTickets.parse('#12', repo)).toEqual({ system: 'github', key: '#12', url: 'https://github.com/acme/shop/issues/12' });
    expect(githubTickets.parse('gh-12', repo)?.key).toBe('#12');
    expect(githubTickets.matches('#12', repo)).toBe(true);
  });

  it('refuses what is not a GitHub issue', () => {
    expect(githubTickets.parse('#12')).toBeUndefined(); // no repository to put it in
    expect(githubTickets.parse('https://github.com/acme/shop/pull/42')).toBeUndefined();
    expect(githubTickets.parse('https://gitlab.com/acme/shop/issues/42')).toBeUndefined();
    expect(githubTickets.parse('12', repo)).toBeUndefined();
    expect(githubTickets.matches('fix #12 please', repo)).toBe(false);
  });

  it('finds issues in prompts only where they are clearly issues', () => {
    expect(githubTickets.find('Fixes #31 and see https://github.com/acme/shop/issues/5.', repo).map((r) => r.key)).toEqual(['#31', 'acme/shop#5']);
    expect(githubTickets.find('make it the #1 priority, step #2', repo)).toEqual([]);
    expect(githubTickets.find('closes #4', {})).toEqual([]);
  });

  it('finds issues in branch names', () => {
    expect(githubTickets.find('issue-123', repo)[0]?.key).toBe('#123');
    expect(githubTickets.find('feat/77-login', repo)[0]?.key).toBe('#77');
    expect(githubTickets.find('release-2024', repo)).toEqual([]);
    expect(githubTickets.find('v2-rewrite', repo)).toEqual([]);
  });

  it('reads gh issue view read-only, and its answer', async () => {
    const calls: string[][] = [];
    const run: TicketRun = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: JSON.stringify({ title: 'Login fails', state: 'OPEN', assignees: [{ login: 'ana' }] }), stderr: '' };
    };
    const ref = githubTickets.parse('#3', repo)!;
    expect(await githubTickets.fetch!(ref, { run, cwd: '/w', timeoutMs: 1000, gh: 'gh' })).toEqual({ title: 'Login fails', status: 'Open', assignee: 'ana' });
    expect(calls).toEqual([['gh', 'issue', 'view', '3', '-R', 'acme/shop', '--json', 'title,state,assignees']]);
    expect(parseGhIssue('{"title":"x","state":"CLOSED","assignees":[]}')).toEqual({ title: 'x', status: 'Closed' });
    expect(parseGhIssue('nope')).toBeUndefined();
  });

  it('says when gh is missing or fails', async () => {
    const missing: TicketRun = async () => ({ code: null, stdout: '', stderr: '', missing: true });
    const failing: TicketRun = async () => ({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue\n' });
    const ref = githubTickets.parse('#3', repo)!;
    await expect(githubTickets.fetch!(ref, { run: missing, cwd: '/', timeoutMs: 1, gh: 'gh' })).rejects.toThrow(/not installed/);
    await expect(githubTickets.fetch!(ref, { run: failing, cwd: '/', timeoutMs: 1, gh: 'gh' })).rejects.toThrow('gh issue view: GraphQL: Could not resolve to an issue');
  });

  it("reads the worktree's GitHub repository from git remote -v, origin first", () => {
    expect(githubContext('upstream\thttps://github.com/up/shop.git (fetch)\norigin\tgit@github.com:acme/shop.git (fetch)\n')).toEqual(repo);
    expect(githubContext('origin\thttps://gitlab.com/a/b.git (fetch)\n')).toEqual({});
    expect(githubRemote('ssh://git@github.example.com:22/o/r.git')).toEqual({ host: 'github.example.com', owner: 'o', repo: 'r' });
    expect(githubRemote('https://notgithub.com/o/r')).toBeUndefined();
  });
});

describe('Jira', () => {
  it('parses keys and browse links on its site', () => {
    expect(jira.parse('ABC-123')).toEqual({ system: 'jira', key: 'ABC-123', url: 'https://acme.atlassian.net/browse/ABC-123' });
    expect(jira.parse('https://acme.atlassian.net/browse/ABC-9?focus=1')?.key).toBe('ABC-9');
    expect(jira.parse('https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-4')?.key).toBe('ABC-4');
  });

  it('takes nothing without a base URL, and no false positives', () => {
    expect(jiraTickets({ baseUrl: '', projects: [], command: '' }).parse('ABC-123')).toBeUndefined();
    expect(jira.parse('https://other.atlassian.net/browse/ABC-1')).toBeUndefined();
    expect(jira.parse('UTF-8')).toBeUndefined();
    expect(jira.parse('abc-123')).toBeUndefined();
    expect(jira.parse('see ABC-123 now')).toBeUndefined();
    expect(jira.find('Use UTF-8 and SHA-256, ISO-8601 dates, not x-1 or A-1; fix ABC-12.').map((r) => r.key)).toEqual(['ABC-12']);
    expect(jira.find('my-branch-2')).toEqual([]);
  });

  it('with projects, takes only those, in any case', () => {
    const only = jiraTickets({ baseUrl: 'https://j.example.com', projects: ['abc'], command: '' });
    expect(only.find('feat/abc-42-login').map((r) => r.key)).toEqual(['ABC-42']);
    expect(only.find('XYZ-1 and ABC-2').map((r) => r.key)).toEqual(['ABC-2']);
    expect(only.parse('XYZ-1')).toBeUndefined();
  });

  it('fetches with the configured command, the key passed as an argument', async () => {
    const calls: string[][] = [];
    const run: TicketRun = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: JSON.stringify({ key: 'ABC-1', fields: { summary: 'Checkout', status: { name: 'In Progress' }, assignee: { displayName: 'Ana' } } }), stderr: '' };
    };
    const withCommand = jiraTickets({ baseUrl: 'https://j.example.com', projects: [], command: 'jira issue view "$DEVDESK_TICKET" --raw' });
    const ref = withCommand.parse('ABC-1')!;
    expect(await withCommand.fetch!(ref, { run, cwd: '/w', timeoutMs: 1000, gh: 'gh' })).toEqual({ title: 'Checkout', status: 'In Progress', assignee: 'Ana' });
    expect(calls[0].slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(calls[0].slice(3)).toEqual(['devdesk-ticket', 'ABC-1']);
    expect(jira.fetch).toBeUndefined(); // no command: link only
    expect(parseJiraIssue('{"title":"t","status":"Done"}')).toEqual({ title: 't', status: 'Done' });
    expect(parseJiraIssue('{"fields":{}}')).toBeUndefined();
  });
});

describe('Linear', () => {
  it('parses issue URLs anywhere, and keys with a workspace', () => {
    const noWs = linearTickets({ workspace: '', teams: [] });
    expect(noWs.parse('https://linear.app/acme/issue/ENG-12/fix-login')).toEqual({ system: 'linear', key: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12' });
    expect(noWs.parse('ENG-12')).toBeUndefined();
    expect(linear.parse('ENG-12')?.url).toBe('https://linear.app/acme/issue/ENG-12');
    expect(linear.fetch).toBeUndefined();
  });
});

describe('patterns from settings', () => {
  it('keeps valid entries and says what is wrong with the others', () => {
    const { patterns, problems } = validPatterns([
      { name: 'Bugzilla', regex: '\\bbug ?(\\d{4,})\\b', url: 'https://bugs.example.com/show_bug.cgi?id={key}' },
      { name: 'Bad', regex: '(', url: 'https://x' },
      { name: 'NoUrl', regex: 'x', url: 'javascript:alert(1)' },
      { regex: 'x' },
    ]);
    expect(patterns.map((p) => p.name)).toEqual(['Bugzilla']);
    expect(problems).toHaveLength(3);
    expect(validPatterns('nope')).toEqual({ patterns: [], problems: [] });
  });

  it('finds keys in text and parses a whole input only, URL-encoding the groups', () => {
    const bz = patternTickets({ name: 'Bugzilla', regex: '\\bbug ?(\\d{4,})\\b', url: 'https://bugs.example.com/show_bug.cgi?id={key}' });
    expect(bz.find('see bug 12345 and bug9999')).toEqual([
      { system: 'Bugzilla', key: '12345', url: 'https://bugs.example.com/show_bug.cgi?id=12345' },
      { system: 'Bugzilla', key: '9999', url: 'https://bugs.example.com/show_bug.cgi?id=9999' },
    ]);
    expect(bz.parse('bug 12345')?.key).toBe('12345');
    expect(bz.parse('see bug 12345')).toBeUndefined();
    const groups = patternTickets({ name: 'G', regex: '(\\w+)/(\\w+)', url: 'https://x.example/{1}?q={2}' });
    expect(groups.parse('a/b c')).toBeUndefined();
    expect(groups.find('a/b')[0].url).toBe('https://x.example/a?q=b');
  });

  it('scans only the start of long text', () => {
    const p = patternTickets({ name: 'T', regex: 'T-(\\d+)', url: 'https://t.example/{key}' });
    expect(p.find(`${'x'.repeat(MAX_SCAN_CHARS)} T-1`)).toEqual([]);
  });
});

describe('the registry', () => {
  it('turns on the providers named, patterns first', () => {
    const pat = patternTickets({ name: 'Mine', regex: 'MINE-(\\d+)', url: 'https://m.example/{key}' });
    expect(enabledProviders([githubTickets, jira], [pat], []).map((p) => p.id)).toEqual(['Mine', 'github', 'jira']);
    expect(enabledProviders([githubTickets, jira], [pat], ['jira']).map((p) => p.id)).toEqual(['jira']);
    expect(enabledProviders([githubTickets, jira], [pat], ['patterns', 'GitHub']).map((p) => p.id)).toEqual(['Mine', 'github']);
  });

  it("asks providers in order, and finds each ticket once (the earlier provider's)", () => {
    const r = ticketRegistry([githubTickets, jira, linear]);
    expect(r.parse('ENG-5')?.system).toBe('jira');
    expect(r.parse('https://linear.app/acme/issue/ENG-5')?.system).toBe('linear');
    expect(r.parse('   ')).toBeUndefined();
    expect(r.find('ENG-5 and ENG-5 again, then #2', repo).map((t) => `${t.system}:${t.key}`)).toEqual(['jira:ENG-5']);
    expect(r.provider('linear')).toBe(linear);
  });

  it('detects a worktree ticket from its branch first, then its name', () => {
    const r = ticketRegistry([githubTickets, jira]);
    expect(detectFromWorktree(r, { name: 'login', branch: 'feat/ABC-7-login' })?.key).toBe('ABC-7');
    expect(detectFromWorktree(r, { name: 'ABC-8', branch: 'main' })?.key).toBe('ABC-8');
    expect(detectFromWorktree(r, { name: 'login', branch: 'main' })).toBeUndefined();
    expect(detectFromPrompt(r, 'Please fix ABC-9 (crash on save)')?.key).toBe('ABC-9');
    expect(detectFromPrompt(r, undefined)).toBeUndefined();
  });
});

describe('links as kept', () => {
  const link: TicketLink = { system: 'jira', key: 'ABC-1', url: 'https://j.example.com/browse/ABC-1', source: 'manual', at: 5, title: 'Checkout', status: 'In Progress' };

  it('round-trips, drops what is malformed, and keeps unlinked marks', () => {
    const saved = serializeLinks(new Map<string, TicketLink | { unlinked: true; at: number }>([['worktree:/w', link], ['session:s', { unlinked: true, at: 9 }]]));
    expect(parseLinks(JSON.parse(JSON.stringify(saved)))).toEqual(new Map<string, unknown>([['worktree:/w', link], ['session:s', { unlinked: true, at: 9 }]]));
    expect(parseLinks([['x', { system: 'a', key: 'b', url: 'javascript:1' }], ['y', null], 'z', [1, {}]]).size).toBe(0);
    expect(parseLinks(undefined).size).toBe(0);
  });

  it('is shared by both DevDesk Claude versions', () => {
    expect(isSharedGlobalKey('devdesk.tickets.links')).toBe(true);
  });

  it('shows a chip, a hover and a prompt line', () => {
    expect(ticketChip(link)).toBe('ABC-1 · In Progress');
    expect(ticketChip({ key: 'ABC-1' })).toBe('ABC-1');
    expect(ticketHover({ ...link, assignee: 'Ana' }, 'Jira')).toBe('Jira ABC-1: Checkout\nStatus: In Progress · Assignee: Ana\nhttps://j.example.com/browse/ABC-1');
    expect(withTicketLine('Add tests', link)).toBe('Add tests\n\nTicket: ABC-1 "Checkout" (In Progress) https://j.example.com/browse/ABC-1');
    expect(withTicketLine('Fix ABC-1 now', link)).toBe('Fix ABC-1 now');
    expect(withTicketLine('Fix ABC-12 now', link)).not.toBe('Fix ABC-12 now');
    expect(withTicketLine('x', undefined)).toBe('x');
  });
});

describe('TicketFetchCache', () => {
  const ref = { system: 'github', key: '#1', url: 'https://github.com/a/b/issues/1' };

  it('fetches once per TTL, a failure too, with one fetch in flight', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const cache = new TicketFetchCache(
      async () => {
        calls++;
        if (fail) throw new Error('offline');
        return { title: 't', status: 'Open' };
      },
      () => 1000,
      () => now,
    );
    const [a, b] = await Promise.all([cache.get(ref), cache.get(ref)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    now = 999;
    expect(cache.due(ref)).toBe(false);
    await cache.get(ref);
    expect(calls).toBe(1);
    now = 1000;
    fail = true;
    expect(await cache.get(ref)).toEqual({ error: 'offline', at: 1000 });
    expect(calls).toBe(2);
    await cache.get(ref);
    expect(calls).toBe(2); // the failure is kept as long
    await cache.get(ref, true);
    expect(calls).toBe(3);
    expect(cache.fetches).toBe(3);
  });
});
