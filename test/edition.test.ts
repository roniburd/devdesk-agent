import { describe, expect, it } from 'vitest';
import { editionNotice, sharedStorageDir, V1_ID, V2_ID, versionAtLeast } from '../src/core/edition';

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
    expect(editionNotice(undefined, true)).toBeUndefined();
  });

  it('steps aside for a v1 that runs alongside v2', () => {
    expect(editionNotice('1.3.0', true)).toMatchObject({ kind: 'stepAside', action: 'Show Extensions', message: expect.stringMatching(/v2 is not running/) });
    expect(editionNotice('1.10.2', false)?.kind).toBe('stepAside');
  });

  it('asks to disable an older v1, which steps aside itself but may keep the views', () => {
    expect(editionNotice('1.2.1', true)).toMatchObject({ kind: 'bothEnabled', action: 'Show Extensions' });
    expect(editionNotice('1.2.1', false)).toMatchObject({ kind: 'bothEnabled' });
  });

  it('asks to reload the window when v1 was disabled without a reload, leaving no views', () => {
    expect(editionNotice(undefined, false)).toMatchObject({ kind: 'reload', action: 'Reload Window' });
  });
});

describe('versionAtLeast', () => {
  it('compares major, minor and patch as numbers', () => {
    expect(versionAtLeast('1.3.0', '1.3.0')).toBe(true);
    expect(versionAtLeast('1.10.0', '1.3.0')).toBe(true);
    expect(versionAtLeast('1.2.9', '1.3.0')).toBe(false);
    expect(versionAtLeast('2.0.0-prototype.1', '1.3.0')).toBe(true);
  });
});
