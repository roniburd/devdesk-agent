import { describe, expect, it } from 'vitest';
import { DEFAULT_MODES, joinArgs, parseModes, pickMode } from '../src/core/modes';
import { claudeShellCommand, forkArgs } from '../src/core/tmux';

describe('launch modes', () => {
  it('ships the permission modes and the clauded alias', () => {
    expect(DEFAULT_MODES.map((m) => [m.name, m.args])).toEqual([
      ['Default', ''],
      ['Manual', '--permission-mode manual'],
      ['Accept edits', '--permission-mode acceptEdits'],
      ['Auto', '--permission-mode auto'],
      ['Plan', '--permission-mode plan'],
      ["Don't ask", '--permission-mode dontAsk'],
      ['Bypass (clauded)', '--dangerously-skip-permissions'],
    ]);
  });

  it('parses user modes, dropping broken and duplicate entries', () => {
    expect(parseModes(undefined)).toEqual(DEFAULT_MODES);
    expect(
      parseModes([
        { name: ' Opus plan ', args: ' --model opus --permission-mode plan ' },
        { name: 'No args' },
        { name: '', args: '--x' },
        { name: 'Bad', args: 3 },
        { name: 'Opus plan', args: '--dup' },
        'nope',
        null,
      ]),
    ).toEqual([
      { name: 'Opus plan', args: '--model opus --permission-mode plan' },
      { name: 'No args', args: '' },
    ]);
    expect(parseModes([])).toEqual([]);
  });

  it('picks the default mode by name, falling back to the first mode or plain Claude', () => {
    const modes = parseModes(undefined);
    expect(pickMode(modes, 'plan').args).toBe('--permission-mode plan');
    expect(pickMode(modes, 'Bypass (clauded)').args).toBe('--dangerously-skip-permissions');
    expect(pickMode(modes, 'gone').name).toBe('Default');
    expect(pickMode([], 'Plan')).toEqual({ name: 'Default', args: '' });
  });

  it('puts the mode after claudeArgs, and a fork after the mode', () => {
    const extra = joinArgs('--permission-mode plan', forkArgs('abc-1'));
    expect(extra).toBe('--permission-mode plan --resume abc-1 --fork-session');
    expect(claudeShellCommand({ args: '--model opus' }, joinArgs('', ''))).toBe('$HOME/.toolbox/bin/claude --model opus; exec $SHELL -l');
    expect(claudeShellCommand({ args: '--model opus' }, extra)).toBe(`$HOME/.toolbox/bin/claude --model opus ${extra}; exec $SHELL -l`);
  });
});
