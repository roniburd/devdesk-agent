import { describe, expect, it } from 'vitest';
import { stepAsideMessage } from '../src/core/edition';

describe('stepAsideMessage', () => {
  it('steps aside only when v2 is enabled', () => {
    expect(stepAsideMessage(false)).toBeUndefined();
    expect(stepAsideMessage(true)).toMatch(/DevDesk for Claude Code \(v2\) is enabled/);
  });
});
