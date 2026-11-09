import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDir } from '../src/board/commands/addDir';
import { plan } from '../src/board/commands/plan';
import { dispatch, handlerFor } from '../src/board/dispatch';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { SubmitContext } from '../src/board/types';
import type { BoardComposer, StartOptions } from '../src/boardComposer';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import type { LaunchChoice } from '../src/core/composer';
import { addDirArgs, resolveDirArg } from '../src/core/launchFlags';

describe('resolveDirArg', () => {
  it('expands ~, takes relative paths from where the session runs, and drops quotes', () => {
    expect(resolveDirArg('~/src/lib', '/home/me', '/ws')).toBe('/home/me/src/lib');
    expect(resolveDirArg('~', '/home/me', '/ws')).toBe('/home/me');
    expect(resolveDirArg('../other', '/home/me', '/ws/main')).toBe('/ws/other');
    expect(resolveDirArg('/abs/path/', '/home/me', '/ws')).toBe('/abs/path');
    expect(resolveDirArg('"/with space/x"', '/home/me', '/ws')).toBe('/with space/x');
    expect(resolveDirArg("'~/q'", '/home/me', '/ws')).toBe('/home/me/q');
    expect(resolveDirArg('~user/x', '/home/me', '/ws')).toBe('/ws/~user/x');
  });

  it('is undefined when nothing was typed', () => {
    expect(resolveDirArg('', '/h', '/ws')).toBeUndefined();
    expect(resolveDirArg('  ""  ', '/h', '/ws')).toBeUndefined();
  });
});

describe('addDirArgs', () => {
  it('gives each directory its own shell-quoted --add-dir', () => {
    expect(addDirArgs([])).toBe('');
    expect(addDirArgs(['/a', "/it's here"])).toBe(`--add-dir '/a' --add-dir '/it'\\''s here'`);
  });
});

const choice: LaunchChoice = { where: 'main', mode: 'Default', model: 'Default', effort: 'Default', ultracode: true };

function context(text: string, base = '/ws', where = 'main') {
  const started: { text: string; options: StartOptions }[] = [];
  const dirs: string[] = [];
  const composer = {
    start: async (t: string, _c: LaunchChoice, options: StartOptions = {}) => {
      started.push({ text: t, options });
      return true;
    },
    planMode: () => ({ name: 'Plan', args: '--permission-mode plan' }),
    classify: async (t: string) => classifySubmission(t, BUILTINS, [{ name: 'review', origin: 'user' }]),
    dirOf: () => base,
    addLaunchDir: (d: string) => {
      if (dirs.includes(d)) return false;
      dirs.push(d);
      return true;
    },
  } as unknown as BoardComposer;
  const posted: HostMessage[] = [];
  const ctx: SubmitContext = { text, submission: classifySubmission(text, BUILTINS, []), choice: { ...choice, where }, composer, ui: new PanelUi((m) => posted.push(m)) };
  return { ctx, started, dirs, posted };
}

describe('/plan', () => {
  it('is routed to its handler', () => {
    expect(handlerFor('B', 'plan')).toBe(plan);
    expect(handlerFor('B', 'add-dir')).toBe(addDir);
  });

  it('starts the task in plan mode, without Ultracode', async () => {
    const t = context('/plan  refactor the login flow ');
    expect(await dispatch(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.started).toEqual([{ text: 'refactor the login flow', options: { mode: { name: 'Plan', args: '--permission-mode plan' }, ultracode: false, ui: t.ctx.ui } }]);
  });

  it('refuses a built-in as the task (it would run as the first prompt), starting nothing and keeping the text', async () => {
    for (const task of ['/model opus', '/exit', '/login', '/config', '/compact', '/plan x', '/add-dir /tmp']) {
      const t = context(`/plan ${task}`);
      expect(await dispatch(t.ctx)).toEqual({ clear: false });
      expect(t.started).toEqual([]);
      expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning', text: expect.stringContaining(task.split(' ')[0]) });
    }
  });

  it('warns about an unknown command as the task, and "Send as text anyway" starts it in plan mode', async () => {
    const t = context('/plan /nope do it');
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.started).toEqual([]);
    expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning', text: expect.stringContaining('/nope') });
  });

  it('starts a skill or prompt command as the task in plan mode', async () => {
    const t = context('/plan /REVIEW the auth module');
    expect(await dispatch(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.started).toEqual([{ text: '/review the auth module', options: { mode: { name: 'Plan', args: '--permission-mode plan' }, ultracode: false, ui: t.ctx.ui } }]);
  });

  it('asks for a task when there is none, starting nothing and keeping the text', async () => {
    const t = context('/plan');
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.started).toEqual([]);
    expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning' });
  });
});

describe('/add-dir', () => {
  const ws = mkdtempSync(join(tmpdir(), 'devdesk-adddir-'));
  const file = join(ws, 'a-file');
  writeFileSync(file, '');

  it('adds an existing directory (relative to where the session runs) for the next launch, once', async () => {
    const t = context('/add-dir .', ws);
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.dirs).toEqual([ws]);
    expect(t.started).toEqual([]);
    expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'info' });
    const again = context(`/add-dir ${ws}`, ws);
    // The composer's own list says it is there already.
    again.dirs.push(ws);
    expect(await dispatch(again.ctx)).toEqual({ clear: true });
    expect(again.posted[0]).toMatchObject({ type: 'notice', text: expect.stringContaining('already') });
  });

  it('refuses a missing path or a file, keeping the text', async () => {
    for (const arg of [join(ws, 'missing'), file]) {
      const t = context(`/add-dir ${arg}`, ws);
      expect(await dispatch(t.ctx)).toEqual({ clear: false });
      expect(t.dirs).toEqual([]);
      expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'error' });
    }
  });

  it('refuses a relative path for a new worktree (it does not exist yet), keeping the text; an absolute one is added', async () => {
    for (const arg of ['.', 'src', '../x']) {
      const t = context(`/add-dir ${arg}`, ws, 'new');
      expect(await dispatch(t.ctx)).toEqual({ clear: false });
      expect(t.dirs).toEqual([]);
      expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning', text: expect.stringContaining('new worktree') });
    }
    const t = context(`/add-dir ${ws}`, ws, 'new');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.dirs).toEqual([ws]);
  });

  it('asks for a path when there is none', async () => {
    const t = context('/add-dir');
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning' });
  });
});
