import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_SCRIPT,
  cardsWithNotes,
  cliPaths,
  cliWrapper,
  isOurSkill,
  MAX_NOTE_LENGTH,
  noteText,
  parseCliRequest,
  parseNoteFile,
  readNotes,
  skillText,
  staleNotes,
  windowPanes,
  type WindowRecord,
} from '../src/core/devdeskCli';
import type { SessionCard } from '../src/core/sessions';

const card = (over: Partial<SessionCard>): SessionCard => ({ id: 'x', state: 'idle', detail: '', attached: false, ...over });

describe('parseCliRequest', () => {
  const base = { id: 'abcdef012345', token: 't0k', action: 'open', cwd: '/w', path: '/w/a.ts', line: 3, column: 2, focus: true, server: 'devdesk', pane: '%4' };
  it('reads a request with the window token', () => {
    expect(parseCliRequest(JSON.stringify(base), 't0k')).toEqual({ id: 'abcdef012345', action: 'open', cwd: '/w', path: '/w/a.ts', line: 3, column: 2, focus: true, server: 'devdesk', pane: '%4' });
  });
  it('reads devdesk ticket, in tmux or not, and refuses a text too long', () => {
    const ticket = { id: 'abcdef012345', token: 't0k', action: 'ticket', cwd: '/w', text: 'ABC-1' };
    expect(parseCliRequest(JSON.stringify(ticket), 't0k')).toEqual({ id: 'abcdef012345', action: 'ticket', cwd: '/w', text: 'ABC-1', focus: false });
    expect(parseCliRequest(JSON.stringify({ ...ticket, text: 'x'.repeat(3000) }), 't0k')).toEqual({ error: 'the ticket is longer than 2000 characters' });
  });
  it('refuses another token, unknown actions, relative paths and a note outside tmux', () => {
    expect(parseCliRequest(JSON.stringify(base), 'other')).toEqual({ error: 'wrong token' });
    expect(parseCliRequest(JSON.stringify({ ...base, action: 'rm' }), 't0k')).toEqual({ error: 'unknown action rm' });
    expect(parseCliRequest(JSON.stringify({ ...base, path: 'a.ts' }), 't0k')).toEqual({ error: 'the path is not absolute' });
    expect(parseCliRequest(JSON.stringify({ ...base, path: undefined }), 't0k')).toEqual({ error: 'open needs a file' });
    expect(parseCliRequest(JSON.stringify({ ...base, action: 'note', pane: undefined }), 't0k')).toEqual({ error: 'devdesk note works only in a tmux session' });
    expect(parseCliRequest('nope', 't0k')).toEqual({ error: 'not a request' });
  });
  it('drops fields of the wrong kind', () => {
    const req = parseCliRequest(JSON.stringify({ ...base, line: 0, column: 'x', focus: 'yes', server: 'a b', pane: '4' }), 't0k');
    expect(req).toEqual({ id: 'abcdef012345', action: 'open', cwd: '/w', path: '/w/a.ts', focus: false });
  });
});

describe('parseCliRequest for devdesk worker', () => {
  const base = { id: 'abcdef012345', token: 't0k', action: 'worker', cwd: '/w', server: 'devdesk', pane: '%4' };
  const parse = (o: Record<string, unknown>) => parseCliRequest(JSON.stringify({ ...base, ...o }), 't0k');
  it('reads each verb', () => {
    expect(parse({ verb: 'start', name: 'lint', text: 'fix it', where: 'new', base: 'origin/main' })).toMatchObject({ verb: 'start', name: 'lint', text: 'fix it', where: 'new', base: 'origin/main' });
    expect(parse({ verb: 'start', name: 'lint', text: 'fix it', where: 'current' })).toMatchObject({ where: 'current' });
    expect(parse({ verb: 'done', taskId: 'w-0a1b2c', outcome: 'failed', text: 'no' })).toMatchObject({ verb: 'done', taskId: 'w-0a1b2c', outcome: 'failed' });
    expect(parse({ verb: 'ask', text: 'which?', pane: undefined })).toMatchObject({ verb: 'ask', text: 'which?' });
    expect(parse({ verb: 'check' })).toMatchObject({ verb: 'check' });
    expect(parse({ verb: 'reply', taskId: 'w-0a1b2c', text: 'main' })).toMatchObject({ verb: 'reply', taskId: 'w-0a1b2c' });
  });
  it('refuses what is missing or malformed', () => {
    expect(parse({ verb: 'rm' })).toEqual({ error: 'unknown worker command rm' });
    expect(parse({ verb: 'start', text: 'x' })).toMatchObject({ error: expect.stringMatching(/--name/) });
    expect(parse({ verb: 'start', name: 'n' })).toMatchObject({ error: expect.stringMatching(/--task/) });
    expect(parse({ verb: 'start', name: 'n', text: 'x', base: '--upload-pack=x' })).toMatchObject({ error: expect.stringMatching(/not a git ref/) });
    expect(parse({ verb: 'start', name: 'n', text: 'x', where: 'current', base: 'main' })).toEqual({ error: '--base needs --worktree new' });
    expect(parse({ verb: 'start', name: 'n', text: 'x', pane: undefined })).toMatchObject({ error: expect.stringMatching(/only in a DevDesk Claude session/) });
    expect(parse({ verb: 'done', text: 'x', outcome: 'maybe' })).toMatchObject({ error: expect.stringMatching(/--outcome/) });
    expect(parse({ verb: 'done', outcome: 'succeeded' })).toMatchObject({ error: expect.stringMatching(/--summary/) });
    expect(parse({ verb: 'reply', text: 'x' })).toMatchObject({ error: expect.stringMatching(/--task/) });
    expect(parse({ verb: 'ask', taskId: '../x', text: 'q' })).toEqual({ error: 'not a task id: ../x' });
    expect(parse({ verb: 'ask', text: 'x'.repeat(40_000) })).toMatchObject({ error: expect.stringMatching(/longer than/) });
  });
  it('teaches the skill the orchestration commands', () => {
    expect(skillText('devdesk')).toMatch(/## Coordinator and workers[^]*devdesk worker start --name[^]*end your turn/);
  });
});

describe('notes', () => {
  it('are one line, without control characters, cut short', () => {
    expect(noteText('  waiting\nfor CI\u0007 ')).toBe('waiting for CI');
    expect(noteText('x'.repeat(400))).toHaveLength(MAX_NOTE_LENGTH);
    expect(parseNoteFile('{"text":"a","at":1}')).toEqual({ text: 'a', at: 1 });
    expect(parseNoteFile('{"text":" ","at":1}')).toBeUndefined();
  });
  it('go on the card of their pane', () => {
    const cards = [card({ id: 'a', tmuxServer: 'devdesk', tmuxPane: '%3' }), card({ id: 'b', tmuxPane: '%3' }), card({ id: 'c' })];
    const out = cardsWithNotes(cards, new Map([['devdesk-3.json', { text: 'hi' }]]));
    expect(out.map((c) => c.note)).toEqual(['hi', undefined, undefined]);
  });
  it('of panes gone from a listed server are stale; other servers keep theirs', () => {
    const names = ['devdesk-3.json', 'devdesk-4.json', 'default-1.json', 'devdesk-x-5.json', 'other.txt'];
    expect(staleNotes(names, new Map([['devdesk', ['%3']]]))).toEqual(['devdesk-4.json']);
    expect(staleNotes(names, new Map([['devdesk', []], ['default', ['%1']]]))).toEqual(['devdesk-3.json', 'devdesk-4.json']);
  });
  it('are read from their directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-notes-'));
    try {
      writeFileSync(join(dir, 'devdesk-3.json'), JSON.stringify({ text: 'a', at: 5 }));
      writeFileSync(join(dir, 'devdesk-4.json'), 'garbage');
      expect([...(await readNotes(dir))]).toEqual([['devdesk-3.json', { text: 'a', at: 5 }]]);
      expect((await readNotes(join(dir, 'missing'))).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the window record and the skill', () => {
  it('lists each pane once, with its server', () => {
    expect(windowPanes([{ tmuxPane: '%2', tmuxServer: 'devdesk' }, { tmuxPane: '%1' }, { tmuxPane: '%2', tmuxServer: 'devdesk' }, {}])).toEqual(['default:%1', 'devdesk:%2']);
  });
  it('names the command by its path, and is told from a skill the user wrote', () => {
    const text = skillText('/h/.claude/devdesk/devdesk');
    expect(text).toMatch(/^---\nname: devdesk\n/);
    expect(text).toContain('allowed-tools: Bash(/h/.claude/devdesk/devdesk:*)');
    expect(text).toContain('/h/.claude/devdesk/devdesk open <file>');
    expect(isOurSkill(text)).toBe(true);
    expect(isOurSkill('---\nname: devdesk\n---\nmine')).toBe(false);
  });
  it('says the commands need a DevDesk Claude v2 window on this folder, and what the error means', () => {
    const text = skillText('devdesk');
    expect(text).toContain('needs a VS Code window running DevDesk Claude v2 with this folder (or worktree) open');
    expect(text).toContain('"no VS Code window running DevDesk Claude v2 has ... open" means there is none');
  });
});

const pythonRuns = spawnSync('python3', ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0;

describe.skipIf(!pythonRuns)('the devdesk command (python3)', () => {
  let home = '';
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  /** A Claude config directory with the command, and windows (records and request directories) in its IPC directory. */
  function setUp(windowsOf: (home: string, work: string) => Partial<WindowRecord>[]) {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'devdesk-cli-')));
    const work = join(home, 'work');
    const windows = windowsOf(home, work);
    const paths = cliPaths(home);
    mkdirSync(join(home, 'devdesk'));
    writeFileSync(paths.script, CLI_SCRIPT);
    writeFileSync(paths.command, cliWrapper('python3'));
    chmodSync(paths.command, 0o755);
    for (const d of [paths.ipc, paths.windows, join(paths.ipc, 'requests'), paths.responses]) mkdirSync(d, { mode: 0o700 });
    for (const [i, w] of windows.entries()) {
      const record = { id: `w${i}`, pid: process.pid, token: `token${i}`, roots: [], panes: [], focusedAt: 0, ...w };
      writeFileSync(join(paths.windows, `${record.id}.json`), JSON.stringify(record), { mode: 0o600 });
      mkdirSync(paths.requests(record.id), { mode: 0o700 });
    }
    mkdirSync(join(work, 'src'), { recursive: true });
    writeFileSync(join(work, 'src', 'a.ts'), 'one\ntwo\nthree\n');
    return { paths, work };
  }

  /** Runs the command in `cwd`; the window that gets its request answers `answer`. Resolves with what it printed and the request. */
  function run(paths: ReturnType<typeof cliPaths>, cwd: string, args: string[], env: Record<string, string> = {}, answer = { ok: true, message: 'done' }) {
    return new Promise<{ code: number | null; out: string; err: string; request?: { window: string; body: Record<string, unknown> } }>((resolve) => {
      const child = spawn(paths.command, args, { cwd, env: { PATH: process.env.PATH ?? '', HOME: home, ...env } });
      let out = '';
      let err = '';
      let request: { window: string; body: Record<string, unknown> } | undefined;
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const timer = setInterval(() => {
        const root = join(paths.ipc, 'requests');
        for (const w of readdirSync(root)) {
          for (const name of readdirSync(join(root, w)).filter((n) => /^[0-9a-f]+\.json$/.test(n))) {
            const file = join(root, w, name);
            request = { window: w, body: JSON.parse(readFileSync(file, 'utf8')) };
            rmSync(file);
            writeFileSync(join(paths.responses, name), JSON.stringify(answer));
          }
        }
      }, 20);
      child.on('close', (code) => {
        clearInterval(timer);
        resolve({ code, out, err, request });
      });
    });
  }

  it('asks the window whose folder holds the file most closely, with its token, and prints its answer', async () => {
    const { paths, work } = setUp((home, work) => [{ roots: [home] }, { roots: [work], token: 'tk' }, { roots: [join(home, 'elsewhere')] }]);
    const r = await run(paths, work, ['open', 'src/a.ts:2:3']);
    expect(r).toMatchObject({ code: 0, out: 'done\n', err: '' });
    expect(r.request?.window).toBe('w1');
    expect(r.request?.body).toMatchObject({ action: 'open', token: 'tk', cwd: work, path: join(work, 'src', 'a.ts'), line: 2, column: 3, focus: false });
  });

  it('prefers the window that shows its tmux pane, then the one last in front', async () => {
    const { paths, work } = setUp((home, work) => [{ roots: [work] }, { roots: [home], panes: ['devdesk:%7'] }, { roots: [work], focusedAt: 5 }]);
    const tmux = { TMUX: '/tmp/tmux-1/devdesk,123,0', TMUX_PANE: '%7' };
    expect((await run(paths, work, ['diff', '--focus'], tmux)).request).toMatchObject({ window: 'w1', body: { action: 'diff', focus: true, server: 'devdesk', pane: '%7' } });
    expect((await run(paths, work, ['diff', 'src/a.ts'])).request).toMatchObject({ window: 'w2', body: { path: join(work, 'src', 'a.ts') } });
  });

  it('sets a note from tmux only, through the window that has its folder open', async () => {
    const { paths, work } = setUp((_, work) => [{ roots: ['/nowhere'], focusedAt: 9 }, { roots: [work] }]);
    const tmux = { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%2' };
    expect((await run(paths, work, ['note', 'waiting', 'for', 'CI'], tmux)).request).toMatchObject({ window: 'w1', body: { action: 'note', text: 'waiting for CI', server: 'default', pane: '%2' } });
    expect((await run(paths, work, ['note', '--clear'], tmux)).request?.body).toMatchObject({ text: '' });
    const outside = await run(paths, work, ['note', 'x']);
    expect(outside.code).toBe(1);
    expect(outside.err).toMatch(/only in a tmux session/);
  });

  it('sends note and worker requests to no window that neither shows the session nor has its folder open', async () => {
    // A session in a v1 window, or in a folder no v2 window has open: the v2 window in front shows something else.
    const { paths, work } = setUp((home) => [{ roots: [join(home, 'elsewhere')], panes: ['default:%9'], focusedAt: 9 }]);
    const tmux = { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%2' };
    for (const args of [['note', 'x'], ['worker', 'check'], ['worker', 'list'], ['worker', 'done', '--task', 'w-0a1b2c', '--outcome', 'succeeded', '--summary', 'ok']]) {
      const r = await run(paths, work, args, tmux);
      expect(r).toMatchObject({ code: 1, request: undefined });
      expect(r.err).toBe(
        `devdesk: no VS Code window running DevDesk Claude v2 has ${work} open. The devdesk command needs a DevDesk Claude v2 window with this folder (or worktree) open; DevDesk Claude v1 windows do not take its requests.\n`,
      );
    }
  });

  it('says why when no window shows the folder, the file is missing, or the window refuses', async () => {
    const { paths, work } = setUp((_, work) => [{ roots: ['/nowhere'] }, { roots: [work], pid: 999_999_999 }]);
    const none = await run(paths, work, ['open', 'src/a.ts']);
    expect(none).toMatchObject({ code: 1, request: undefined });
    expect(none.err).toMatch(/no VS Code window running DevDesk Claude v2 has .*src\/a\.ts open\. .*v1 windows do not take its requests/);
    expect((await run(paths, work, ['open', 'src/nope.ts'])).err).toMatch(/no file src\/nope.ts/);
    expect((await run(paths, work, ['bogus'])).code).toBe(2);
    expect((await run(paths, work, ['--help'])).out).toMatch(/^usage: devdesk/);
  });

  it('sends devdesk worker requests through the window of its pane', async () => {
    const { paths, work } = setUp((home) => [{ roots: ['/nowhere'] }, { roots: [home], panes: ['devdesk:%7'] }]);
    const tmux = { TMUX: '/tmp/tmux-1/devdesk,123,0', TMUX_PANE: '%7' };
    writeFileSync(join(work, 'spec.md'), 'the long spec\n');
    const start = await run(paths, work, ['worker', 'start', '--name', 'lint', '--task', '@spec.md', '--worktree=current'], tmux);
    expect(start.request).toMatchObject({ window: 'w1', body: { action: 'worker', verb: 'start', name: 'lint', text: 'the long spec\n', where: 'current', pane: '%7' } });
    const done = await run(paths, work, ['worker', 'done', '--task', 'w-0a1b2c', '--outcome', 'succeeded', '--summary', 'all good'], tmux);
    expect(done.request?.body).toMatchObject({ verb: 'done', taskId: 'w-0a1b2c', outcome: 'succeeded', text: 'all good' });
    expect((await run(paths, work, ['worker', 'ask', '--task', 'w-0a1b2c', 'which', 'branch?'], tmux)).request?.body).toMatchObject({ verb: 'ask', text: 'which branch?' });
    expect((await run(paths, work, ['worker', 'reply', '--task', 'w-0a1b2c', 'main'], tmux)).request?.body).toMatchObject({ verb: 'reply', text: 'main' });
    expect((await run(paths, work, ['worker', 'check'], tmux)).request?.body).toMatchObject({ verb: 'check' });
    expect((await run(paths, work, ['worker', 'start', '--task', 'x'], tmux)).code).toBe(2);
    expect((await run(paths, work, ['worker', 'done', '--outcome', 'maybe', '--summary', 'x'], tmux)).code).toBe(2);
    expect((await run(paths, work, ['worker', 'start', '--name', 'n', '--task', '@missing.md'], tmux)).err).toMatch(/cannot read missing\.md/);
    expect((await run(paths, work, ['worker', 'bogus'], tmux)).code).toBe(2);
    expect((await run(paths, work, ['worker', '--help'])).out).toMatch(/^usage: devdesk worker/);
  });

  it('exits 1 with what the window says when it refuses', async () => {
    const { paths, work } = setUp((_, work) => [{ roots: [work] }]);
    const refused = await run(paths, work, ['open', 'src/a.ts'], {}, { ok: false, message: 'nope' });
    expect(refused).toMatchObject({ code: 1, err: 'devdesk: nope\n' });
  });

  it('refuses an IPC directory others can open', async () => {
    const { paths, work } = setUp((home) => [{ roots: [home] }]);
    chmodSync(paths.ipc, 0o755);
    const r = await run(paths, work, ['open', 'src/a.ts']);
    expect(r.code).toBe(1);
    expect(existsSync(join(paths.requests('w0')))).toBe(true);
    expect(readdirSync(paths.requests('w0'))).toEqual([]);
  });
});
