import { describe, expect, it } from 'vitest';
import { backgroundGitProcesses } from '../src/core/gitProcesses';

describe('git processes', () => {
  it('runs up to half the maximum in the background, a quarter on a busy machine', () => {
    expect(backgroundGitProcesses(8, 8, 32)).toBe(4);
    expect(backgroundGitProcesses(8, 48, 32)).toBe(4);
    expect(backgroundGitProcesses(8, 49, 32)).toBe(2);
    expect(backgroundGitProcesses(8, 306, 32)).toBe(2);
    expect(backgroundGitProcesses(16, 306, 32)).toBe(4);
    expect(backgroundGitProcesses(16, 8, 32)).toBe(8);
  });
  it('runs at least one in the background', () => {
    expect(backgroundGitProcesses(1, 8, 32)).toBe(1);
    expect(backgroundGitProcesses(2, 306, 32)).toBe(1);
    expect(backgroundGitProcesses(3, 8, 32)).toBe(1);
  });
});
