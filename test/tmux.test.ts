import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptArg, shellQuote } from '../src/core/shell';
import { fitsTmuxCommandLine, scriptedCommand, attachArgs, CLAUDE_CHILD_ENV_KEYS, launchTags, claudeShellCommand, defaultTmuxInstallCommand, forkArgs, tmuxInstalled, tmuxOptions, isSessionId, DEFAULT_SERVER, isPaneId, isServerName, serverArgs, LIST_FORMAT, listPanes, listSessions, isNumberedSession, nextSessionName, parsePanes, sessionLabel, sessionName, sessionsOf } from '../src/core/tmux';

const wt = (name: string) => ({ name, dir: `/w/worktrees/${name}`, isMain: false });

describe('sessionName', () => {
  it('prefixes and keeps safe characters', () => {
    expect(sessionName(wt('af2-dp-alarms'))).toBe('cc-af2-dp-alarms');
    expect(sessionName({ name: 'main', dir: '/w', isMain: true })).toBe('cc-main');
  });
  it('replaces characters tmux rejects', () => {
    expect(sessionName(wt('v1.2:fix'))).toMatch(/^cc-v1_2_fix-[0-9a-f]{6}$/);
  });
  it('never gives two features the same session', () => {
    const names = [
      sessionName({ name: 'main', dir: '/w', isMain: true }),
      sessionName(wt('main')),
      sessionName(wt('a.b')),
      sessionName(wt('a_b')),
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('sessionsOf', () => {
  it('keeps the first pane of each session', () => {
    expect(sessionsOf(parsePanes('cc-a|^|1|^|%1|^|claude\ncc-a|^|1|^|%2|^|bash\ncc-b|^|0|^|%3|^|zsh\n'))).toEqual([
      { name: 'cc-a', attached: true, command: 'claude' },
      { name: 'cc-b', attached: false, command: 'zsh' },
    ]);
  });
});

describe('listSessions', () => {
  it('returns no sessions when tmux has no server', async () => {
    expect(await listSessions(async () => { throw new Error('no server running on /tmp/tmux-1/default'); })).toEqual([]);
  });
  it('asks tmux for every pane in the expected format', async () => {
    const sessions = await listSessions(async (args) => {
      expect(args).toEqual(['list-panes', '-a', '-F', LIST_FORMAT]);
      return 'cc-x|^|0|^|%4|^|node\n';
    });
    expect(sessions).toEqual([{ name: 'cc-x', attached: false, command: 'node' }]);
  });
});

describe('parsePanes / listPanes', () => {
  it('keeps every pane with its id', async () => {
    const out = 'cc-a|^|1|^|%1|^|claude\ncc-a|^|1|^|%2|^|bash\n';
    const panes = [
      { session: 'cc-a', paneId: '%1', attached: true, command: 'claude' },
      { session: 'cc-a', paneId: '%2', attached: true, command: 'bash' },
    ];
    expect(parsePanes(out)).toEqual(panes);
    expect(await listPanes(async () => out)).toEqual(panes);
    expect(await listPanes(async () => { throw new Error('no server'); })).toEqual([]);
    expect(parsePanes('cc-a|^|0|^|%9|^|zsh|^|4242\n')).toEqual([{ session: 'cc-a', paneId: '%9', attached: false, command: 'zsh', pid: 4242 }]);
    expect(parsePanes('my sess|^|1|^|%2|^|zsh|^|7|^|/w/odd|^|dir\n')[0]).toMatchObject({ session: 'my sess', pid: 7, cwd: '/w/odd|^|dir' });
  });
});

describe('tmux servers', () => {
  it('adds -L for a named server only', () => {
    expect(serverArgs('devdesk', ['ls'])).toEqual(['-L', 'devdesk', 'ls']);
    expect(serverArgs(DEFAULT_SERVER, ['ls'])).toEqual(['ls']);
    expect(() => serverArgs('../x', ['ls'])).toThrow('not a tmux server name');
    expect(serverArgs('devdesk', ['ls'], '/c.conf')).toEqual(['-f', '/c.conf', '-L', 'devdesk', 'ls']);
    expect(serverArgs(DEFAULT_SERVER, ['ls'], '/c.conf')).toEqual(['-f', '/c.conf', 'ls']);
    expect([isServerName('devdesk'), isServerName('a.b_c-1'), isServerName(''), isServerName('a/b'), isServerName('..')]).toEqual([true, true, false, false, false]);
  });
  it('tags listed panes with their server', async () => {
    expect(await listPanes(async () => 'cc-a|^|0|^|%1|^|zsh\n', 'devdesk')).toEqual([{ session: 'cc-a', paneId: '%1', attached: false, command: 'zsh', server: 'devdesk' }]);
  });
});

describe('isPaneId', () => {
  it('accepts tmux pane ids only', () => {
    expect(isPaneId('%12')).toBe(true);
    expect(isPaneId('cc-a')).toBe(false);
    expect(isPaneId('%3;kill-server')).toBe(false);
  });
});

describe('nextSessionName', () => {
  it('uses the base name while it is free, then the first free numbered name', () => {
    expect(nextSessionName('cc-a', [])).toBe('cc-a');
    expect(nextSessionName('cc-a', ['cc-b'])).toBe('cc-a');
    expect(nextSessionName('cc-a', ['cc-a'])).toBe('cc-a-2');
    expect(nextSessionName('cc-a', ['cc-a', 'cc-a-2', 'cc-a-4'])).toBe('cc-a-3');
  });
  it('recognises numbered sessions of a base name', () => {
    expect([isNumberedSession('cc-a-2', 'cc-a'), isNumberedSession('cc-a-x', 'cc-a'), isNumberedSession('cc-a', 'cc-a'), isNumberedSession('cc-ab-2', 'cc-a')]).toEqual([true, false, false, false]);
  });
});

describe('scriptedCommand', () => {
  it('keeps short commands on the command line, not ones of about 16 KB (tmux refuses those)', () => {
    expect(fitsTmuxCommandLine(`claude ${shellQuote('fix it')}`)).toBe(true);
    expect(fitsTmuxCommandLine(`claude ${shellQuote('L'.repeat(20_000))}`)).toBe(false);
    // UTF-8 bytes count: 6000 x 3 bytes.
    expect(fitsTmuxCommandLine(`claude ${shellQuote('修'.repeat(6000))}`)).toBe(false);
  });
  it('runs the whole command from a script that removes its directory', () => {
    const prompt = `it's ${'修'.repeat(6000)}\nline two $HOME`;
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-scripted-'));
    const file = join(dir, 'start.sh');
    const s = scriptedCommand(`printf '%s' ${shellQuote(prompt)}`, dir, file);
    expect(s.command).toBe(`. ${shellQuote(file)}`);
    writeFileSync(file, s.script);
    expect(execFileSync('sh', ['-c', s.command], { encoding: 'utf8' })).toBe(prompt);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('attachArgs', () => {
  // Every start first clears Claude's child-session variables from the server's global environment.
  const UNSET = ['start-server', ';', ...CLAUDE_CHILD_ENV_KEYS.flatMap((k) => ['set-environment', '-g', '-u', k, ';'])];
  it('creates or attaches to a named session in the feature directory', () => {
    expect(attachArgs('cc-a', '/w', 'claude')).toEqual([...UNSET, 'new-session', '-A', '-s', 'cc-a', '-c', '/w', 'claude']);
    expect(attachArgs('cc-a', '/w', 'claude', {}, [], true)).toEqual([...UNSET, 'new-session', '-d', '-s', 'cc-a', '-c', '/w', 'claude']);
  });
  it("adds environment variables to a new session's environment, with DevDesk's tags", () => {
    expect(attachArgs('cc-a', '/w', 'claude', { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1', ...launchTags('cc-a', 'devdesk') })).toEqual([
      ...UNSET,
      'new-session', '-A', '-s', 'cc-a', '-c', '/w', '-e', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1',
      '-e', 'DEVDESK_TMUX_SESSION=cc-a', '-e', 'DEVDESK_TMUX_SERVER=devdesk', 'claude',
    ]);
  });
  it('clears what makes a Claude started inside another Claude its child, and keeps its settings', () => {
    expect(CLAUDE_CHILD_ENV_KEYS).toEqual(expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION']));
    expect(CLAUDE_CHILD_ENV_KEYS).not.toContain('CLAUDE_CODE_USE_BEDROCK');
  });
  it('sets each option on the session after creating or attaching to it', () => {
    expect(attachArgs('cc-a', '/w', 'claude', { DEVDESK_TMUX: '/opt/tmux' }, [['mouse', 'on'], ['history-limit', '5000']])).toEqual([
      ...UNSET,
      'new-session', '-A', '-s', 'cc-a', '-c', '/w', '-e', 'DEVDESK_TMUX=/opt/tmux', 'claude',
      ';', 'set-option', '-t', '=cc-a:', 'mouse', 'on',
      ';', 'set-option', '-t', '=cc-a:', 'history-limit', '5000',
    ]);
  });
});

describe('tmuxOptions', () => {
  it('turns the setting into option/value pairs, dropping invalid entries', () => {
    expect(tmuxOptions({ mouse: true, 'remain-on-exit': false, 'history-limit': 50000, status: 'off', '@mine': 'x' })).toEqual([
      ['mouse', 'on'], ['remain-on-exit', 'off'], ['history-limit', '50000'], ['status', 'off'], ['@mine', 'x'],
    ]);
    expect(tmuxOptions({ '-g': 'x', 'a;b': 'x', ok: null, list: ['x'], nan: Number.NaN })).toEqual([]);
    expect([tmuxOptions(undefined), tmuxOptions('mouse on'), tmuxOptions(['mouse'])]).toEqual([[], [], []]);
  });
});

describe('tmux install', () => {
  it('uses Homebrew on macOS and yum elsewhere', () => {
    expect(defaultTmuxInstallCommand('darwin')).toBe('brew install tmux');
    expect(defaultTmuxInstallCommand('linux')).toBe('sudo yum install -y tmux');
  });
  it('reports a binary that cannot run as not installed', async () => {
    expect(await tmuxInstalled('/nonexistent/tmux')).toBe(false);
  });
});

describe('claudeShellCommand', () => {
  it('runs the toolbox Claude, then a login shell, by default', () => {
    expect(claudeShellCommand({})).toBe('$HOME/.toolbox/bin/claude; exec $SHELL -l');
    expect(claudeShellCommand({ command: ' ', path: '', args: '  ' })).toBe('$HOME/.toolbox/bin/claude; exec $SHELL -l');
  });

  it('adds extra arguments and a custom binary', () => {
    expect(claudeShellCommand({ args: ' --model opus --permission-mode "acceptEdits" ' })).toBe(
      '$HOME/.toolbox/bin/claude --model opus --permission-mode "acceptEdits"; exec $SHELL -l',
    );
    expect(claudeShellCommand({ path: '/opt/claude/bin/claude', args: '--continue' })).toBe('/opt/claude/bin/claude --continue; exec $SHELL -l');
  });

  it('keeps a full command\'s own options before the prompt\'s --', () => {
    expect(claudeShellCommand({ command: 'claude --model opus; exec $SHELL -l' }, `--permission-mode plan ${promptArg('fix it')}`)).toBe(
      "claude --permission-mode plan --model opus -- 'fix it'; exec $SHELL -l",
    );
    expect(claudeShellCommand({ command: 'claude --model opus' }, promptArg("it's -- done; really"))).toBe(`claude --model opus ${promptArg("it's -- done; really")}`);
    expect(claudeShellCommand({ command: `claude --append-system-prompt 'a; b' && echo done` }, `--add-dir '/a -- b' ${promptArg('go')}`)).toBe(
      `claude --add-dir '/a -- b' --append-system-prompt 'a; b' -- 'go' && echo done`,
    );
  });

  it('does not end the first command at the & or | of a redirection', () => {
    expect(claudeShellCommand({ command: 'claude 2>&1 | tee /tmp/log; exec $SHELL -l' }, promptArg('fix it'))).toBe("claude 2>&1 -- 'fix it' | tee /tmp/log; exec $SHELL -l");
    expect(claudeShellCommand({ command: 'claude &>/tmp/log && exec $SHELL -l' }, promptArg('fix it'))).toBe("claude &>/tmp/log -- 'fix it' && exec $SHELL -l");
    expect(claudeShellCommand({ command: 'claude >|/tmp/log || true' }, promptArg('fix it'))).toBe("claude >|/tmp/log -- 'fix it' || true");
  });

  it('uses a full command verbatim, ignoring path and arguments', () => {
    expect(claudeShellCommand({ command: ' claude --resume ', path: '/x/claude', args: '--model opus' })).toBe('claude --resume');
  });
});

describe('fork command', () => {
  it('adds --resume <id> --fork-session after the Claude binary', () => {
    const fork = forkArgs('0b9f2c1e-1234-4abc-9def-001122334455');
    expect(fork).toBe('--resume 0b9f2c1e-1234-4abc-9def-001122334455 --fork-session');
    expect(claudeShellCommand({ args: '--model opus' }, fork)).toBe(`$HOME/.toolbox/bin/claude --model opus ${fork}; exec $SHELL -l`);
    expect(claudeShellCommand({ command: '/x/claude --verbose; exec $SHELL -l' }, fork)).toBe(`/x/claude ${fork} --verbose; exec $SHELL -l`);
  });

  it('rejects session ids that are not safe to pass to a shell', () => {
    for (const bad of ['', 'a b', 'x;rm -rf ~', '$(id)', 'a'.repeat(101)]) expect(() => forkArgs(bad)).toThrow();
    expect(isSessionId('abc_DEF-123')).toBe(true);
  });
});

describe('sessionLabel', () => {
  it('distinguishes shells from running programs', () => {
    expect(sessionLabel(undefined)).toBe('');
    expect(sessionLabel({ name: 'cc-a', attached: false, command: 'bash' })).toBe('○ shell');
    expect(sessionLabel({ name: 'cc-a', attached: false, command: '-zsh' })).toBe('○ shell');
    expect(sessionLabel({ name: 'cc-a', attached: true, command: 'claude' })).toBe('● claude');
  });
});
