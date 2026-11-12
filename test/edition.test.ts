import { describe, expect, it } from 'vitest';
import { SHARED_STORAGE_ID, sharedStorageDir, V1_ID, V2_ID, VERSIONS_SEARCH } from '../src/core/edition';

describe('edition', () => {
  it('v1 is roniburd.devdesk-claude-v1, v2 has the ID v1 had up to 1.13.0', () => {
    expect(V1_ID).toBe('roniburd.devdesk-claude-v1');
    expect(V2_ID).toBe('roniburd.devdesk-claude');
    expect(SHARED_STORAGE_ID).toBe(V2_ID);
  });

  it('finds both versions in the Extensions view', () => {
    for (const id of [V1_ID, V2_ID]) expect(id.split('.')[1].startsWith(VERSIONS_SEARCH.split(' ')[1])).toBe(true);
  });
});

describe('sharedStorageDir', () => {
  it("uses v2's sibling folder for v1's storage, whatever the folder name's case", () => {
    expect(sharedStorageDir(`/u/globalStorage/${V1_ID}`)).toBe(`/u/globalStorage/${V2_ID}`);
    expect(sharedStorageDir('/u/workspaceStorage/abc/Roniburd.DevDesk-Claude-V1')).toBe(`/u/workspaceStorage/abc/${V2_ID}`);
  });

  it('leaves any other folder alone', () => {
    expect(sharedStorageDir(`/u/globalStorage/${V2_ID}`)).toBe(`/u/globalStorage/${V2_ID}`);
    expect(sharedStorageDir('/u/globalStorage/someone.else')).toBe('/u/globalStorage/someone.else');
  });
});
