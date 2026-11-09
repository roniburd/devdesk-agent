import { describe, expect, it } from 'vitest';
import { parseUsageMessage } from '../src/usage/messages';

describe('parseUsageMessage', () => {
  it('keeps the messages the Claude Usage page sends, field by field', () => {
    for (const type of ['ready', 'refresh', 'settings']) expect(parseUsageMessage({ type, extra: 1 })).toEqual({ type });
    expect(parseUsageMessage({ type: 'setScope', scope: { kind: 'all' } })).toEqual({ type: 'setScope', scope: { kind: 'all' } });
    expect(parseUsageMessage({ type: 'setScope', scope: { kind: 'project', project: '/w/a', worktree: 'feat' } })).toEqual({
      type: 'setScope',
      scope: { kind: 'project', project: '/w/a', worktree: 'feat' },
    });
  });

  it('drops anything else', () => {
    for (const m of [undefined, null, 'ready', {}, { type: 'page' }, { type: 'setScope' }, { type: 'setScope', scope: { kind: 'project', project: '(DevDesk)' } }]) {
      expect(parseUsageMessage(m)).toBeUndefined();
    }
  });
});
