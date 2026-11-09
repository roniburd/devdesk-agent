import { describe, expect, it } from 'vitest';
import { parseBoardMessage } from '../src/board/messages';

describe('parseBoardMessage: rendered', () => {
  it('keeps the script time and the rebuilt cards when they are numbers', () => {
    expect(parseBoardMessage({ type: 'rendered', ms: 9, cards: 91, script: 2.5, rebuilt: 1, postedAt: 5 })).toEqual({ type: 'rendered', ms: 9, cards: 91, script: 2.5, rebuilt: 1, postedAt: 5 });
    expect(parseBoardMessage({ type: 'rendered', ms: 9, cards: 91, script: 'x', rebuilt: Infinity })).toEqual({ type: 'rendered', ms: 9, cards: 91 });
  });
});

describe('parseBoardMessage: search', () => {
  it('takes a trimmed, non-empty query of at most 500 characters', () => {
    expect(parseBoardMessage({ type: 'search', query: '  auth  ' })).toEqual({ type: 'search', query: 'auth' });
    expect(parseBoardMessage({ type: 'search', query: 'x'.repeat(900) })).toEqual({ type: 'search', query: 'x'.repeat(500) });
    expect(parseBoardMessage({ type: 'search', query: 'a'.repeat(499) + ' b' })).toEqual({ type: 'search', query: 'a'.repeat(499) });
    expect(parseBoardMessage({ type: 'search', query: '   ' })).toBeUndefined();
    expect(parseBoardMessage({ type: 'search', query: 3 })).toBeUndefined();
    expect(parseBoardMessage({ type: 'cancelSearch' })).toEqual({ type: 'cancelSearch' });
  });
});

describe('parseBoardMessage: history', () => {
  it('reads history queries and the history card actions', () => {
    expect(parseBoardMessage({ type: 'historyQuery', query: '  auth ', seq: 3 })).toEqual({ type: 'historyQuery', query: 'auth', seq: 3 });
    expect(parseBoardMessage({ type: 'historyQuery', query: '', seq: 4 })).toEqual({ type: 'historyQuery', query: '', seq: 4 });
    expect(parseBoardMessage({ type: 'historyQuery', query: 'x' })).toBeUndefined();
    expect(parseBoardMessage({ type: 'resumeHistory', id: 'abc-123' })).toEqual({ type: 'resumeHistory', id: 'abc-123' });
    expect(parseBoardMessage({ type: 'forkHistory', id: 'abc', inMain: true })).toEqual({ type: 'forkHistory', id: 'abc', inMain: true });
    expect(parseBoardMessage({ type: 'forkHistory', id: 'abc', inMain: 'yes' })).toEqual({ type: 'forkHistory', id: 'abc' });
    expect(parseBoardMessage({ type: 'copyHistoryId', id: 'abc' })).toEqual({ type: 'copyHistoryId', id: 'abc' });
    for (const id of ['', '../x', 'a b', 'x'.repeat(101), 5]) expect(parseBoardMessage({ type: 'resumeHistory', id })).toBeUndefined();
  });
});

describe('parseBoardMessage: usage scope', () => {
  it('parses a usage scope change, and drops a malformed one', () => {
    expect(parseBoardMessage({ type: 'usageScope', scope: { kind: 'project', project: '/w/ws', worktree: 'feat-a' } })).toEqual({
      type: 'usageScope',
      scope: { kind: 'project', project: '/w/ws', worktree: 'feat-a' },
    });
    expect(parseBoardMessage({ type: 'usageScope', scope: { kind: 'project' } })).toBeUndefined();
  });
});
