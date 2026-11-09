import { describe, expect, it } from 'vitest';
import { buildBoard } from '../src/core/board';
import {
  buildDigest,
  buildRequest,
  foldText,
  matchesQuery,
  parseQuery,
  parseSearchAnswer,
  recentPrompts,
  SEARCH_PROMPT,
  searchCacheKey,
  searchFields,
  searchSessions,
} from '../src/core/boardSearch';
import { parseCallOutput, unwrapCallOutput } from '../src/core/insights';
import type { SessionCard } from '../src/core/sessions';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const baseOpts = { now: NOW, idleMs: 30 * MIN, stuckMs: 10 * MIN, unread: new Set<string>(), unreadFirst: true };
const opts = (over: Record<string, unknown> = {}) => ({ ...baseOpts, ...over });
const card = (over: Partial<SessionCard> & { id: string }): SessionCard => ({
  sessionId: '0b7d1c9e-1111-4222-8333-944455556666',
  tmuxSession: `cc-${over.id}`,
  tmuxPane: '%1',
  cwd: `/ws/worktrees/${over.id}`,
  featureName: over.id,
  featureDir: `/ws/worktrees/${over.id}`,
  state: 'done',
  detail: 'Finished',
  prompt: `do ${over.id}`,
  updatedAt: NOW - MIN,
  attached: false,
  ...over,
});

const fields = searchFields({
  title: 'Fix the Auth integration test',
  worktree: 'feat-a',
  laneTitle: 'Needs you',
  lookLabel: 'QUESTION FOR YOU',
  state: 'waiting',
  model: 'opus',
  texts: ['Run the café tests', undefined, 'Claude asks: merge now?'],
});

describe('foldText', () => {
  it('lowercases, removes accents and collapses whitespace', () => {
    expect(foldText('  Café\n\tDÉJÀ  vu ')).toBe('cafe deja vu');
  });
});

describe('parseQuery', () => {
  it('splits on whitespace and reads wt: and is:', () => {
    expect(parseQuery('Auth  wt:Feat-A is:needs')).toEqual([
      { field: 'all', text: 'auth' },
      { field: 'wt', text: 'feat-a' },
      { field: 'is', text: 'needs' },
    ]);
  });

  it('ignores a bare wt: or is:, and keeps other punctuation as plain text', () => {
    expect(parseQuery('wt: is: fix(auth) "quoted" a.b*')).toEqual([
      { field: 'all', text: 'fix(auth)' },
      { field: 'all', text: '"quoted"' },
      { field: 'all', text: 'a.b*' },
    ]);
  });

  it('has no terms for a blank query', () => {
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('matchesQuery', () => {
  const m = (q: string) => matchesQuery(fields, parseQuery(q));

  it('needs every term, as a substring, case and accent insensitive', () => {
    expect(m('auth test')).toBe(true);
    expect(m('AUTH cafe')).toBe(true);
    expect(m('auth parser')).toBe(false);
    expect(m('integ')).toBe(true);
  });

  it('matches the worktree, state, model and the other texts', () => {
    expect(m('feat-a')).toBe(true);
    expect(m('opus')).toBe(true);
    expect(m('merge now')).toBe(true);
  });

  it('wt: looks at the worktree only, is: at the lane, look and state only', () => {
    expect(m('wt:feat')).toBe(true);
    expect(m('wt:auth')).toBe(false);
    expect(m('is:needs')).toBe(true);
    expect(m('is:waiting')).toBe(true);
    expect(m('is:question')).toBe(true);
    expect(m('is:parked')).toBe(false);
    expect(m('is:auth')).toBe(false);
  });

  it('matches everything with no terms, and never throws on regex characters', () => {
    expect(m('')).toBe(true);
    expect(m('fix(auth')).toBe(false);
    expect(m('[')).toBe(false);
  });
});

const userLine = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });

describe('recentPrompts', () => {
  it('gives the last user prompts, oldest first, skipping meta, tool results and repeats', () => {
    const lines = [
      userLine('first'),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
      userLine('second'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }),
      userLine('third'),
      userLine('third'),
      userLine('fourth'),
      'not json',
    ];
    expect(recentPrompts(lines)).toEqual(['second', 'third', 'fourth']);
  });
});

describe('searchSessions and buildDigest', () => {
  it('lists the visible cards, then the hidden parked ones, with their lane and card', () => {
    const cards = [card({ id: 'a', state: 'waiting', prompt: 'Fix auth' }), ...[1, 2].map((i) => card({ id: `p${i}`, state: 'parked', cwd: '/w', updatedAt: 10 - i }))];
    const list = searchSessions(buildBoard(cards, [], opts({ parkedLimit: 1 })), cards);
    expect(list.map((s) => s.session.id)).toEqual(['a', 'p1', 'p2']);
    expect(list[0].laneTitle).toBe('Needs you');
    expect(list[0].card?.prompt).toBe('Fix auth');
  });

  it('builds a short digest: lane and look as the state, the first prompt then the recent ones, fields cut', () => {
    const cards = [card({ id: 'a', state: 'waiting', prompt: 'x'.repeat(500), summary: 'y'.repeat(500) })];
    const [s] = searchSessions(buildBoard(cards, [], opts()), cards);
    const d = buildDigest(s, ['later prompt', 'x'.repeat(500)]);
    expect(d.id).toBe('a');
    expect(d.state.startsWith('Needs you: ')).toBe(true);
    expect(d.recap!.length).toBeLessThanOrEqual(140);
    expect(d.prompts.length).toBeLessThanOrEqual(4);
    expect(d.prompts.every((p) => p.length <= 60)).toBe(true);
    expect(d.prompts.filter((p) => p.startsWith('xxx')).length).toBe(1);
    expect(JSON.stringify(d).length).toBeLessThan(800);
  });
});

describe('buildRequest', () => {
  it('carries the query, the time and the digests; the instructions only when asked', () => {
    const r = buildRequest('the auth one', Date.UTC(2026, 10, 2, 12), [], true);
    expect(r).toEqual({ instructions: SEARCH_PROMPT, query: 'the auth one', now: '2026-11-02T12:00:00.000Z', sessions: [] });
    expect(buildRequest('q', 0, [], false).instructions).toBeUndefined();
  });
});

describe('parseSearchAnswer', () => {
  const ids = new Set(['a', 'b']);

  it('reads matches and the note', () => {
    expect(parseSearchAnswer('{"matches":[{"id":"a","reason":"About auth"}],"note":"1 found"}', ids)).toEqual({ matches: [{ id: 'a', reason: 'About auth' }], note: '1 found' });
  });

  it('tolerates a code fence, drops unknown ids, collapses repeats, cuts reasons to one line', () => {
    const reply = '```json\n{"matches":[{"id":"zz","reason":"x"},{"id":"b","reason":"line one\\nline two ' + 'r'.repeat(300) + '"},{"id":"b","reason":"again"},{"id":"a"}]}\n```';
    const answer = parseSearchAnswer(reply, ids)!;
    expect(answer.matches.map((m) => m.id)).toEqual(['b', 'a']);
    expect(answer.matches[0].reason.startsWith('line one line two')).toBe(true);
    expect(answer.matches[0].reason.length).toBeLessThanOrEqual(160);
    expect(answer.matches[1].reason).toBe('');
  });

  it('accepts no matches, rejects anything that is not the asked JSON', () => {
    expect(parseSearchAnswer('{"matches":[]}', ids)).toEqual({ matches: [] });
    expect(parseSearchAnswer('sorry, I cannot', ids)).toBeUndefined();
    expect(parseSearchAnswer('{"results":[]}', ids)).toBeUndefined();
    expect(parseSearchAnswer('', ids)).toBeUndefined();
  });
});

describe('searchCacheKey', () => {
  const d = { id: 'a', title: 't', worktree: 'main', state: 's', ago: '1m', prompts: [] };
  it('is the same for the same backend, folded query and digests, and differs otherwise', () => {
    expect(searchCacheKey('claude haiku', 'Auth  one', [d])).toBe(searchCacheKey('claude haiku', 'auth one', [d]));
    expect(searchCacheKey('claude haiku', 'auth', [d])).not.toBe(searchCacheKey('claude opus', 'auth', [d]));
    expect(searchCacheKey('claude haiku', 'auth', [d])).not.toBe(searchCacheKey('claude haiku', 'auth', [{ ...d, title: 'u' }]));
  });
});

describe('unwrapCallOutput', () => {
  it('gives the reply text of a claude -p json result, and its errors', () => {
    expect(unwrapCallOutput('{"type":"result","is_error":false,"result":"{\\"matches\\":[]}"}').reply).toBe('{"matches":[]}');
    expect(unwrapCallOutput('{"type":"result","is_error":true,"result":"rate limited"}').error).toBe('rate limited');
    expect(unwrapCallOutput('garbage').error).toBe('no JSON result from claude');
  });

  it('leaves parseCallOutput as it was', () => {
    expect(parseCallOutput('{"is_error":false,"result":"{\\"title\\":\\"Fix parser\\"}"}').answer?.title).toBe('Fix parser');
  });
});
