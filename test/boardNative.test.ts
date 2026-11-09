import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/board/dispatch';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { SubmitContext } from '../src/board/types';
import type { BoardComposer } from '../src/boardComposer';
import { boardHelp, commandHelp } from '../src/core/boardHelp';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import type { LaunchChoice } from '../src/core/composer';
import type { SessionCard } from '../src/core/sessions';
import { matchSessions } from '../src/core/sessionSend';

const choice: LaunchChoice = { where: 'main', mode: 'Default', model: 'Default', effort: 'Default', ultracode: true };
const known = [{ name: 'deep-research', description: 'Research a topic in depth.' }];

const card = (id: string, extra: Partial<SessionCard> = {}): SessionCard => ({ id, state: 'idle', detail: '', attached: false, ...extra });
const login = card('a', { prompt: 'Fix the login timeout', featureName: 'main', tmuxSession: 'cc-main', cwd: '/ws' });
const docs = card('b', { name: 'Docs pass', prompt: 'Update the README', featureName: 'feat-docs', tmuxSession: 'cc-feat-docs', state: 'waiting' });
const other = card('c', { prompt: 'Refactor login tests', featureName: 'feat-a', sessionId: '1234-abcd', tmuxSession: 'cc-feat-a' });

/** A composer with these session cards that answers the pick with `pick` and records what it opened and started. */
function context(text: string, cards: SessionCard[] = [], pick: (cards: readonly SessionCard[]) => SessionCard | undefined = () => undefined) {
  const opened: string[] = [];
  const picked: { ids: string[]; title: string }[] = [];
  const started: string[] = [];
  const composer = {
    tree: { cards },
    classify: async (t: string) => classifySubmission(t, BUILTINS, known),
    commands: async () => known,
    sessions: {
      pick: async (options: { cards: readonly SessionCard[]; title: string }) => {
        picked.push({ ids: options.cards.map((c) => c.id), title: options.title });
        return pick(options.cards);
      },
      open: async (c: SessionCard) => void opened.push(c.id),
    },
    start: async (t: string) => (started.push(t), true),
  };
  const posted: HostMessage[] = [];
  const ui = new PanelUi((m) => posted.push(m));
  const ctx: SubmitContext = { text, submission: classifySubmission(text, BUILTINS, known), choice, composer: composer as unknown as BoardComposer, ui };
  const notices = () => posted.flatMap((m) => (m.type === 'notice' && m.text ? [m] : []));
  return { ctx, opened, picked, started, posted, notices };
}

describe('matchSessions', () => {
  const cards = [login, docs, other];
  it('keeps every card for no filter, in their order', () => {
    expect(matchSessions(cards, '  ')).toEqual(cards);
  });
  it('needs every word, in any case, in the title, prompt, worktree or ids', () => {
    expect(matchSessions(cards, 'LOGIN').map((c) => c.id)).toEqual(['a', 'c']);
    expect(matchSessions(cards, 'login feat-a').map((c) => c.id)).toEqual(['c']);
    expect(matchSessions(cards, 'docs pass').map((c) => c.id)).toEqual(['b']);
    expect(matchSessions(cards, '1234').map((c) => c.id)).toEqual(['c']);
    expect(matchSessions(cards, 'nothing')).toEqual([]);
  });
});

describe('boardHelp', () => {
  const text = boardHelp();
  it('lists each category with its visible commands, one line each', () => {
    const lines = text.split('\n');
    expect(lines.find((l) => l.startsWith('Board'))).toContain('/model /effort /clear /help /resume');
    expect(lines.find((l) => l.startsWith('New session options'))).toContain('/plan /add-dir');
    expect(lines.find((l) => l.startsWith('Sent to a running session'))).toContain('/compact');
    expect(lines.find((l) => l.startsWith('Panels'))).toContain('/permissions');
    expect(lines.find((l) => l.startsWith('Not from the board'))).toContain('/exit');
    expect(text).toMatch(/Anything else .* starts a new session with it as the first prompt\./);
  });
  it("explains what the board does with a blocked command instead of repeating the line's title", () => {
    expect(text).not.toMatch(/Not from the board \(not run from the board\)/);
    expect(text.split('\n').find((l) => l.startsWith('Not from the board'))).toMatch(
      /^Not from the board \(the board says why it can't run here and starts nothing\): /,
    );
  });
  it('leaves hidden commands out', () => {
    for (const hidden of ['/login', '/vim', '/workflow-launch-exec', '/heapdump']) expect(text.split(/\s/)).not.toContain(hidden);
  });
});

describe('commandHelp', () => {
  const help = (t: string, description?: string) => commandHelp(classifySubmission(t, BUILTINS, known), description);
  it('says what a built-in is, its aliases, and what the board does with it', () => {
    expect(help('/cost')).toBe(
      "/usage (also /cost, /stats): Show session cost, plan usage, and what's contributing to your limits. In the board: typed into a running session you pick, when its prompt is empty.",
    );
    expect(help('/resume')).toMatch(/^\/resume \[session\] \(also \/continue\): .* In the board: the board does it itself/);
  });
  it('gives the reason a blocked command is not run', () => {
    expect(help('/fast')).toMatch(/In the board: the board says why it can't run here and starts nothing\. Fast mode is only available/);
    expect(help('/login')).not.toMatch(/In the board: not run from the board\./);
  });
  it("uses the CLI's description for its own commands", () => {
    expect(help('/deep-research', 'Research a topic in depth.')).toBe(
      '/deep-research: Research a topic in depth. In the board: starts a new session with it as the first prompt.',
    );
  });
  it('says when a command is not known', () => {
    expect(help('/nope')).toBe('/nope is not a command Claude lists here.');
  });
  it("treats Claude Code's internal commands as not listed", () => {
    expect(help('/workflow-launch-exec')).toBe('/workflow-launch-exec is not a command Claude lists here.');
    expect(commandHelp(classifySubmission('/_internal', BUILTINS, [{ name: '_internal' }]), 'Internal.')).toBe(
      '/_internal is not a command Claude lists here.',
    );
  });
  it('names a path, punctuation or emoji with one slash', () => {
    expect(help('/usr/bin')).toBe('/usr/bin is not a command Claude lists here.');
    expect(help('/?')).toBe('/? is not a command Claude lists here.');
    expect(help('/🚀')).toBe('/🚀 is not a command Claude lists here.');
  });
});

describe('/clear, /new, /reset', () => {
  it('empties the box, and shows and starts nothing', async () => {
    for (const text of ['/clear', '/new', '/reset']) {
      const t = context(text);
      expect(await dispatch(t.ctx)).toEqual({ clear: true });
      expect(t.posted).toEqual([]);
      expect(t.started).toEqual([]);
    }
  });
  it('says the text after it was not sent, naming the command as typed', async () => {
    const t = context('/new Fix the bug');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.started).toEqual([]);
    expect(t.notices()).toHaveLength(1);
    expect(t.notices()[0]!.text).toContain('/new only empties the box');
    expect(t.notices()[0]!.text).toContain('“Fix the bug” was not sent');
  });
  it('started from a prompt for later card, keeps the text in the lane and promises no ⌥↑', async () => {
    const t = context('/clear keep this note');
    expect(await dispatch({ ...t.ctx, fromCard: true })).toEqual({ clear: false });
    expect(t.notices()[0]!.text).toContain('“keep this note” was not sent');
    expect(t.notices()[0]!.text).not.toContain('⌥↑');
    expect(await dispatch({ ...context('/clear').ctx, fromCard: true })).toEqual({ clear: true });
  });
});

describe('/help', () => {
  it("shows the board's command list in the box, and starts nothing", async () => {
    const t = context('/help');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.notices()).toEqual([{ type: 'notice', text: boardHelp(), tone: 'info', actions: [] }]);
    expect(t.started).toEqual([]);
  });
  it('/help <command> explains that command, with or without the slash', async () => {
    for (const text of ['/help compact', '/help /compact']) {
      const t = context(text);
      await dispatch(t.ctx);
      expect(t.notices()[0].text).toMatch(/^\/compact \[instructions\]: Free up context/);
    }
    const f = context('/help deep-research');
    await dispatch(f.ctx);
    expect(f.notices()[0].text).toBe('/deep-research: Research a topic in depth. In the board: starts a new session with it as the first prompt.');
    const u = context('/help nope');
    await dispatch(u.ctx);
    expect(u.notices()[0]).toMatchObject({ text: '/nope is not a command Claude lists here.', tone: 'warning' });
    const i = context('/help workflow-launch-exec');
    await dispatch(i.ctx);
    expect(i.notices()[0]).toMatchObject({ text: '/workflow-launch-exec is not a command Claude lists here.', tone: 'warning' });
  });
  it('/help on a path, punctuation or emoji warns with one slash, and strips every leading slash', async () => {
    for (const [text, shown] of [['/help /usr/bin', '/usr/bin'], ['/help ?', '/?'], ['/help 🚀', '/🚀']]) {
      const t = context(text);
      await dispatch(t.ctx);
      expect(t.notices()[0]).toMatchObject({ text: `${shown} is not a command Claude lists here.`, tone: 'warning' });
    }
    const m = context('/help //model');
    await dispatch(m.ctx);
    expect(m.notices()[0].text).toMatch(/^\/model /);
  });
});

describe('/resume, /continue', () => {
  it('offers every session in a quick pick and opens the chosen one', async () => {
    const t = context('/continue', [login, docs, other], (offered) => offered[1]);
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.picked).toEqual([{ ids: ['a', 'b', 'c'], title: 'Resume a Claude Session' }]);
    expect(t.opened).toEqual(['b']);
    expect(t.started).toEqual([]);
  });
  it('offers only the sessions that match its words, and opens a single match at once', async () => {
    const two = context('/resume login', [login, docs, other], (offered) => offered[0]);
    await dispatch(two.ctx);
    expect(two.picked.map((p) => p.ids)).toEqual([['a', 'c']]);
    expect(two.opened).toEqual(['a']);
    const one = context('/resume docs', [login, docs, other]);
    expect(await dispatch(one.ctx)).toEqual({ clear: true });
    expect(one.picked).toEqual([]);
    expect(one.opened).toEqual(['b']);
  });
  it('keeps the text when the pick is dismissed', async () => {
    const t = context('/resume', [login]);
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.opened).toEqual([]);
  });
  it('says so when no session matches, or there are none', async () => {
    const none = context('/resume zzz', [login]);
    expect(await dispatch(none.ctx)).toEqual({ clear: false });
    expect(none.notices()[0].text).toBe('No Claude session matches "zzz".');
    const empty = context('/resume', []);
    await dispatch(empty.ctx);
    expect(empty.notices()[0].text).toMatch(/^There are no Claude sessions to resume/);
    expect(empty.picked).toEqual([]);
  });
  it('offers only sessions it can open, and keeps the text when the matches all run outside tmux', async () => {
    const forked = card('f', { name: 'Forked work', cwd: '/ws/feat-a' });
    const t = context('/resume forked', [login, forked]);
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.opened).toEqual([]);
    expect(t.picked).toEqual([]);
    expect(t.notices()[0].tone).toBe('info');
    expect(t.notices()[0].text).toMatch(/runs? outside tmux/);
    const all = context('/resume', [login, forked, docs], (offered) => offered[0]);
    await dispatch(all.ctx);
    expect(all.picked.map((p) => p.ids)).toEqual([['a', 'b']]);
  });
});
