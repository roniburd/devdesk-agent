import { describe, expect, it } from 'vitest';
import { editionNotice, sharedStorageDir, V1_ID, V2_ID } from '../src/core/edition';

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

describe('editionNotice', () => {
  it('says nothing when only v2 is enabled and its views are registered', () => {
    expect(editionNotice(false, true)).toBeUndefined();
  });

  it('asks to disable v1 when both are enabled', () => {
    expect(editionNotice(true, true)).toMatchObject({ kind: 'bothEnabled', action: 'Show Extensions' });
    expect(editionNotice(true, false)).toMatchObject({ kind: 'bothEnabled' });
  });

  it('asks to reload the window when v1 was disabled without a reload, leaving no views', () => {
    expect(editionNotice(false, false)).toMatchObject({ kind: 'reload', action: 'Reload Window' });
  });
});
