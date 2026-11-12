import { describe, expect, it } from 'vitest';
import { BETA_ID, editionNotice, SHARED_STORAGE_ID, sharedStorageDir, V1_ID, V2_ID, VERSIONS_SEARCH, versionAtLeast } from '../src/core/edition';

describe('extension IDs', () => {
  it('v2 is roniburd.devdesk-claude and keeps the shared folders; v1 and the prototypes have IDs of their own', () => {
    expect(V2_ID).toBe('roniburd.devdesk-claude');
    expect(SHARED_STORAGE_ID).toBe(V2_ID);
    expect(new Set([V1_ID, V2_ID, BETA_ID]).size).toBe(3);
  });

  it('the Extensions view search finds every version', () => {
    for (const id of [V1_ID, V2_ID, BETA_ID]) expect(id.split('.')[1].startsWith(VERSIONS_SEARCH.split(' ')[1])).toBe(true);
  });
});

describe('sharedStorageDir', () => {
  it("is v2's own folder for v2", () => {
    expect(sharedStorageDir(`/u/globalStorage/${V2_ID}`)).toBe(`/u/globalStorage/${V2_ID}`);
    expect(sharedStorageDir(`/u/workspaceStorage/abc/${V2_ID}`)).toBe(`/u/workspaceStorage/abc/${V2_ID}`);
  });

  it("is v2's sibling folder for v1 and the prototypes, whatever the folder name's case", () => {
    expect(sharedStorageDir(`/u/globalStorage/${V1_ID}`, V1_ID)).toBe(`/u/globalStorage/${V2_ID}`);
    expect(sharedStorageDir('/u/workspaceStorage/abc/Roniburd.DevDesk-Claude-Beta', BETA_ID)).toBe(`/u/workspaceStorage/abc/${V2_ID}`);
  });

  it('leaves any other folder alone', () => {
    expect(sharedStorageDir('/u/globalStorage/someone.else')).toBe('/u/globalStorage/someone.else');
    expect(sharedStorageDir(`/u/globalStorage/${V1_ID}`)).toBe(`/u/globalStorage/${V1_ID}`);
  });
});

describe('editionNotice', () => {
  it('says nothing when only v2 is enabled and its views are registered', () => {
    expect(editionNotice({}, true)).toBeUndefined();
  });

  it('asks to disable v1 or the v2 prototype when enabled too, as they may keep the views', () => {
    expect(editionNotice({ v1: true }, true)).toMatchObject({ kind: 'otherEnabled', action: 'Show Extensions', message: expect.stringMatching(/\(v1\)" is also enabled.*Disable or uninstall it/) });
    expect(editionNotice({ beta: true }, false)).toMatchObject({ kind: 'otherEnabled', message: expect.stringMatching(/prototype/) });
    expect(editionNotice({ v1: true, beta: true }, true)?.message).toMatch(/ and .* are also enabled.*uninstall them/);
  });

  it('asks to reload the window when another version was disabled without a reload, leaving no views', () => {
    expect(editionNotice({}, false)).toMatchObject({ kind: 'reload', action: 'Reload Window' });
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
