import { describe, expect, it } from 'vitest';
import { emptyEntry, type HistoryEntry } from '../src/core/historyIndex';
import { buildDocs, foldWithMap, historyDigest, searchCandidates, searchTranscripts } from '../src/core/historySearch';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3);
const entry = (id: string, o: Partial<HistoryEntry> & { prompts?: string[]; replies?: string[] } = {}): HistoryEntry => {
  const e = { ...emptyEntry(), sessionId: id, cwd: '/w/app', lastAt: NOW - DAY, firstAt: NOW - DAY, ...o };
  e.turns = [...(o.prompts ?? []).map((text) => ({ role: 'user' as const, text })), ...(o.replies ?? []).map((text) => ({ role: 'claude' as const, text }))];
  return e;
};
const docsOf = (entries: HistoryEntry[]) => buildDocs(entries.map((entry, i) => ({ path: `/p/${i}.jsonl`, entry })), { root: '/w/app', scope: 'workspace', worktreeOf: (cwd) => (cwd?.includes('feat') ? 'feat' : 'main') });
const search = (entries: HistoryEntry[], q: string, exclude: string[] = []) => searchTranscripts(docsOf(entries), q, { now: NOW, limit: 20, onBoard: new Set(exclude) }).past;

describe('buildDocs', () => {
  it('leaves out entries without a session id, out of scope, and keeps the latest copy of a session', () => {
    const docs = docsOf([entry('a'), { ...entry('b'), cwd: '/w/app-old' }, { ...emptyEntry(), cwd: '/w/app' }, entry('c', { lastAt: NOW - 3 * DAY }), entry('c', { lastAt: NOW - DAY, customTitle: 'newer' })]);
    expect(docs.map((d) => d.id).sort()).toEqual(['a', 'c']);
    expect(docs.find((d) => d.id === 'c')!.title).toBe('newer');
  });

  it('keeps sessions recorded under the root\'s resolved path (a symlinked root)', () => {
    const docs = buildDocs([{ path: '/p/r.jsonl', entry: { ...entry('r'), cwd: '/private/w/app/sub' } }], { root: '/w/app', realRoot: '/private/w/app', scope: 'workspace', worktreeOf: () => 'main' });
    expect(docs.map((d) => d.id)).toEqual(['r']);
  });
  it('labels the worktree from the launch folder, not a later cd', () => {
    const docs = docsOf([{ ...entry('a'), startCwd: '/w/app/feat', cwd: '/w/app/main/sub' }, entry('b')]);
    expect(docs.map((d) => d.worktree)).toEqual(['feat', 'main']);
  });
});

describe('searchTranscripts (past)', () => {
  it('needs every term, case and accent insensitive, in any field', () => {
    const es = [entry('a', { prompts: ['Fix the flaky parser test'] }), entry('b', { replies: ['The café build passes'] }), entry('c', { files: ['/w/app/src/Parser.ts'] })];
    expect(search(es, 'parser flaky').map((h) => h.id)).toEqual(['a']);
    expect(search(es, 'CAFE').map((h) => h.id)).toEqual(['b']);
    expect(search(es, 'parser').map((h) => h.id).sort()).toEqual(['a', 'c']);
    expect(search(es, 'nothing')).toEqual([]);
    expect(search(es, '')).toEqual([]);
  });

  it('ranks a match in the title over one in a reply, and a recent match over an old one', () => {
    const byField = [entry('reply', { customTitle: 'other', replies: ['deploy'] }), entry('title', { customTitle: 'deploy', prompts: ['other words here'] })];
    expect(searchCandidates(docsOf(byField), 'deploy', { now: NOW, limit: 2, onBoard: new Set() }).past.map((c) => c.hit.id)).toEqual(['title', 'reply']);
    const recent = [entry('old', { prompts: ['deploy'], lastAt: NOW - 60 * DAY }), entry('new', { prompts: ['deploy'], lastAt: NOW - DAY })];
    expect(searchCandidates(docsOf(recent), 'deploy', { now: NOW, limit: 2, onBoard: new Set() }).past[0].hit.id).toBe('new');
  });

  it('returns the best matches newest first', () => {
    const es = [entry('a', { prompts: ['deploy'], lastAt: NOW - 3 * DAY }), entry('b', { prompts: ['deploy'], lastAt: NOW - DAY })];
    expect(search(es, 'deploy').map((h) => h.id)).toEqual(['b', 'a']);
  });

  it('keeps at most `limit` results', () => {
    const es = Array.from({ length: 30 }, (_, i) => entry(`s${i}`, { prompts: ['common word'], lastAt: NOW - i * DAY }));
    expect(search(es, 'common').length).toBe(20);
  });

  it('wt: looks at the worktree; is:history keeps history; another is: excludes it', () => {
    const es = [entry('m', { prompts: ['auth'] }), entry('f', { prompts: ['auth'], cwd: '/w/app/.claude/worktrees/feat' })];
    expect(search(es, 'auth wt:feat').map((h) => h.id)).toEqual(['f']);
    expect(search(es, 'auth is:history').map((h) => h.id).sort()).toEqual(['f', 'm']);
    expect(search(es, 'auth is:hist').length).toBe(2);
    expect(search(es, 'auth is:needs')).toEqual([]);
    expect(search(es, 'is:history').length).toBe(2);
  });

  it('leaves out sessions on the board', () => {
    expect(search([entry('a', { prompts: ['auth'] })], 'auth', ['a'])).toEqual([]);
  });

  it('gives up to 3 excerpts with spans on the original text, prompts first', () => {
    const es = [entry('a', { prompts: ['first: the AUTH  token\nexpired'], replies: ['Renewed the auth token.', 'auth again', 'auth more'] })];
    const [hit] = search(es, 'auth token');
    expect(hit.excerpts.length).toBe(3);
    const ex = hit.excerpts[0];
    expect(ex.text).toContain('the AUTH token expired');
    expect(ex.spans.map(([s, e]) => ex.text.slice(s, e))).toEqual(['AUTH', 'token']);
    expect(hit.excerpts.every((x) => x.text.length <= 162)).toBe(true);
  });

  it('marks matches in accented text at the right place', () => {
    const [hit] = search([entry('a', { prompts: ['Ça marche: café crème'] })], 'creme');
    const ex = hit.excerpts[0];
    expect(ex.spans.map(([s, e]) => ex.text.slice(s, e))).toEqual(['crème']);
  });
});

describe('excerpts: turns without a word', () => {
  it('skips plain ASCII turns with none of the words, and still finds a word in accented or mixed-case text', () => {
    const es = [entry('a', { prompts: ['nothing to see', 'Le CAFÉ du coin', 'DEPLOY\tthe   cafe now'], replies: ['no match either'] })];
    const [hit] = search(es, 'cafe');
    expect(hit.excerpts.map((x) => x.text)).toEqual(['Le CAFÉ du coin', 'DEPLOY the cafe now']);
    expect(hit.excerpts.map((x) => x.spans.map(([s, e]) => x.text.slice(s, e)))).toEqual([['CAFÉ'], ['cafe']]);
  });

  it('matches wt: against the worktree folded (accents, case)', () => {
    const docs = buildDocs([{ path: '/p/a.jsonl', entry: entry('a', { prompts: ['auth'] }) }], { root: '/w/app', scope: 'workspace', worktreeOf: () => 'Fëat-A' });
    expect(searchTranscripts(docs, 'auth wt:feat-a', { now: NOW, limit: 20, onBoard: new Set() }).past.map((h) => h.worktree)).toEqual(['Fëat-A']);
  });
});

describe('excerpts at the edges', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const marked = (ex: { text: string; spans: [number, number][] }) => ex.spans.map(([a, b]) => ex.text.slice(a, b));

  it('never cuts an emoji in half at either end of the window', () => {
    const before = search([entry('a', { prompts: [`${'😀'.repeat(40)}zzmatch`] })], 'match')[0].excerpts[0];
    const after = search([entry('b', { prompts: [`${'x'.repeat(100)}match${'y'.repeat(51)}${'😀'.repeat(20)}`] })], 'match')[0].excerpts[0];
    for (const ex of [before, after]) {
      expect(ex.text).not.toMatch(lone);
      expect(marked(ex)).toEqual(['match']);
    }
  });

  it('marks a match at the very start and the very end of a turn, and an emoji, RTL text or combining marks matched', () => {
    const [start] = search([entry('a', { prompts: ['match then more words'] })], 'match');
    expect(start.excerpts[0].spans[0][0]).toBe(0);
    const [end] = search([entry('a', { prompts: [`${'w '.repeat(30)}ends with match`] })], 'match');
    expect(marked(end.excerpts[0])).toEqual(['match']);
    expect(end.excerpts[0].text.endsWith('match')).toBe(true);
    expect(marked(search([entry('a', { prompts: ['ship it 🚀 now'] })], '🚀')[0].excerpts[0])).toEqual(['🚀']);
    expect(marked(search([entry('a', { prompts: ['בדיקה של שלום עולם'] })], 'שלום')[0].excerpts[0])).toEqual(['שלום']);
    expect(marked(search([entry('a', { prompts: ['the cafe\u0301 menu'] })], 'café')[0].excerpts[0])).toEqual(['cafe\u0301']);
  });

  it('keeps no span overlapping an earlier kept one', () => {
    const [hit] = search([entry('a', { prompts: ['authentication works'] })], 'authentication hen cat');
    const spans = hit.excerpts[0].spans;
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    expect(marked(hit.excerpts[0])).toEqual(['authentication']);
  });

  it('takes queries of only facets, many terms, a 500-character word and regex characters', () => {
    const es = [entry('a', { prompts: ['fix (the) [regex] .* bug in a+b'] })];
    expect(search(es, 'wt:')).toEqual([]);
    expect(search(es, '.* [regex] a+b (the)').map((h) => h.id)).toEqual(['a']);
    expect(search(es, 'x'.repeat(500))).toEqual([]);
    expect(search(es, Array.from({ length: 50 }, () => 'bug').join(' ')).map((h) => h.id)).toEqual(['a']);
  });
});

describe('foldWithMap', () => {
  it('maps folded positions back to original ones', () => {
    const { folded, map } = foldWithMap('Á b');
    expect(folded).toBe('a b');
    expect(map).toEqual([0, 1, 2]);
  });
});

describe('searchCandidates (past)', () => {
  it('takes the matches first, then fills with the newest others', () => {
    const es = [entry('match', { prompts: ['parser'], lastAt: NOW - 50 * DAY }), entry('n1', { lastAt: NOW - DAY }), entry('n2', { lastAt: NOW - 2 * DAY }), entry('n3', { lastAt: NOW - 3 * DAY })];
    expect(searchCandidates(docsOf(es), 'the parser one', { now: NOW, limit: 3, onBoard: new Set() }).past.map((c) => c.hit.id)).toEqual(['match', 'n1', 'n2']);
    expect(searchCandidates(docsOf(es), 'what did I do yesterday', { now: NOW, limit: 2, onBoard: new Set(['n1']) }).past.map((c) => c.hit.id)).toEqual(['n2', 'n3']);
  });
});

describe('historyDigest', () => {
  it('is a short digest marked as history', () => {
    const e = entry('a', { prompts: ['p1', 'p2', 'p3', 'x'.repeat(500)], replies: ['r'], files: ['/a', '/b', '/c', '/d', '/e', '/f'], customTitle: 'Title' });
    const docs = docsOf([e]);
    const [{ hit }] = searchCandidates(docs, 'p1', { now: NOW, limit: 1, onBoard: new Set() }).past;
    const d = historyDigest(hit, docs[0]);
    expect(d.id).toBe('a');
    expect(d.state).toBe('History: ended');
    expect(d.title).toBe('Title');
    expect(d.prompts.length).toBeLessThanOrEqual(3);
    expect(d.prompts[0]).toBe('p1');
    expect(JSON.stringify(d).length).toBeLessThan(900);
  });
});

// Wall-clock timings: run alone (`npm run test:perf`), not in the parallel full run, where they flake.
describe.skipIf(!process.env.DEVDESK_PERF)('performance', () => {
  it('searches 1000 sessions of about 60 KB each in under 50 ms', () => {
    const chunk = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';
    const es = Array.from({ length: 1000 }, (_, i) =>
      entry(`s${i}`, { prompts: [`deploy ${chunk.repeat(500)}`], replies: [chunk.repeat(600)], lastAt: NOW - i * 60_000 }));
    const docs = docsOf(es);
    const t0 = performance.now();
    const hits = searchTranscripts(docs, 'deploy', { now: NOW, limit: 20, onBoard: new Set() }).past;
    const t1 = performance.now();
    const cands = searchCandidates(docs, 'deploy', { now: NOW, limit: 40, onBoard: new Set() }).past;
    const t2 = performance.now();
    console.log(`searchTranscripts ${(t1 - t0).toFixed(1)} ms, searchCandidates ${(t2 - t1).toFixed(1)} ms`);
    expect(hits.length).toBe(20);
    expect(cands.length).toBe(40);
    expect(t1 - t0).toBeLessThan(50);
    expect(t2 - t1).toBeLessThan(50);
  });

  it('answers a pasted 50-word query (common words, repeats) over 1000 sessions in well under a second', () => {
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim';
    const chunk = `${words} `;
    const es = Array.from({ length: 1000 }, (_, i) => entry(`s${i}`, { prompts: [chunk.repeat(500)], replies: [chunk.repeat(600)], lastAt: NOW - i * 60_000 }));
    const docs = docsOf(es);
    const query = Array.from({ length: 50 }, (_, i) => words.split(' ')[i % 20]).join(' ');
    const t0 = performance.now();
    const hits = searchTranscripts(docs, query, { now: NOW, limit: 20, onBoard: new Set() }).past;
    const t1 = performance.now();
    console.log(`50 terms: searchTranscripts ${(t1 - t0).toFixed(1)} ms`);
    expect(hits.length).toBe(20);
    expect(t1 - t0).toBeLessThan(300);
  });
});

describe('searchTranscripts', () => {
  const es = [
    entry('live', { prompts: ['this is the ticket: https://issues.example.com/issues/V2434592101 -', 'what is the latest status?'] }),
    entry('past', { prompts: ['look at https://issues.example.com/issues/V2434592101'] }),
    entry('other', { prompts: ['nothing here'] }),
  ];
  const q = 'https://issues.example.com/issues/V2434592101';

  it('finds the board\'s sessions in their whole transcripts, apart from the past ones', () => {
    const { past, board } = searchTranscripts(docsOf(es), q, { now: NOW, limit: 20, onBoard: new Set(['live']) });
    expect(past.map((h) => h.id)).toEqual(['past']);
    expect(board.map((h) => h.id)).toEqual(['live']);
    expect(board[0].excerpts[0].text).toContain('V2434592101');
  });

  it('leaves `wt:` and `is:` to the board\'s cards, and matches no board session without a word', () => {
    const docs = docsOf(es);
    expect(searchTranscripts(docs, `${q} is:waiting`, { now: NOW, limit: 20, onBoard: new Set(['live']) }).board.map((h) => h.id)).toEqual(['live']);
    expect(searchTranscripts(docs, 'wt:main', { now: NOW, limit: 20, onBoard: new Set(['live']) }).board).toEqual([]);
  });
});

describe('searchCandidates', () => {
  it('gives the ✨ model where the board\'s sessions match (any word), and the past sessions as before', () => {
    const es = [entry('live', { prompts: ['early: fix the V2434592101 ticket', 'later prompt'] }), entry('past', { prompts: ['other'] })];
    const { past, board } = searchCandidates(docsOf(es), 'the ticket V2434592101', { now: NOW, limit: 5, onBoard: new Set(['live']) });
    expect(past.map((c) => c.hit.id)).toEqual(['past']);
    expect([...board.keys()]).toEqual(['live']);
    expect(board.get('live')).toContain('V2434592101');
  });
});
