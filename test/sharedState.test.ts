import { describe, expect, it } from 'vitest';
import {
  emptySharedState,
  importValues,
  isSharedGlobalKey,
  isSharedProjectKey,
  parseSharedState,
  serializeSharedState,
  withValue,
} from '../src/core/sharedState';
import { KEPT_KEYS } from '../src/board/projectState';
import { LEGACY_REATTACH_KEY, REATTACH_KEY } from '../src/state/reattachTerminals';
import { hostKey } from '../src/state/mementoState';

// `sessionsReadState.ts`'s SEEN_KEY (that module needs VS Code).
const SEEN_KEY = 'devdesk.sessions.seen';

describe('shared keys', () => {
  it("shares the host's read state and colors, and nothing else of globalState", () => {
    expect(isSharedGlobalKey(hostKey(SEEN_KEY, 'h'))).toBe(true);
    expect(isSharedGlobalKey(SEEN_KEY)).toBe(true);
    expect(isSharedGlobalKey('devdesk.sessions.colors@h')).toBe(true);
    expect(isSharedGlobalKey('devdesk.sessions.seenSomething')).toBe(false);
    expect(isSharedGlobalKey('devdesk.board.customModels')).toBe(false);
  });

  it("shares the project's terminals to reattach and what the board's prompt box keeps", () => {
    for (const key of [REATTACH_KEY, LEGACY_REATTACH_KEY, ...Object.values(KEPT_KEYS), 'devdesk.usage.scope']) expect(isSharedProjectKey(key)).toBe(true);
    expect(isSharedProjectKey('devdesk.reviewNotes')).toBe(false);
  });
});

describe('importValues', () => {
  it("copies an extension's values in once: missing keys, and the entries a list lacks", () => {
    const file = { imported: ['v2'], values: { seen: [['a', 'file'], ['b', 'file']], draft: 'from v2' } };
    const after = importValues(file, 'v1', [
      ['seen', [['b', 'v1'], ['c', 'v1']]],
      ['draft', 'from v1'],
      ['colors', [['a', 'red']]],
      ['gone', undefined],
    ]);
    expect(after).toEqual({
      imported: ['v2', 'v1'],
      values: { seen: [['a', 'file'], ['b', 'file'], ['c', 'v1']], draft: 'from v2', colors: [['a', 'red']] },
    });
    expect(importValues(after, 'v1', [['other', 1]])).toBe(after);
  });
});

describe('the file', () => {
  it('round-trips, and reads what it can of a partial file', () => {
    const state = withValue(emptySharedState(), 'k', [['a', 1]]);
    expect(parseSharedState(serializeSharedState(state))).toEqual(state);
    expect(parseSharedState('{"values":{"k":1}}')).toEqual({ imported: [], values: { k: 1 } });
    expect(withValue(state, 'k', undefined).values).toEqual({});
  });

  it('refuses a file that is not a shared state object', () => {
    expect(() => parseSharedState('[]')).toThrow();
    expect(() => parseSharedState('{')).toThrow();
  });
});
