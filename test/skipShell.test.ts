import { describe, expect, it } from 'vitest';
import { skipShellUpdate } from '../src/core/skipShell';

const CMD = 'devdesk.sessions.leftArrow';

describe('skipShellUpdate', () => {
  it('adds the command when this window wants it and it is missing, also after another window removed it', () => {
    expect(skipShellUpdate([], CMD, true, false)).toEqual([CMD]);
    expect(skipShellUpdate(['other'], CMD, true, false)).toEqual(['other', CMD]);
    expect(skipShellUpdate(['other', CMD], CMD, true, false)).toBeUndefined();
  });

  it('removes it only when the user turns the setting off, never because a window has it off', () => {
    expect(skipShellUpdate(['other', CMD], CMD, false, true)).toEqual(['other']);
    expect(skipShellUpdate(['other', CMD], CMD, false, false)).toBeUndefined();
    expect(skipShellUpdate(['other'], CMD, false, true)).toBeUndefined();
  });

  it('settles with windows that disagree: one removing, the other adding back once, then neither writes', () => {
    let value: string[] = [CMD];
    value = skipShellUpdate(value, CMD, false, true) ?? value; // turned off in window A
    value = skipShellUpdate(value, CMD, true, false) ?? value; // window B sees the change and wants it
    expect(value).toEqual([CMD]);
    expect(skipShellUpdate(value, CMD, false, false)).toBeUndefined(); // A sees B's change: leaves it
    expect(skipShellUpdate(value, CMD, true, false)).toBeUndefined();
  });
});
