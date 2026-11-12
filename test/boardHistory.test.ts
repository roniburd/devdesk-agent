import { describe, expect, it } from 'vitest';
import { HISTORY_SETTINGS, historyAnswer, historyCard, historyWorktree, sameIdSet, splitSearchMatches, withStatus } from '../src/core/boardHistory';
import type { HistoryEntry } from '../src/core/historyIndex';
import type { HistoryDoc, HistoryHit } from '../src/core/historySearch';
import type { Feature } from '../src/core/worktrees';

const entry = (o: Partial<HistoryEntry> = {}): HistoryEntry => ({ sessionId: 's1', turns: [], head: 0, headChars: 0, chars: 0, files: [], tools: [], ...o });
const doc = (o: Partial<HistoryEntry> = {}): HistoryDoc => ({
  id: 's1',
  path: '/p/s1.jsonl',
  entry: entry(o),
  title: 'Old',
  worktree: 'main',
  worktreeFolded: 'main',
  at: 0,
  fields: { title: '', prompts: '', files: '', replies: '' },
});
const hit = (id: string): HistoryHit => ({ id, title: id, worktree: 'main', ago: '3d', at: 0, excerpts: [], files: [] });
const features: Feature[] = [
  { name: 'main', dir: '/ws/src', isMain: true, packages: [] },
  { name: 'feat-a', dir: '/ws/worktrees/feat-a', isMain: false, packages: [] },
];

describe('historyWorktree', () => {
  it('names the worktree the launch folder is in, or the worktree folder a removed one was', () => {
    expect(historyWorktree(features, '/ws/worktrees/feat-a/src/Pkg')).toBe('feat-a');
    expect(historyWorktree(features, '/ws/src/Pkg')).toBe('main');
    // Removed worktrees: no feature matches, or only the root does.
    expect(historyWorktree(features, '/ws/worktrees/gone-feat/src')).toBe('gone-feat');
    const git: Feature[] = [{ name: 'main', dir: '/repo', isMain: true, packages: [] }];
    expect(historyWorktree(git, '/repo/.claude/worktrees/old-one/sub')).toBe('old-one');
    expect(historyWorktree(git, '/repo/worktrees/older')).toBe('older');
    expect(historyWorktree(git, '/repo/src/worktrees.ts')).toBe('main');
    expect(historyWorktree(git, '/repo')).toBe('main');
    expect(historyWorktree(features, '/elsewhere')).toBe('no worktree');
    expect(historyWorktree(features, undefined)).toBe('no worktree');
  });
});

describe('historyCard', () => {
  it('is a parked card for the past session, in the worktree its folder is in', () => {
    expect(historyCard(doc(), '/ws/worktrees/feat-a/src/Pkg', features)).toEqual({
      id: 's1',
      sessionId: 's1',
      // Its Claude account follows from its transcript's config directory.
      transcriptPath: '/p/s1.jsonl',
      cwd: '/ws/worktrees/feat-a/src/Pkg',
      state: 'parked',
      detail: '',
      attached: false,
      featureName: 'feat-a',
      featureDir: '/ws/worktrees/feat-a',
    });
  });

  it('has no worktree when the folder is in none', () => {
    const card = historyCard(doc(), '/elsewhere', features);
    expect(card.cwd).toBe('/elsewhere');
    expect(card.featureName).toBeUndefined();
    expect(card.featureDir).toBeUndefined();
  });
});

describe('splitSearchMatches', () => {
  it('keeps board ids in matches and gives history ids their hit, with the reason', () => {
    const h = hit('h1');
    expect(splitSearchMatches([{ id: 'a', reason: 'board' }, { id: 'h1', reason: 'old one' }], [h, hit('h2')])).toEqual({
      matches: [{ id: 'a', reason: 'board' }],
      historyMatches: [{ ...h, reason: 'old one' }],
    });
  });

  it('has no historyMatches when the model picked no past session', () => {
    expect(splitSearchMatches([{ id: 'a', reason: '' }], [hit('h1')])).toEqual({ matches: [{ id: 'a', reason: '' }] });
  });

  it('keeps a candidate that joined the board while the model answered (resumed) on the board, not in history', () => {
    expect(splitSearchMatches([{ id: 'h1', reason: 'old one' }], [hit('h1')], new Set(['h1']))).toEqual({ matches: [{ id: 'h1', reason: 'old one' }] });
  });
});

describe('historyAnswer', () => {
  const status = { indexed: 3, total: 5, building: true };
  const base = { on: true, status, now: 0, exclude: new Set<string>(), warn: () => undefined };

  it('says off without building the docs when history is off', () => {
    const docs = () => {
      throw new Error('not built');
    };
    expect(historyAnswer({ query: 'x', seq: 4 }, { ...base, on: false, docs })).toEqual({ type: 'historyResults', seq: 4, query: 'x', results: [], off: true });
  });

  it('answers no results without building the docs for a query with no terms (only `wt:`, spaces)', () => {
    let built = 0;
    const docs = () => (built++, []);
    for (const query of ['', '   ', 'wt:', 'wt: is:']) expect(historyAnswer({ query, seq: 1 }, { ...base, docs }).results).toEqual([]);
    expect(built).toBe(0);
  });

  it('answers no results (and logs) when building the docs or searching throws, so the lane does not wait forever', () => {
    const warnings: string[] = [];
    const docs = () => {
      throw new Error('boom');
    };
    expect(historyAnswer({ query: 'retry', seq: 2 }, { ...base, docs, warn: (m) => warnings.push(m) })).toEqual({
      type: 'historyResults',
      seq: 2,
      query: 'retry',
      results: [],
      indexing: { indexed: 3, total: 5 },
    });
    expect(warnings).toEqual(['board history: search failed: boom']);
  });
});

describe('historyAnswer: board sessions', () => {
  it('lists the board\'s sessions found in their transcripts by card id, apart from the past ones', () => {
    const docs = () => [
      { ...doc({ turns: [{ role: 'user', text: 'the ticket V24' }] }), id: 's1', fields: { title: '', prompts: 'the ticket v24', files: '', replies: '' } },
      { ...doc(), id: 's2', fields: { title: '', prompts: 'ticket v24 again', files: '', replies: '' } },
    ];
    const a = historyAnswer({ query: 'v24', seq: 1 }, { on: true, status: { indexed: 2, total: 2, building: false }, docs, now: 0, exclude: new Set(['s1']), cardId: (id) => `card-${id}`, warn: () => undefined });
    expect(a.results.map((h) => h.id)).toEqual(['s2']);
    expect(a.onBoard).toEqual([{ id: 'card-s1', excerpt: { text: 'the ticket V24', spans: [[11, 14]] } }]);
  });
});

describe('withStatus', () => {
  it('keeps the results and gives the progress now, dropping it once the index is built', () => {
    const prev = { type: 'historyResults' as const, seq: 2, query: 'auth', results: [hit('h1')], indexing: { indexed: 10, total: 50 } };
    expect(withStatus(prev, { indexed: 20, total: 50, building: true })).toEqual({ ...prev, indexing: { indexed: 20, total: 50 } });
    expect(withStatus(prev, { indexed: 50, total: 50, building: false })).toEqual({ type: 'historyResults', seq: 2, query: 'auth', results: [hit('h1')] });
  });
});

describe('sameIdSet', () => {
  it('is true for the same ids in any order, false once one joins or leaves', () => {
    expect(sameIdSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameIdSet(new Set(['a']), new Set(['a', 'h1']))).toBe(false);
    expect(sameIdSet(new Set(['a', 'h1']), new Set(['a']))).toBe(false);
    expect(sameIdSet(new Set(['a']), new Set(['b']))).toBe(false);
    expect(sameIdSet(undefined, new Set())).toBe(false);
  });
});

describe('HISTORY_SETTINGS', () => {
  it('names the settings that change what the history index holds, not the ✨ model ones', () => {
    expect(HISTORY_SETTINGS).toEqual(['devdesk.boardSearch.history', 'devdesk.boardSearch.historyScope', 'devdesk.boardSearch.historyDays', 'devdesk.boardSearch.historyDir']);
  });
});
