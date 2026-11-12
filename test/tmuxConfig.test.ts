import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizedTmuxConfig, TMUX_HOOKS, unsetHookCommands, userTmuxConfigFiles } from '../src/core/tmuxConfig';

describe('userTmuxConfigFiles', () => {
  it('lists the files tmux loads, in its order', () => {
    expect(userTmuxConfigFiles('/h')).toEqual(['/etc/tmux.conf', '/h/.tmux.conf', '/h/.config/tmux/tmux.conf']);
    expect(userTmuxConfigFiles('/h', '/x')).toEqual(['/etc/tmux.conf', '/h/.tmux.conf', '/x/tmux/tmux.conf', '/h/.config/tmux/tmux.conf']);
  });
  it('lists a file once when XDG_CONFIG_HOME is ~/.config', () => {
    expect(userTmuxConfigFiles('/h', '/h/.config')).toEqual(['/etc/tmux.conf', '/h/.tmux.conf', '/h/.config/tmux/tmux.conf']);
  });
});

describe('sanitizedTmuxConfig', () => {
  const conf = sanitizedTmuxConfig(['/h/.tmux.conf', "/h/it's.conf"], 'devdesk.sessions.tmuxConfigFile');
  it('sources the user files quietly, then unsets every hook', () => {
    const lines = conf.split('\n');
    const source = lines.indexOf("source-file -q '/h/.tmux.conf'");
    expect(source).toBeGreaterThan(-1);
    expect(lines.indexOf('set-option -gqu client-attached')).toBeGreaterThan(source);
    expect(lines.filter((l) => l.startsWith('set-option -gqu '))).toHaveLength(TMUX_HOOKS.length);
    expect(conf).toContain('devdesk.sessions.tmuxConfigFile');
  });
  it('skips a path tmux quotes cannot hold', () => {
    expect(conf).not.toContain("it's");
  });
  it('unsets the same hooks on a running server', () => {
    expect(unsetHookCommands()).toContainEqual(['set-option', '-gqu', 'pane-focus-in']);
  });
});

describe.skipIf(spawnSync('tmux', ['-V']).status !== 0)('sanitizedTmuxConfig in tmux', () => {
  it('keeps the user config but none of its hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-tmuxconf-'));
    const user = join(dir, 'user.conf');
    writeFileSync(user, [
      'set -g @mine yes',
      'set-hook -g client-attached "run-shell false"',
      'set-hook -g session-window-changed "run-shell false"',
      'set-hook -g pane-focus-in "run-shell false"',
    ].join('\n'));
    const file = join(dir, 'devdesk.conf');
    writeFileSync(file, sanitizedTmuxConfig([user, join(dir, 'missing.conf')], 'x'));
    const server = `devdesk-test-${process.pid}`;
    const tmux = (...args: string[]) => execFileSync('tmux', ['-f', file, '-L', server, ...args], { encoding: 'utf8' });
    try {
      tmux('new-session', '-d', '-s', 't');
      expect(tmux('show-options', '-gqv', '@mine').trim()).toBe('yes');
      const hooks = tmux('show-hooks', '-g') + tmux('show-hooks', '-gw');
      expect(hooks).not.toContain('run-shell');
      expect(tmux('show-messages')).not.toMatch(/error|invalid|unknown/i);
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  });
});
