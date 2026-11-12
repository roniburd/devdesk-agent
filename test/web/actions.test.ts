import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ActionDeps, detailTurns, pressKey, sendText, sessionDetail, startSession } from '../../src/core/web/actions';
import { DETAIL_MAX_TAIL_BYTES } from '../../src/core/web/transcript';
import type { DaemonConfig } from '../../src/core/web/config';
import type { SessionCard } from '../../src/core/sessions';
import type { Feature } from '../../src/core/worktrees';
import { DIALOG_SCREEN, EMPTY_SCREEN, fakeTmux, type FakeTmux, processTable, WORKING_SCREEN } from './fakes';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'web-actions-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  sessionId: 's1',
  state: 'idle',
  detail: 'Ready',
  attached: false,
  tmuxSession: 'cc-main',
  tmuxPane: '%3',
  tmuxServer: 'devdesk',
  featureName: 'main',
  featureDir: '/w',
  cwd: '/w',
  name: 'Fix it',
  updatedAt: Date.now(),
  ...over,
});

/** Claude runs under pane pid 100. */
const claudeRuns = async () => processTable([[100, 1, 'sh'], [101, 100, 'claude']]);
const deps = (tmux: FakeTmux, over: Partial<ActionDeps> = {}): ActionDeps & { servers: string[] } => {
  const servers: string[] = [];
  return {
    tmux: (server) => {
      servers.push(server);
      return tmux.run;
    },
    listProcesses: claudeRuns,
    tmpDir: tmp,
    settleMs: 0,
    servers,
    ...over,
  };
};
const sendKeys = (t: FakeTmux) => t.calls.filter((c) => c[0] === 'send-keys');
/** The first tmux call from its `new-session` on (attachArgs clears Claude's child variables first). */
const newSession = (t: FakeTmux) => t.calls[0].slice(t.calls[0].indexOf('new-session'));

describe('sendText', () => {
  it('types the text at an empty prompt, then Enter', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    const d = deps(t);
    expect(await sendText(card(), 'hello', 'devdesk', d)).toEqual({ status: 200, body: { ok: true } });
    // Pasted through a tmux buffer of its own (as the Claude Board types), then Enter.
    expect(t.calls.slice(1).map((c) => c[0])).toEqual(['load-buffer', 'paste-buffer', 'send-keys']);
    expect(sendKeys(t)).toEqual([['send-keys', '-t', '%3', 'Enter']]);
    expect(d.servers).toEqual(['devdesk']);
  });

  it('refuses while Claude works, and sends nothing', async () => {
    const t = fakeTmux({ capture: WORKING_SCREEN });
    const r = await sendText(card(), 'hello', 'devdesk', deps(t));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'blocked', error: '"Fix it" is working: send your reply when it is done.' });
    expect(sendKeys(t)).toEqual([]);
  });

  it('refuses while the hooks say it works, whatever the screen shows', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    expect((await sendText(card({ state: 'working' }), 'hello', 'devdesk', deps(t))).status).toBe(409);
    expect(sendKeys(t)).toEqual([]);
  });

  it('refuses with a dialog open', async () => {
    const t = fakeTmux({ capture: DIALOG_SCREEN });
    const r = await sendText(card(), 'hello', 'devdesk', deps(t));
    expect(r).toMatchObject({ status: 409, body: { code: 'blocked' } });
    expect(r.body).toHaveProperty('error', expect.stringMatching(/not at an empty prompt/));
    expect(sendKeys(t)).toEqual([]);
  });

  it("refuses while Claude's own report says it works or a dialog is open, as the board does", async () => {
    for (const state of ['working', 'blocked'] as const) {
      const t = fakeTmux({ capture: EMPTY_SCREEN });
      const d = deps(t, { programStatus: async () => ({ state, at: Date.now(), pid: 101 }) });
      expect(await sendText(card(), 'hello', 'devdesk', d), state).toMatchObject({ status: 409, body: { code: 'blocked' } });
      expect(sendKeys(t)).toEqual([]);
    }
    const idle = deps(fakeTmux({ capture: EMPTY_SCREEN }), { programStatus: async () => ({ state: 'idle', at: Date.now(), pid: 101 }) });
    expect(await sendText(card(), 'hello', 'devdesk', idle)).toMatchObject({ status: 200 });
  });

  it('refuses in copy mode', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN, inMode: true });
    expect(await sendText(card(), 'hello', 'devdesk', deps(t))).toMatchObject({ status: 409 });
  });

  it('gives 410 when the pane is gone', async () => {
    const t = fakeTmux({ fail: { 'capture-pane': "can't find pane: %3" } });
    expect(await sendText(card(), 'hello', 'devdesk', deps(t))).toMatchObject({ status: 410, body: { code: 'ended' } });
  });

  it('gives 410 when Claude exited', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    const d = deps(t, { listProcesses: async () => processTable([[100, 1, 'zsh']]) });
    expect(await sendText(card(), 'hello', 'devdesk', d)).toMatchObject({ status: 410 });
    expect(sendKeys(t)).toEqual([]);
  });

  it('gives 410 outside tmux or once stopped', async () => {
    const t = fakeTmux();
    expect(await sendText(card({ tmuxPane: undefined, tmuxSession: undefined }), 'x', 'devdesk', deps(t))).toMatchObject({ status: 410 });
    expect(await sendText(card({ state: 'stopped' }), 'x', 'devdesk', deps(t))).toMatchObject({ status: 410 });
    expect(t.calls).toEqual([]);
  });

  it('gives 502 for another tmux error', async () => {
    const t = fakeTmux({ fail: { 'capture-pane': 'protocol version mismatch' } });
    expect(await sendText(card(), 'hello', 'devdesk', deps(t))).toMatchObject({ status: 502, body: { code: 'tmux' } });
  });

  it('refuses text that types as nothing', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    expect(await sendText(card(), '\x01\x02', 'devdesk', deps(t))).toMatchObject({ status: 400 });
    expect(t.calls).toEqual([]);
  });

  it('pastes key names and separators as text, never as tmux arguments', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    await sendText(card(), 'C-c Enter ; kill-server;', 'devdesk', deps(t));
    expect(t.calls.flat()).not.toContain('C-c Enter ; kill-server;');
    expect(sendKeys(t)).toEqual([['send-keys', '-t', '%3', 'Enter']]);
  });
});

describe('pressKey', () => {
  it('sends one key', async () => {
    const t = fakeTmux();
    expect(await pressKey(card(), 'Escape', 'devdesk', deps(t))).toEqual({ status: 200, body: { ok: true } });
    expect(t.calls).toEqual([['send-keys', '-t', '%3', 'Escape']]);
  });

  it('presses keys while Claude works (to interrupt)', async () => {
    const t = fakeTmux({ capture: WORKING_SCREEN });
    expect(await pressKey(card({ state: 'working' }), 'Escape', 'devdesk', deps(t))).toMatchObject({ status: 200 });
  });

  it('gives 400 for a key outside the list', async () => {
    const t = fakeTmux();
    expect(await pressKey(card(), 'C-c' as 'Enter', 'devdesk', deps(t))).toMatchObject({ status: 400 });
    expect(t.calls).toEqual([]);
  });

  it('gives 410 when the pane is gone or Claude is gone', async () => {
    expect(await pressKey(card(), 'Enter', 'devdesk', deps(fakeTmux({ fail: { 'send-keys': 'no server running on /tmp/x' } })))).toMatchObject({ status: 410 });
    expect(await pressKey(card({ state: 'parked' }), 'Enter', 'devdesk', deps(fakeTmux()))).toMatchObject({ status: 410 });
  });
});

describe('startSession', () => {
  const features: Feature[] = [
    { name: 'main', dir: '/w', isMain: true, packages: [], realDir: '/real/w' },
    { name: 'feat', dir: '/w/worktrees/feat', isMain: false, packages: [] },
  ];
  const cfg: Pick<DaemonConfig, 'tmux' | 'claude'> = {
    tmux: { bin: 'tmux', server: 'devdesk', options: [['mouse', 'on']], env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: '1' } },
    claude: { path: 'claude', modeArgs: '--permission-mode auto', env: {} },
  };

  it('refuses a folder that is not listed, and runs no tmux', async () => {
    const t = fakeTmux();
    for (const dir of ['/etc', '/w/../etc', '/w/', '/w/worktrees', '/w/worktrees/feat/src']) {
      expect(await startSession({ dir, prompt: '' }, features, [], cfg, deps(t))).toMatchObject({ status: 400 });
    }
    expect(t.calls).toEqual([]);
  });

  it('starts Claude with the prompt in a new session on the configured server', async () => {
    const t = fakeTmux();
    const d = deps(t);
    const r = await startSession({ dir: '/w', prompt: "fix it's tests" }, features, ['cc-main', 'cc-feat'], cfg, d);
    expect(r).toEqual({ status: 201, body: { tmuxSession: 'cc-main-2', server: 'devdesk' } });
    expect(d.servers).toEqual(['devdesk']);
    expect(t.calls).toHaveLength(1);
    expect(newSession(t)).toEqual([
      'new-session', '-d', '-s', 'cc-main-2', '-c', '/w',
      '-e', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1',
      '-e', 'DEVDESK_TMUX_SESSION=cc-main-2',
      '-e', 'DEVDESK_TMUX_SERVER=devdesk',
      `claude --permission-mode auto -- 'fix it'\\''s tests'; exec $SHELL -l`,
      ';', 'set-option', '-t', '=cc-main-2:', 'mouse', 'on',
    ]);
  });

  it('accepts the realpath of a folder, and no prompt', async () => {
    const t = fakeTmux();
    expect(await startSession({ dir: '/real/w', prompt: '' }, features, [], cfg, deps(t))).toMatchObject({ status: 201, body: { tmuxSession: 'cc-main' } });
    expect(newSession(t)[12]).toBe('claude --permission-mode auto; exec $SHELL -l');
  });

  it("starts Claude as the Claude view does: the Program Status relay, in the default account's environment", async () => {
    const t = fakeTmux();
    const claude = { path: 'claude', args: '--verbose', wrapper: "'python3' -I 'relay.py' '/s'", modeArgs: '', env: { CLAUDE_CONFIG_DIR: '/home/u/.claude-work' } };
    await startSession({ dir: '/w', prompt: 'hi' }, features, [], { ...cfg, claude }, deps(t));
    expect(newSession(t)[12]).toBe(`export CLAUDE_CONFIG_DIR='/home/u/.claude-work'; 'python3' -I 'relay.py' '/s' claude --verbose -- 'hi'; exec $SHELL -l`);
  });

  it('runs a long prompt from a script', async () => {
    const t = fakeTmux();
    await startSession({ dir: '/w/worktrees/feat', prompt: 'x'.repeat(10_000) }, features, [], cfg, deps(t));
    const command = t.calls[0][t.calls[0].indexOf('DEVDESK_TMUX_SERVER=devdesk') + 1];
    expect(command).toMatch(/^\. '.*devdesk-claude-start-.*\/start\.sh'$/);
    expect((await readdir(tmp)).length).toBe(1);
  });

  it('starts in the chosen mode with the chosen model and effort, and refuses what is not offered', async () => {
    const t = fakeTmux();
    const withModes = { ...cfg, claude: { ...cfg.claude, modes: [{ name: 'Auto', args: '--permission-mode auto' }, { name: 'Plan', args: '--permission-mode plan' }], defaultMode: 'Auto' } };
    expect(await startSession({ dir: '/w', prompt: 'go', mode: 'Plan', model: 'opus', effort: 'high' }, features, [], withModes, deps(t))).toMatchObject({ status: 201 });
    expect(newSession(t)[12]).toBe("claude --permission-mode plan --model 'opus' --effort 'high' -- 'go'; exec $SHELL -l");
    for (const bad of [{ mode: 'Bypass' }, { model: '--dangerously-skip-permissions' }, { effort: 'ludicrous' }]) {
      expect(await startSession({ dir: '/w', prompt: '', ...bad }, features, [], withModes, deps(t))).toMatchObject({ status: 400, body: { code: 'bad-request' } });
    }
    expect(t.calls).toHaveLength(1);
  });

  it('gives 502 when tmux fails', async () => {
    const t = fakeTmux({ fail: { 'new-session': 'duplicate session: cc-main' } });
    expect(await startSession({ dir: '/w', prompt: '' }, features, [], cfg, deps(t))).toMatchObject({ status: 502, body: { code: 'tmux' } });
  });
});

describe('sessionDetail', () => {
  const o = { now: Date.now(), stuckMs: 600_000, idleMs: 30 * 60_000, unread: new Set<string>(), mode: 'urgency' as const, recentMs: 900_000, unreadFirst: true, server: 'devdesk' };

  it('gives the turns, the screen and the prompt state', async () => {
    const transcript = join(tmp, 's1.jsonl');
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'fix <b>it</b>' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      ].join('\n'),
    );
    const t = fakeTmux({ capture: `\x1b[31m<script>x</script>\x1b[0m\n${EMPTY_SCREEN}` });
    const r = await sessionDetail(card({ transcriptPath: transcript }), o, deps(t));
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body.card).toMatchObject({ id: 's1', title: 'Fix it' });
    expect(r.body.turns).toEqual([
      { kind: 'user', text: 'fix <b>it</b>' },
      { kind: 'assistant', text: 'Done.' },
    ]);
    expect(r.body.screen[0]).toEqual([{ text: '<script>x</script>', fg: 1 }]);
    expect(r.body.prompt).toEqual({ empty: true, dialog: false, working: false, inMode: false, exited: false });
    expect(r.body.ended).toBe(false);
  });

  it("shows the keys when Claude's own report says a dialog is open", async () => {
    const d = deps(fakeTmux({ capture: EMPTY_SCREEN }), { programStatus: async () => ({ state: 'blocked', kind: 'permission', at: Date.now(), pid: 101 }) });
    const r = await sessionDetail(card(), o, d);
    expect(r).toMatchObject({ status: 200, body: { prompt: { empty: false, dialog: true, working: false } } });
  });

  it('is ended when the pane is gone', async () => {
    const t = fakeTmux({ fail: { 'capture-pane': "can't find pane: %3" } });
    const r = await sessionDetail(card(), o, deps(t));
    expect(r).toMatchObject({ status: 200, body: { ended: true, screen: [] } });
  });

  it('is ended when Claude exited', async () => {
    const d = deps(fakeTmux(), { listProcesses: async () => processTable([[100, 1, 'zsh']]) });
    expect(await sessionDetail(card(), o, d)).toMatchObject({ status: 200, body: { ended: true } });
  });

  it('reads further back when tool output leaves too few messages at the end, up to a limit', async () => {
    const transcript = join(tmp, 'big.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'take a screenshot' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Taking it.' }] } }),
      // A screenshot's result, longer than the first read: without reading further back, nothing is said.
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(300_000) }] } }),
    ];
    await writeFile(transcript, lines.join('\n'));
    expect(await detailTurns(transcript)).toEqual([
      { kind: 'user', text: 'take a screenshot' },
      { kind: 'assistant', text: 'Taking it.' },
    ]);
    // Past DETAIL_MAX_TAIL_BYTES of tool output, it stops looking.
    const huge = join(tmp, 'huge.jsonl');
    const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'y'.repeat(DETAIL_MAX_TAIL_BYTES) }] } });
    await writeFile(huge, [lines[0], result].join('\n'));
    expect(await detailTurns(huge)).toEqual([]);
  });

  it('has no turns without a transcript', async () => {
    const r = await sessionDetail(card({ transcriptPath: join(tmp, 'missing.jsonl') }), o, deps(fakeTmux()));
    expect(r).toMatchObject({ status: 200, body: { turns: [] } });
  });

  it('gives 502 for another tmux error', async () => {
    expect(await sessionDetail(card(), o, deps(fakeTmux({ fail: { 'capture-pane': 'boom' } })))).toMatchObject({ status: 502 });
  });
});
