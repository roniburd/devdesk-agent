import { describe, expect, it } from 'vitest';
import { adoptForeign, FOREIGN_MARK, ownMarks, tagMark } from '../src/core/readMarks';
import type { SessionCard } from '../src/core/sessions';
import { cardSignature } from '../src/core/sessionsView';

const card = (id: string, detail = 'Done.'): SessionCard => ({ id, state: 'done', detail }) as SessionCard;

describe('read marks', () => {
  it("reads this version's marks as signatures and the other version's as read elsewhere", () => {
    const saved = new Map([
      ['mine', tagMark('sig-a', 'v2')],
      ['theirs', tagMark('sig-b', 'v1')],
      ['old-mine', 'sig-c'],
      ['old-theirs', 'sig-d'],
    ]);
    expect(ownMarks(saved, new Map([['old-mine', 'sig-c'], ['old-theirs', 'other']]), 'v2')).toEqual(
      new Map([
        ['mine', 'sig-a'],
        ['theirs', FOREIGN_MARK],
        ['old-mine', 'sig-c'],
        ['old-theirs', FOREIGN_MARK],
      ]),
    );
  });

  it('reads a listed session read elsewhere as read as it shows now', () => {
    const seen = new Map([
      ['a', FOREIGN_MARK],
      ['b', 'sig'],
      ['gone', FOREIGN_MARK],
    ]);
    const adopted = adoptForeign(seen, [card('a'), card('b')]);
    expect(adopted.get('a')).toBe(cardSignature(card('a')));
    expect(adopted.get('b')).toBe('sig');
    expect(adopted.get('gone')).toBe(FOREIGN_MARK);
    const none = new Map([['b', 'sig']]);
    expect(adoptForeign(none, [card('b')])).toBe(none);
  });
});
