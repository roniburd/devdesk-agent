import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ActionDeps, pressKey, sendText, sessionDetail, startSession } from '../../src/core/web/actions';
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
    submitDelayMs: 0,
    servers,
    ...over,
  };
};
const sendKeys = (t: FakeTmux) => t.calls.filter((c) => c[0] === 'send-keys');

describe('sendText', () => {
  it('types the text at an empty prompt, then Enter', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    const d = deps(t);
    expect(await sendText(card(), 'hello', 'devdesk', d)).toEqual({ status: 200, body: { ok: true } });
    expect(sendKeys(t)).toEqual([
      ['send-keys', '-t', '%3', '-l', '--', 'hello'],
      ['send-keys', '-t', '%3', 'Enter'],
    ]);
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

  it('types key names and separators as text', async () => {
    const t = fakeTmux({ capture: EMPTY_SCREEN });
    await sendText(card(), 'C-c Enter ; kill-server;', 'devdesk', deps(t));
    expect(sendKeys(t)[0]).toEqual(['send-keys', '-t', '%3', '-l', '--', 'C-c Enter ; kill-server\\;']);
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
    claude: { path: 'claude', modeArgs: '--permission-mode auto' },
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
    expect(t.calls).toEqual([
      [
        'new-session', '-d', '-s', 'cc-main-2', '-c', '/w',
        '-e', 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1',
        `claude --permission-mode auto -- 'fix it'\\''s tests'; exec $SHELL -l`,
        ';', 'set-option', '-t', '=cc-main-2:', 'mouse', 'on',
      ],
    ]);
  });

  it('accepts the realpath of a folder, and no prompt', async () => {
    const t = fakeTmux();
    expect(await startSession({ dir: '/real/w', prompt: '' }, features, [], cfg, deps(t))).toMatchObject({ status: 201, body: { tmuxSession: 'cc-main' } });
    expect(t.calls[0][8]).toBe('claude --permission-mode auto; exec $SHELL -l');
  });

  it('runs a long prompt from a script', async () => {
    const t = fakeTmux();
    await startSession({ dir: '/w/worktrees/feat', prompt: 'x'.repeat(10_000) }, features, [], cfg, deps(t));
    const command = t.calls[0][t.calls[0].indexOf('CLAUDE_CODE_DISABLE_AGENT_VIEW=1') + 1];
    expect(command).toMatch(/^\. '.*devdesk-claude-start-.*\/start\.sh'$/);
    expect((await readdir(tmp)).length).toBe(1);
  });

  it('gives 502 when tmux fails', async () => {
    const t = fakeTmux({ fail: { 'new-session': 'duplicate session: cc-main' } });
    expect(await startSession({ dir: '/w', prompt: '' }, features, [], cfg, deps(t))).toMatchObject({ status: 502, body: { code: 'tmux' } });
  });
});

describe('sessionDetail', () => {
  const o = { now: Date.now(), stuckMs: 600_000, idleMs: 30 * 60_000, unread: new Set<string>(), server: 'devdesk' };

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

  it('is ended when the pane is gone', async () => {
    const t = fakeTmux({ fail: { 'capture-pane': "can't find pane: %3" } });
    const r = await sessionDetail(card(), o, deps(t));
    expect(r).toMatchObject({ status: 200, body: { ended: true, screen: [] } });
  });

  it('is ended when Claude exited', async () => {
    const d = deps(fakeTmux(), { listProcesses: async () => processTable([[100, 1, 'zsh']]) });
    expect(await sessionDetail(card(), o, d)).toMatchObject({ status: 200, body: { ended: true } });
  });

  it('has no turns without a transcript', async () => {
    const r = await sessionDetail(card({ transcriptPath: join(tmp, 'missing.jsonl') }), o, deps(fakeTmux()));
    expect(r).toMatchObject({ status: 200, body: { turns: [] } });
  });

  it('gives 502 for another tmux error', async () => {
    expect(await sessionDetail(card(), o, deps(fakeTmux({ fail: { 'capture-pane': 'boom' } })))).toMatchObject({ status: 502 });
  });
});
