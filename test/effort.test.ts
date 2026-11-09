import { describe, expect, it } from 'vitest';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import { launchPrompt, specPrefix } from '../src/core/composer';
import { parseEffortCommand, promptDecoration } from '../src/core/effort';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const SONNET_46 = ['low', 'medium', 'high', 'max'];

describe('parseEffortCommand', () => {
  it('opens the effort row without an argument', () => {
    expect(parseEffortCommand('', ALL)).toEqual({ kind: 'open' });
    expect(parseEffortCommand('   ', ALL)).toEqual({ kind: 'open' });
  });

  it('sets a level the model offers, any case; auto and default are Default', () => {
    expect(parseEffortCommand('high', ALL)).toEqual({ kind: 'set', effort: 'high' });
    expect(parseEffortCommand('XHigh', ALL)).toEqual({ kind: 'set', effort: 'xhigh' });
    expect(parseEffortCommand('auto', ALL)).toEqual({ kind: 'set', effort: 'Default' });
    expect(parseEffortCommand('Default', [])).toEqual({ kind: 'set', effort: 'Default' });
  });

  it('refuses a real level the model does not offer, saying which it does', () => {
    expect(parseEffortCommand('xhigh', SONNET_46)).toEqual({ kind: 'unsupported', level: 'xhigh', offered: SONNET_46 });
    // A Bedrock router takes no effort at all.
    expect(parseEffortCommand('low', [])).toEqual({ kind: 'unsupported', level: 'low', offered: [] });
  });

  it('reads status and the Ultracode switch', () => {
    expect(parseEffortCommand('status', [])).toEqual({ kind: 'status' });
    expect(parseEffortCommand('ultracode', ALL)).toEqual({ kind: 'ultracode' });
    expect(parseEffortCommand('ultracode on', ALL)).toEqual({ kind: 'ultracode', on: true });
    expect(parseEffortCommand('Ultracode  OFF', [])).toEqual({ kind: 'ultracode', on: false });
  });

  it('explains anything else', () => {
    for (const arg of ['turbo', 'high now', 'ultracode maybe', 'ultracode on off', 'status please']) {
      expect(parseEffortCommand(arg, ALL), arg).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('/effort') });
    }
  });
});

describe('promptDecoration', () => {
  const kindOf = (text: string) => classifySubmission(text, BUILTINS, [{ name: 'superpowers:brainstorming' }, { name: 'deep-research' }]).kind;
  const launch = (text: string, ultracode: boolean, prefix?: string) => launchPrompt(text, promptDecoration(kindOf(text), { ultracode, prefix }));

  it('adds Ultracode and the Spec prefix to plain text and category F only', () => {
    expect(launch('fix it', true)).toBe('fix it\n\nultracode');
    expect(launch('/deep-research the cache', true, 'Spec first.')).toBe('/deep-research Spec first.\n\nthe cache\n\nultracode');
    expect(launch('fix it', false, '/superpowers:brainstorming')).toBe('/superpowers:brainstorming fix it');
  });

  it('never decorates a command the board handles (the /model\\n\\nultracode and brainstorming /model bugs)', () => {
    const spec = specPrefix('', ['superpowers:brainstorming']);
    for (const text of ['/model', '/model sonnet', '/effort ultracode on', '/plan fix it', '/compact', '/permissions', '/login', '/nope']) {
      expect(launch(text, true, spec), text).toBe(text);
    }
    expect(promptDecoration('A', { ultracode: true, prefix: spec })).toEqual({ ultracode: false });
    expect(promptDecoration('text', { ultracode: false })).toEqual({ ultracode: false });
  });
});
