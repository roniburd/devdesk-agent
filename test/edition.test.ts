import { describe, expect, it } from 'vitest';
import { V1_ID, V2_ID, VERSIONS_SEARCH } from '../src/core/edition';

describe('edition', () => {
  it('finds both versions in the Extensions view', () => {
    for (const id of [V1_ID, V2_ID]) expect(id.split('.')[1].startsWith(VERSIONS_SEARCH.split(' ')[1])).toBe(true);
  });
});
