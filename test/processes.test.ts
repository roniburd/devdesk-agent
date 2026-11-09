import { describe, expect, it } from 'vitest';
import { findDescendant, listProcesses, parseProcessTable } from '../src/core/processes';
import { isClaudeCommand } from '../src/core/sessions';

// A pane shell running `claude; exec zsh -l`, and one whose Claude sits behind a wrapper shell on a nested pty.
const PS = `    1     0 /sbin/launchd
  100     1 tmux
  101   100 zsh
  102   101 /Users/u/.toolbox/bin/claude
  200   100 zsh
  201   200 /bin/zsh
  202   201 2.1.3
  300   100 -zsh
  301   300 vim
garbage
`;

describe('parseProcessTable / findDescendant', () => {
  const table = parseProcessTable(PS);
  it('finds Claude below wrapper shells, by command name or native version name', () => {
    expect(table.comm.get(102)).toBe('claude');
    expect(findDescendant(table, 200, isClaudeCommand, 1)).toBeUndefined();
    expect(findDescendant(table, 999, isClaudeCommand)).toBeUndefined();
  });
  it('names the Claude process below wrapper shells', () => {
    expect(findDescendant(table, 101, isClaudeCommand)).toBe(102);
    expect(findDescendant(table, 200, isClaudeCommand)).toBe(202);
    expect(findDescendant(table, 300, isClaudeCommand)).toBeUndefined();
  });
  it('reads the real process table', async () => {
    const real = await listProcesses();
    expect(real?.comm.has(process.pid)).toBe(true);
  });
});
