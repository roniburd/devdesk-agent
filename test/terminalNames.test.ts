import { describe, expect, it } from 'vitest';
import { clipTitle, sessionLabel, terminalName } from '../src/core/terminalNames';

describe('sessionLabel', () => {
  it('drops cc- on DevDesk server and marks other sessions', () => {
    expect(sessionLabel('cc-main-39', 'devdesk', 'devdesk', 'default')).toBe('main-39');
    expect(sessionLabel('work', 'devdesk', 'devdesk', 'default')).toBe('work (tmux)');
    expect(sessionLabel('cc-x', 'default', 'devdesk', 'default')).toBe('cc-x (your tmux)');
    expect(sessionLabel('cc-x', 'other', 'devdesk', 'default')).toBe('cc-x (tmux other)');
  });
});

describe('clipTitle', () => {
  it('keeps short titles, cuts long ones with an ellipsis, on one line', () => {
    expect(clipTitle('Raise login timeout', 24)).toBe('Raise login timeout');
    expect(clipTitle('Make the tab titles look like the board card', 24)).toBe('Make the tab titles…');
    expect(clipTitle('Fix the login timeout in the parser', 24)).toBe('Fix the login timeout…');
    expect(clipTitle('Refactorthewholeparsermoduleplease', 24)).toBe('Refactorthewholeparserm…');
    expect(clipTitle('Make the tab titles look like the board card', 24)!.length).toBeLessThanOrEqual(24);
    expect(clipTitle('  two\n lines ', 24)).toBe('two lines');
    expect(clipTitle('   ', 24)).toBeUndefined();
    expect(clipTitle(undefined, 24)).toBeUndefined();
  });
});

describe('terminalName', () => {
  const none = new Set<string>();
  it('is the title, else the session label', () => {
    expect(terminalName('Raise login timeout', 'main-39', 24, none)).toBe('Raise login timeout');
    expect(terminalName(undefined, 'main-39', 24, none)).toBe('main-39');
    expect(terminalName('', 'main-39', 24, none)).toBe('main-39');
  });

  it('is the label when titles are off', () => {
    expect(terminalName('Raise login timeout', 'main-39', 0, none)).toBe('main-39');
  });

  it('adds the label to a title another Claude terminal has', () => {
    expect(terminalName('Fix login', 'main-40', 24, new Set(['Fix login']))).toBe('Fix login · main-40');
    expect(terminalName('Fix login', 'main-40', 24, new Set(['Fix login · main-39']))).toBe('Fix login');
  });
});
