import { describe, expect, it } from 'vitest';
import { bothEnabledWarning, sharedStorageDir, V1_ID, V2_ID } from '../src/core/edition';

describe('sharedStorageDir', () => {
  it("uses v1's sibling folder for this extension's storage", () => {
    expect(sharedStorageDir(`/u/globalStorage/${V2_ID}`)).toBe(`/u/globalStorage/${V1_ID}`);
    expect(sharedStorageDir(`/u/workspaceStorage/abc/${V2_ID}`)).toBe(`/u/workspaceStorage/abc/${V1_ID}`);
  });

  it('matches the folder name whatever its case', () => {
    expect(sharedStorageDir('/u/globalStorage/Roniburd.DevDesk-Claude-Beta')).toBe(`/u/globalStorage/${V1_ID}`);
  });

  it('leaves any other folder alone', () => {
    expect(sharedStorageDir(`/u/globalStorage/${V1_ID}`)).toBe(`/u/globalStorage/${V1_ID}`);
    expect(sharedStorageDir('/u/globalStorage/someone.else')).toBe('/u/globalStorage/someone.else');
  });
});

describe('bothEnabledWarning', () => {
  it('warns only when v1 is enabled too', () => {
    expect(bothEnabledWarning(false)).toBeUndefined();
    expect(bothEnabledWarning(true)).toMatch(/disable "DevDesk Claude"/);
  });
});
