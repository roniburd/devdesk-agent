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

  it('sets a note from tmux only, through any window', async () => {
    const { paths, work } = setUp(() => [{ roots: ['/nowhere'] }]);
    const tmux = { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%2' };
    expect((await run(paths, work, ['note', 'waiting', 'for', 'CI'], tmux)).request?.body).toMatchObject({ action: 'note', text: 'waiting for CI', server: 'default', pane: '%2' });
    expect((await run(paths, work, ['note', '--clear'], tmux)).request?.body).toMatchObject({ text: '' });
    const outside = await run(paths, work, ['note', 'x']);
    expect(outside.code).toBe(1);
    expect(outside.err).toMatch(/only in a tmux session/);
  });

  it('says why when no window shows the folder, the file is missing, or the window refuses', async () => {
    const { paths, work } = setUp((_, work) => [{ roots: ['/nowhere'] }, { roots: [work], pid: 999_999_999 }]);
    const none = await run(paths, work, ['open', 'src/a.ts']);
    expect(none).toMatchObject({ code: 1, request: undefined });
    expect(none.err).toMatch(/no VS Code window with DevDesk Claude shows/);
    expect((await run(paths, work, ['open', 'src/nope.ts'])).err).toMatch(/no file src\/nope.ts/);
    expect((await run(paths, work, ['bogus'])).code).toBe(2);
    expect((await run(paths, work, ['--help'])).out).toMatch(/^usage: devdesk/);
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
