import { describe, expect, it } from 'vitest';
import { handlerFor } from '../src/board/dispatch';
import { interactiveOnly } from '../src/board/commands/interactiveOnly';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { BoardSessions } from '../src/board/boardSessions';
import { NEW_SESSION } from '../src/core/sessionSend';
import type { SubmitContext } from '../src/board/types';
import type { BoardComposer } from '../src/boardComposer';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import type { LaunchChoice } from '../src/core/composer';
import type { SessionCard } from '../src/core/sessions';

const choice: LaunchChoice = { where: 'main', mode: 'Default', model: 'Default', effort: 'Default', ultracode: true };
const running: SessionCard = { id: 'one', state: 'idle', detail: '', attached: false, tmuxSession: 'cc-main', name: 'Main work' };

type Pick = SessionCard | typeof NEW_SESSION | undefined;

/** A composer whose session pick answers `pick`, and that records what it started, typed and opened. */
function context(text: string, pick: Pick, options: { empty?: boolean; where?: string; card?: SessionCard } = {}) {
  const log = { picked: [] as Parameters<BoardSessions['pick']>[0][], started: [] as { text: string; options: unknown }[], typed: [] as string[], opened: [] as string[], startedWhere: [] as string[] };
  const sessions: Partial<BoardSessions> = {
    latest: (c) => c,
    pick: async (o) => {
      log.picked.push(o);
      o.onShow?.();
      return pick;
    },
    promptScreen: async () => ({ empty: options.empty ?? true, working: false }),
    typeInto: async (c, t) => void log.typed.push(`${c.id}: ${t}`),
    open: async (c) => void log.opened.push(c.id),
  };
  const composer = {
    sessions,
    dirOf: (where: string) => (where === 'main' ? '/ws' : where),
    info: () => ({ worktrees: [{ name: 'feat-a', dir: '/ws/worktrees/feat-a' }] }),
    start: async (t: string, c: LaunchChoice, o: unknown) => {
      log.started.push({ text: t, options: o });
      log.startedWhere.push(c.where);
      return true;
    },
  } as unknown as BoardComposer;
  const posted: HostMessage[] = [];
  const ui = new PanelUi((m) => posted.push(m));
  const ctx: SubmitContext = { text, submission: classifySubmission(text, BUILTINS), choice: { ...choice, where: options.where ?? 'main' }, composer, ui };
  return { ctx, log, posted };
}

describe('category D', () => {
  it('runs every D command, by name or alias, with interactiveOnly', () => {
    // /config has its own handler, which refuses model= and effortLevel= and otherwise runs interactiveOnly.
    for (const b of BUILTINS.filter((x) => x.category === 'D' && x.name !== 'config')) expect(handlerFor('D', b.name)).toBe(interactiveOnly);
    expect(classifySubmission('/settings').command).toBe('config');
  });

  it('asks which session, offering a new one where the box starts', async () => {
    const t = context('/permissions', undefined, { where: '/ws/worktrees/feat-a' });
    expect(await interactiveOnly(t.ctx)).toEqual({ clear: false });
    expect(t.log.picked[0]).toMatchObject({ title: 'Run /permissions', preferDir: '/ws/worktrees/feat-a', offerNew: 'in feat-a' });
    // While the list shows, the box says where to answer; then it takes that away.
    expect(t.posted.filter((m) => m.type === 'notice').map((m) => (m as { text: string }).text)).toEqual([
      'Pick the session that runs /permissions, in the list at the top of the window.',
      '',
    ]);
    const n = context('/hooks', undefined, { where: 'new' });
    await interactiveOnly(n.ctx);
    // A panel is no reason to make a worktree: with New worktree chosen, the new session starts in main.
    expect(n.log.picked[0].offerNew).toBe('in main');
    expect(t.log.started).toEqual([]);
  });

  it('names an alias as typed', async () => {
    const t = context('/settings', undefined);
    await interactiveOnly(t.ctx);
    expect(t.log.picked[0].title).toBe('Run /settings');
  });

  it('starts a new session on the command as typed, without Ultracode, and always opens it', async () => {
    const t = context('/config  theme=dark', NEW_SESSION);
    expect(await interactiveOnly(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.log.started).toEqual([{ text: '/config  theme=dark', options: { ultracode: false, open: true, ui: t.ctx.ui, turn: false } }]);
  });

  it('starts the new session in main, not in a new worktree named after the command', async () => {
    const t = context('/permissions', NEW_SESSION, { where: 'new' });
    expect(await interactiveOnly(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.log.startedWhere).toEqual(['main']);
  });

  it('types it into the running session picked and opens that session', async () => {
    const t = context('/memory', running);
    expect(await interactiveOnly(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.log.typed).toEqual(['one: /memory']);
    expect(t.log.opened).toEqual(['one']);
    expect(t.log.started).toEqual([]);
  });

  it('keeps the text, opens the session and says why when its prompt is not empty', async () => {
    const t = context('/skills', running, { empty: false });
    expect(await interactiveOnly(t.ctx)).toEqual({ clear: false });
    expect(t.log.typed).toEqual([]);
    expect(t.log.opened).toEqual(['one']);
    const notice = t.posted.filter((m) => m.type === 'notice').at(-1);
    expect(notice).toMatchObject({ tone: 'warning', text: expect.stringMatching(/"Main work" is not at an empty prompt.*send \/skills again/) });
  });

  it('does not open a session that ended between the pick and the send, and says so plainly', async () => {
    for (const message of ["can't find pane: %0", 'no server running on /tmp/tmux-501/devdesk']) {
      const t = context('/memory', running);
      t.ctx.composer.sessions.promptScreen = async () => {
        throw new Error(message);
      };
      expect(await interactiveOnly(t.ctx)).toEqual({ clear: false });
      expect(t.log.typed).toEqual([]);
      expect(t.log.opened).toEqual([]);
      const notice = t.posted.filter((m) => m.type === 'notice').at(-1);
      expect(notice).toMatchObject({ tone: 'warning', text: '"Main work" has ended: start a session to send /memory to.' });
    }
    const stopped = context('/memory', { ...running, state: 'stopped' });
    expect(await interactiveOnly(stopped.ctx)).toEqual({ clear: false });
    expect(stopped.log.opened).toEqual([]);
    // Claude exited: the pane runs a shell, under Claude's old prompt box.
    const shell = context('/memory', running);
    shell.ctx.composer.sessions.promptScreen = async () => ({ empty: true, working: false, exited: true });
    expect(await interactiveOnly(shell.ctx)).toEqual({ clear: false });
    expect(shell.log.typed).toEqual([]);
    expect(shell.log.opened).toEqual([]);
  });

  it('does not type into a session while Claude works', async () => {
    const t = context('/agents', { ...running, state: 'working' });
    expect(await interactiveOnly(t.ctx)).toEqual({ clear: false });
    expect(t.log.typed).toEqual([]);
    expect(t.log.opened).toEqual(['one']);
  });
});

describe('/config of the model or effort', () => {
  it('neither starts nor types it: the board never saves the model or effort to Claude settings', async () => {
    for (const text of ['/config model=sonnet', '/settings effortLevel=high', '/config theme=dark model=opus', '/CONFIG  Model = haiku', '/config effortlevel=max']) {
      for (const pick of [NEW_SESSION, running] as const) {
        const t = context(text, pick);
        const { kind, command } = t.ctx.submission;
        expect(await handlerFor(kind, command)(t.ctx)).toEqual({ clear: false });
        expect(t.log.started).toEqual([]);
        expect(t.log.typed).toEqual([]);
        expect(t.log.picked).toEqual([]);
        const notice = t.posted.filter((m) => m.type === 'notice').at(-1);
        expect(notice).toMatchObject({ tone: 'warning', text: expect.stringMatching(/would save .* Claude settings.*\/(model|effort)/) });
      }
    }
  });

  it('still runs other settings and the bare panel', async () => {
    for (const text of ['/config theme=dark', '/config', '/settings modelPicker=x']) {
      const t = context(text, NEW_SESSION);
      const { kind, command } = t.ctx.submission;
      expect(await handlerFor(kind, command)(t.ctx)).toEqual({ clear: true, started: true });
      expect(t.log.started).toHaveLength(1);
    }
  });
});
