import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addHooks,
  backupStamp,
  backupsToPrune,
  HOOK_EVENTS,
  HOOK_SCRIPT,
  KEEP_BACKUPS,
  hasHooks,
  hookCommand,
  installHooksInto,
  readHooksInstalled,
  readHooksStatus,
  refreshHookScript,
  removeHooks,
  removeHooksFrom,
} from '../src/core/hooks';
import { shellQuote } from '../src/core/shell';

const STATE = '/home/u/.claude/devdesk/state';
const CMD = hookCommand('/home/u/.claude/devdesk/devdesk_hook.py', STATE);
const OLD_CMD = `python3 -I '/home/u/.claude/devdesk/devdesk_hook.py'`;
const existing = {
  model: 'opus',
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] },
};

describe('settings merge', () => {
  it('quotes paths for the shell', () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(CMD).toBe(
      `[ -f '/home/u/.claude/devdesk/devdesk_hook.py' ] && DEVDESK_STATE_DIR='/home/u/.claude/devdesk/state' ` +
        `python3 -I '/home/u/.claude/devdesk/devdesk_hook.py' >/dev/null 2>&1; exit 0`,
    );
    expect(hookCommand("/a b/it's.py", "/s t/it's")).toBe(
      `[ -f '/a b/it'\\''s.py' ] && DEVDESK_STATE_DIR='/s t/it'\\''s' python3 -I '/a b/it'\\''s.py' >/dev/null 2>&1; exit 0`,
    );
  });

  it('includes PostToolUse so approved permissions return to working', () => {
    expect(HOOK_EVENTS).toContain('PostToolUse');
  });

  it('upgrades an old-format install in place, keeping user hooks', () => {
    const old = addHooks(existing, OLD_CMD);
    expect(hasHooks(old, CMD)).toBe(false);
    const next = addHooks(old, CMD);
    const hooks = next.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const event of HOOK_EVENTS) {
      const ours = hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.includes('devdesk_hook.py'));
      expect(ours.map((h) => h.command)).toEqual([CMD]);
    }
    expect(hooks.SessionStart[0].hooks[0].command).toBe('echo existing');
    expect(hasHooks(next, CMD)).toBe(true);
    expect(next).toEqual(addHooks(existing, CMD));
  });

  it('treats a different state directory as not installed and replaces it', () => {
    const other = hookCommand('/home/u/.claude/devdesk/devdesk_hook.py', '/tmp/other');
    const installed = addHooks(existing, other);
    expect(hasHooks(installed, other)).toBe(true);
    expect(hasHooks(installed, CMD)).toBe(false);
    expect(addHooks(installed, CMD)).toEqual(addHooks(existing, CMD));
  });

  it('removes DevDesk entries of every format', () => {
    const mixed = addHooks(existing, OLD_CMD);
    (mixed.hooks as Record<string, unknown[]>).Stop.push({ hooks: [{ type: 'command', command: CMD }] });
    expect(removeHooks(mixed)).toEqual(existing);
  });

  it('adds one group per event and keeps existing hooks and keys', () => {
    const next = addHooks(existing, CMD);
    expect(next.model).toBe('opus');
    const hooks = next.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(hooks.SessionStart.map((g) => g.hooks[0].command)).toEqual(['echo existing', CMD]);
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: CMD, timeout: 5 }] }]);
    expect(hasHooks(next, CMD)).toBe(true);
    expect(hasHooks(existing, CMD)).toBe(false);
    expect(existing.hooks.SessionStart).toHaveLength(1); // input not mutated
  });

  it('is idempotent', () => {
    expect(addHooks(addHooks(existing, CMD), CMD)).toEqual(addHooks(existing, CMD));
  });

  it('removes only its own entries', () => {
    expect(removeHooks(addHooks(existing, CMD))).toEqual(existing);
    expect(removeHooks(addHooks({ model: 'x' }, CMD))).toEqual({ model: 'x' });
  });

  it('picks the backups to prune: all but the newest, by stamp then same-second number', () => {
    const b = (s: string) => `settings.json.devdesk-backup-${s}`;
    const names = ['settings.json', 'other.devdesk-backup-1', b('20261028220001-10'), b('20261028220001'), b('20261028220001-2'), b('20261027000000')];
    expect(backupsToPrune(names, 'settings.json', 2)).toEqual([b('20261027000000'), b('20261028220001')]);
    expect(backupsToPrune(names, 'settings.json', 10)).toEqual([]);
  });

  it('formats backup stamps in local time', () => {
    expect(backupStamp(new Date(2026, 9, 28, 9, 5, 7))).toBe('20261028090507');
  });
});

describe('install and remove on disk', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'devdesk-home-'));
    await mkdir(join(home, '.claude'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const now = new Date(2026, 9, 28, 22, 0, 0);
  const cdir = () => join(home, '.claude');
  const settingsPath = () => join(home, '.claude', 'settings.json');
  const stateDir = () => join(home, 'state');
  const expected = () => hookCommand(join(home, '.claude', 'devdesk', 'devdesk_hook.py'), stateDir());

  it('reports missing, outdated and installed hooks for a state directory', async () => {
    expect(await readHooksStatus(cdir(), stateDir())).toBe('missing');
    await installHooksInto(cdir(), now, join(home, 'old-state'));
    expect(await readHooksStatus(cdir(), stateDir())).toBe('outdated');
    expect(await readHooksInstalled(cdir(), stateDir())).toBe(false);
    expect((await installHooksInto(cdir(), now, stateDir())).changed).toBe(true);
    expect(await readHooksStatus(cdir(), stateDir())).toBe('installed');
    const hooks = JSON.parse(await readFile(settingsPath(), 'utf8')).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const event of HOOK_EVENTS) expect(hooks[event].flatMap((g) => g.hooks.map((h) => h.command))).toEqual([expected()]);
  });

  it('backs up, installs, is idempotent, and removes', async () => {
    await writeFile(settingsPath(), JSON.stringify(existing));
    expect(await readHooksInstalled(cdir(), stateDir())).toBe(false);
    const first = await installHooksInto(cdir(), now, stateDir());
    expect(first).toEqual({ changed: true, backup: `${settingsPath()}.devdesk-backup-20261028220000` });
    expect(JSON.parse(await readFile(first.backup!, 'utf8'))).toEqual(existing);
    expect(await readFile(join(home, '.claude', 'devdesk', 'devdesk_hook.py'), 'utf8')).toBe(HOOK_SCRIPT);
    expect(await readHooksInstalled(cdir(), stateDir())).toBe(true);
    expect(await installHooksInto(cdir(), now, stateDir())).toEqual({ changed: false });
    const removed = await removeHooksFrom(cdir(), new Date(2026, 9, 28, 22, 0, 1));
    expect(removed.changed).toBe(true);
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual(existing);
  });

  it('keeps the file mode of settings.json', async () => {
    await writeFile(settingsPath(), JSON.stringify(existing));
    await chmod(settingsPath(), 0o600);
    await installHooksInto(cdir(), now, stateDir());
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
    await removeHooksFrom(cdir(), new Date(2026, 9, 28, 22, 0, 1));
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
  });

  it('writes through a symlinked settings.json', async () => {
    const real = join(home, 'real-settings.json');
    await writeFile(real, JSON.stringify(existing));
    await symlink(real, settingsPath());
    await installHooksInto(cdir(), now, stateDir());
    expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
    expect(hasHooks(JSON.parse(await readFile(real, 'utf8')), expected())).toBe(true);
    await removeHooksFrom(cdir(), new Date(2026, 9, 28, 22, 0, 1));
    expect((await lstat(settingsPath())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, 'utf8'))).toEqual(existing);
  });

  it('never overwrites a backup made in the same second', async () => {
    await writeFile(settingsPath(), JSON.stringify(existing));
    const a = await installHooksInto(cdir(), now, stateDir());
    const b = await removeHooksFrom(cdir(), now);
    const c = await installHooksInto(cdir(), now, stateDir());
    const names = [a.backup!, b.backup!, c.backup!];
    expect(new Set(names).size).toBe(3);
    const contents = await Promise.all(names.map((n) => readFile(n, 'utf8')));
    expect(new Set(contents).size).toBe(3);
  });

  it('keeps only the newest backups', async () => {
    await writeFile(settingsPath(), JSON.stringify(existing));
    for (let i = 0; i < 8; i++) {
      const at = new Date(2026, 9, 28, 22, 0, i);
      await installHooksInto(cdir(), at, stateDir());
      await removeHooksFrom(cdir(), at);
    }
    const backups = (await readdir(cdir())).filter((n) => n.includes('.devdesk-backup-')).sort();
    expect(KEEP_BACKUPS).toBe(5);
    expect(backups).toEqual(['20261028220005-1', '20261028220006', '20261028220006-1', '20261028220007', '20261028220007-1'].map((t) => `settings.json.devdesk-backup-${t}`));
  });

  it('two installs at once both finish and leave one valid settings file', async () => {
    await writeFile(settingsPath(), JSON.stringify(existing));
    const other = join(home, 'other-state');
    await Promise.all([installHooksInto(cdir(), now, stateDir()), installHooksInto(cdir(), now, other)]);
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'));
    const installed = [expected(), hookCommand(join(home, '.claude', 'devdesk', 'devdesk_hook.py'), other)].filter((c) => hasHooks(settings, c));
    expect(installed.length).toBe(1);
    expect((await readdir(cdir())).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock') || n.includes('devdesk-tmp'))).toEqual([]);
  });

  it('installs into a CLAUDE_CONFIG_DIR-style directory, not ~/.claude', async () => {
    const config = join(home, 'config');
    await installHooksInto(config, now, stateDir());
    const command = hookCommand(join(config, 'devdesk', 'devdesk_hook.py'), stateDir());
    expect(hasHooks(JSON.parse(await readFile(join(config, 'settings.json'), 'utf8')), command)).toBe(true);
    expect(await readHooksStatus(config, stateDir())).toBe('installed');
    expect(await readdir(cdir())).toEqual([]);
  });

  it('creates settings when there are none', async () => {
    expect(await installHooksInto(cdir(), now, stateDir())).toEqual({ changed: true });
    expect(hasHooks(JSON.parse(await readFile(settingsPath(), 'utf8')), expected())).toBe(true);
  });

  it('changes nothing when settings.json is not valid JSON', async () => {
    await writeFile(settingsPath(), '{ broken');
    await expect(installHooksInto(cdir(), now, stateDir())).rejects.toThrow(/not valid JSON/);
    await expect(removeHooksFrom(cdir(), now)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ broken');
    expect(await readdir(join(home, '.claude'))).toEqual(['settings.json']);
  });
});

describe('hook script', () => {
  let dir: string;
  let script: string;
  let state: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-hook-'));
    script = join(dir, 'devdesk_hook.py');
    state = join(dir, 'state');
    await writeFile(script, HOOK_SCRIPT);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (input: string, stateDir = state) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DEVDESK_STATE_DIR: stateDir };
    delete env.TMUX;
    delete env.TMUX_PANE;
    return spawnSync('python3', ['-I', script], { input, env, encoding: 'utf8' });
  };
  const send = (event: string, extra: Record<string, unknown> = {}) =>
    run(JSON.stringify({ session_id: 'abc', hook_event_name: event, cwd: '/w/x', ...extra }));
  const record = async () => JSON.parse(await readFile(join(state, 'abc.json'), 'utf8'));

  it('records each event as the right state', async () => {
    const transcript = join(dir, 't.jsonl');
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.' }] } }),
        JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
      ].join('\n'),
    );
    send('SessionStart', { transcript_path: transcript });
    expect(await record()).toMatchObject({ state: 'idle', detail: 'Ready', tmuxPane: null, transcriptPath: transcript, prompt: '' });
    expect((await record()).pid).toBeGreaterThan(1);
    expect(send('UserPromptSubmit', { prompt: 'fix the DNS test' })).toMatchObject({ status: 0, stdout: '' });
    expect(await record()).toMatchObject({ sessionId: 'abc', tmuxSession: null, cwd: '/w/x', state: 'working', prompt: 'fix the DNS test' });
    // A background task's result Claude Code submits itself starts a turn but keeps the user's prompt.
    send('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' });
    expect(await record()).toMatchObject({ state: 'working', prompt: 'fix the DNS test' });
    send('UserPromptSubmit', { prompt: '  <system-reminder>note</system-reminder>' });
    expect(await record()).toMatchObject({ prompt: 'fix the DNS test' });
    // A subagent's hand-back is delivered as a prompt too.
    send('UserPromptSubmit', { prompt: '<agent-message from="a31e">\n[Subagent hand-back] report\n</agent-message>' });
    expect(await record()).toMatchObject({ prompt: 'fix the DNS test' });
    send('PreToolUse', { tool_name: 'Bash' });
    expect(await record()).toMatchObject({ state: 'working', detail: 'Running Bash', prompt: 'fix the DNS test' });
    send('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
    expect(await record()).toMatchObject({ state: 'waiting', detail: 'Claude needs your permission to use Bash' });
    send('PostToolUse', { tool_name: 'Bash' });
    expect(await record()).toMatchObject({ state: 'working', detail: 'Running Bash', event: 'PostToolUse' });
    send('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which region?' }] } });
    expect(await record()).toMatchObject({ state: 'waiting', detail: 'Asking: Which region?' });
    // Claude Code follows the question with a permission prompt: the card keeps the question.
    send('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' });
    expect(await record()).toMatchObject({ state: 'waiting', detail: 'Asking: Which region?' });
    send('PreToolUse', { tool_name: 'ExitPlanMode' });
    send('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' });
    expect(await record()).toMatchObject({ state: 'waiting', detail: 'Plan ready for your review' });
    send('Stop');
    expect(await record()).toMatchObject({ state: 'done', detail: 'All tests pass.', event: 'Stop', transcriptPath: transcript });
    send('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    expect(await record()).toMatchObject({ state: 'done', detail: 'All tests pass.' });
    expect(typeof (await record()).updatedAt).toBe('number');
    send('SessionEnd', { reason: 'prompt_input_exit' });
    expect(await readdir(state)).toEqual(['ended']);
    const ended = JSON.parse(await readFile(join(state, 'ended', 'abc.json'), 'utf8'));
    expect(ended).toMatchObject({ sessionId: 'abc', state: 'done', detail: 'All tests pass.', endReason: 'exited', transcriptPath: transcript });
    expect(ended.endedAt).toBeGreaterThanOrEqual(ended.updatedAt);
    // Resumed (`claude --resume abc`): it runs again.
    send('SessionStart', { source: 'resume' });
    expect(await readdir(join(state, 'ended'))).toEqual([]);
  });

  it('keeps no ended record for /clear, and keeps the reason DevDesk parked a session for', async () => {
    send('SessionStart');
    send('SessionEnd', { reason: 'clear' });
    expect(await readdir(state)).toEqual([]);
    send('SessionStart');
    const parked = { ...(await record()), endedAt: Date.now() + 1000, endReason: 'parked' };
    await mkdir(join(state, 'ended'), { recursive: true });
    await writeFile(join(state, 'ended', 'abc.json'), JSON.stringify(parked));
    send('SessionEnd', { reason: 'other' });
    expect(JSON.parse(await readFile(join(state, 'ended', 'abc.json'), 'utf8')).endReason).toBe('parked');
  });

  it('marks a finished turn whose reply ends with a question, and keeps the mark through the idle reminder', async () => {
    const transcript = join(dir, 't.jsonl');
    const reply = async (text: string) =>
      writeFile(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
    await reply('Here are three causes.\n\n**Fix:** show the hints only when empty.\n\nShould I implement these? For #1, the rows or the `fallback`?**\n');
    send('Stop', { transcript_path: transcript });
    expect(await record()).toMatchObject({ state: 'done', asksQuestion: true, detail: 'Here are three causes.\n\n**Fix:** show the hints only when empty.\n\nShould I implement these? For #1, the rows or the `fallback`?**' });
    send('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    expect(await record()).toMatchObject({ state: 'done', asksQuestion: true });
    send('Notification', { message: 'Login successful', notification_type: 'auth_success' });
    expect(await record()).toMatchObject({ state: 'done', asksQuestion: true });
    // A question earlier in the reply is not the reply asking.
    await reply('Why did it fail? The cache was stale.\n\nFixed and released.');
    send('Stop', { transcript_path: transcript });
    expect(await record()).toMatchObject({ state: 'done', asksQuestion: false });
    send('UserPromptSubmit', { prompt: 'go' });
    expect(await record()).toMatchObject({ state: 'working', asksQuestion: null });
  });

  it('records when each turn started and ended, kept through later events', async () => {
    send('SessionStart');
    expect(await record()).toMatchObject({ turnStartedAt: null, turnEndedAt: null });
    send('UserPromptSubmit', { prompt: 'go' });
    const started = (await record()).turnStartedAt;
    expect(started).toEqual(expect.any(Number));
    send('PreToolUse', { tool_name: 'Bash' });
    expect(await record()).toMatchObject({ turnStartedAt: started, turnEndedAt: null });
    send('Stop');
    const ended = (await record()).turnEndedAt;
    expect(ended).toBeGreaterThanOrEqual(started);
    send('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    expect(await record()).toMatchObject({ state: 'done', turnStartedAt: started, turnEndedAt: ended });
    send('UserPromptSubmit', { prompt: 'again' });
    expect((await record()).turnEndedAt).toBeNull();
    expect((await record()).turnStartedAt).toBeGreaterThanOrEqual(ended);
  });

  it("gives a record from an older script turn times on its next event", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, 'abc.json'), JSON.stringify({ sessionId: 'abc', state: 'working', detail: 'x', cwd: '/w/x', event: 'PreToolUse', updatedAt: 5 }));
    send('PostToolUse', { tool_name: 'Bash' });
    expect((await record()).turnStartedAt).toBeGreaterThan(5);
    await writeFile(join(state, 'abc.json'), JSON.stringify({ sessionId: 'abc', state: 'done', detail: 'x', cwd: '/w/x', event: 'Stop', updatedAt: 7 }));
    send('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    expect(await record()).toMatchObject({ state: 'done', turnEndedAt: 7 });
  });

  it('only treats questions for this session as waiting', async () => {
    send('Notification', { message: 'Login successful', notification_type: 'auth_success' });
    expect(await record()).toMatchObject({ state: 'idle', detail: 'Ready', notificationType: 'auth_success' });
    send('UserPromptSubmit', { prompt: 'clean up stacks' });
    send('PreToolUse', { tool_name: 'Bash' });
    // A background job finishing or needing input notifies the session that started it; that is not a question for it.
    send('Notification', { message: 'DELETE_ERROR personal stacks finished', notification_type: 'agent_notification' });
    expect(await record()).toMatchObject({ state: 'working', detail: 'Running Bash', notificationType: 'agent_notification' });
    send('Notification', { message: 'web page needs your input: ready to merge' });
    expect(await record()).toMatchObject({ state: 'working', detail: 'Running Bash', notificationType: null });
    send('Notification', { message: 'MCP server wants input', notification_type: 'elicitation_dialog' });
    expect(await record()).toMatchObject({ state: 'waiting', detail: 'MCP server wants input' });
    // Older Claude builds send no notification_type.
    send('PostToolUse', { tool_name: 'Bash' });
    send('Notification', { message: 'Claude needs your permission to use Bash' });
    expect(await record()).toMatchObject({ state: 'waiting', detail: 'Claude needs your permission to use Bash' });
    send('PostToolUse', { tool_name: 'Bash' });
    expect(await record()).toMatchObject({ state: 'working', notificationType: null });
  });

  it('says what a tool call does and remembers the last edited file', async () => {
    send('UserPromptSubmit', { prompt: 'add a test' });
    send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test\nnpm run build' } });
    expect(await record()).toMatchObject({ detail: 'Running Bash: npm test', lastEditPath: null });
    send('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/w/x/src/a.ts' } });
    expect(await record()).toMatchObject({ detail: 'Editing src/a.ts', lastEditPath: '/w/x/src/a.ts' });
    send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/elsewhere/b.ts' } });
    expect(await record()).toMatchObject({ detail: 'Reading /elsewhere/b.ts', lastEditPath: '/w/x/src/a.ts' });
    send('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'TODO' } });
    expect(await record()).toMatchObject({ detail: 'Searching TODO' });
    send('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Research Orca' } });
    expect(await record()).toMatchObject({ detail: 'Running agent: Research Orca' });
    send('PreToolUse', { tool_name: 'mcp__x__y', tool_input: {} });
    expect(await record()).toMatchObject({ detail: 'Running mcp__x__y', lastEditPath: '/w/x/src/a.ts' });
  });

  it('records a turn that ended on an error as blocked', async () => {
    send('UserPromptSubmit', { prompt: 'deploy' });
    send('StopFailure', { error: 'rate_limit: too many requests\nretry later' });
    expect(await record()).toMatchObject({ state: 'blocked', detail: 'rate_limit: too many requests', prompt: 'deploy' });
    send('StopFailure', { error: { type: 'overloaded_error' } });
    expect(await record()).toMatchObject({ state: 'blocked', detail: 'overloaded_error' });
    send('StopFailure', { error: 'rate_limit', error_details: 'Too many requests\nTry later' });
    expect(await record()).toMatchObject({ state: 'blocked', detail: 'rate_limit: Too many requests' });
    send('StopFailure', { error: 'unknown', error_details: 'socket hang up' });
    expect(await record()).toMatchObject({ state: 'blocked', detail: 'socket hang up' });
    send('StopFailure');
    expect(await record()).toMatchObject({ state: 'blocked', detail: 'Stopped by an error' });
    send('Notification', { message: 'Login successful', notification_type: 'auth_success' });
    expect(await record()).toMatchObject({ state: 'blocked' });
  });

  it('records the tmux pane Claude runs in', async () => {
    // TMUX points at a socket that does not exist, so the session name lookup fails quietly.
    const env: NodeJS.ProcessEnv = { ...process.env, DEVDESK_STATE_DIR: state, TMUX: join(dir, 'no-socket,1,0'), TMUX_PANE: '%7' };
    const input = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop', cwd: '/w/x' });
    expect(spawnSync('python3', ['-I', script], { input, env, encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '' });
    expect(await record()).toMatchObject({ tmuxPane: '%7', tmuxServer: 'no-socket', state: 'done', detail: 'Finished' });
  });

  it('never fails or writes outside the state directory', async () => {
    expect(run('not json')).toMatchObject({ status: 0, stdout: '' });
    expect(run(JSON.stringify({ session_id: '../evil', hook_event_name: 'Stop' }))).toMatchObject({ status: 0 });
    await writeFile(join(dir, 'blocker'), 'x');
    expect(run(JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }), join(dir, 'blocker', 'state'))).toMatchObject({ status: 0, stdout: '' });
    expect((await readdir(dir)).sort()).toEqual(['blocker', 'devdesk_hook.py']);
  });
});

describe('refreshHookScript', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'devdesk-refresh-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  it('upgrades an older installed script and leaves a missing one alone', async () => {
    expect(await refreshHookScript(join(home, '.claude'))).toBe(false);
    expect(await readdir(home)).toEqual([]);
    const script = join(home, '.claude', 'devdesk', 'devdesk_hook.py');
    await mkdir(join(home, '.claude', 'devdesk'), { recursive: true });
    await writeFile(script, '# old version\n');
    expect(await refreshHookScript(join(home, '.claude'))).toBe(true);
    expect(await readFile(script, 'utf8')).toBe(HOOK_SCRIPT);
    expect((await stat(script)).mode & 0o111).not.toBe(0);
    expect(await refreshHookScript(join(home, '.claude'))).toBe(false);
  });
});

describe('installed hook command', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "devdesk cmd it's-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const sh = (command: string, input: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DEVDESK_STATE_DIR;
    delete env.TMUX;
    delete env.TMUX_PANE;
    return spawnSync('sh', ['-c', command], { input, env, encoding: 'utf8' });
  };
  const input = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop', cwd: '/w/x' });

  it('exits 0 silently when the script is missing', () => {
    const result = sh(hookCommand(join(dir, 'missing', 'devdesk_hook.py'), join(dir, 'state')), input);
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('runs the script with the configured state directory', async () => {
    const script = join(dir, 'devdesk_hook.py');
    const state = join(dir, 'custom state');
    await writeFile(script, HOOK_SCRIPT);
    expect(sh(hookCommand(script, state), input)).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(JSON.parse(await readFile(join(state, 'abc.json'), 'utf8'))).toMatchObject({ sessionId: 'abc', state: 'done', event: 'Stop', pid: process.pid });
  });
});
