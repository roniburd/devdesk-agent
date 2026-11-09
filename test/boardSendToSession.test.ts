import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/board/dispatch';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { BoardSessions } from '../src/board/boardSessions';
import type { SubmitContext } from '../src/board/types';
import type { BoardComposer } from '../src/boardComposer';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import { currentCard, runningSessions, sessionEnded } from '../src/core/sessionSend';
import type { LaunchChoice } from '../src/core/composer';
import type { SessionCard } from '../src/core/sessions';

const choice: LaunchChoice = { where: '/w/worktrees/feat', mode: 'Default', model: 'Default', effort: 'Default', ultracode: true };
const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({
  id,
  state: 'idle',
  detail: 'Ready',
  attached: false,
  tmuxSession: `cc-${id}`,
  tmuxPane: '%1',
  featureDir: '/w',
  name: `Session ${id}`,
  ...over,
});

/**
 * A composer whose sessions are `cards`; `pick` answers the quick pick (which, like the real one, lists the running
 * sessions as just refreshed and shows nothing when there is nothing to offer), `empty` says whether each prompt is
 * empty, `stale` that the last refresh predates `cards` (a session started a moment ago is not in it yet).
 */
function context(
  text: string,
  options: { cards?: SessionCard[]; pick?: (cards: SessionCard[]) => SessionCard | undefined; empty?: boolean; now?: SessionCard[]; stale?: boolean } = {},
) {
  const cards = options.cards ?? [card('a')];
  const typed: { id: string; text: string }[] = [];
  const opened: string[] = [];
  const picks: { title: string; preferDir?: string }[] = [];
  const started: string[] = [];
  const cleared: string[] = [];
  let empty = options.empty ?? true;
  let refreshed = !options.stale;
  // What the real `running` and `pick` offer: no stopped, parked or ended rows.
  const live = () => runningSessions(cards);
  const sessions: Partial<BoardSessions> = {
    running: () => (refreshed ? live() : []),
    latest: (c) => (options.now ? currentCard(options.now, c) : c),
    pick: async (o) => {
      refreshed = true;
      const offered = o.cards ? [...o.cards] : live();
      if (!offered.length && o.offerNew === undefined) return undefined;
      picks.push(o);
      return (options.pick ?? ((cs) => cs[0]))(offered);
    },
    promptScreen: async () => ({ empty, working: false }),
    typeInto: async (c, t) => void typed.push({ id: c.id, text: t }),
    ended: async (c) => sessionEnded(live(), c),
    open: async (c) => void opened.push(c.id),
  };
  const composer = {
    sessions,
    dirOf: (where: string) => where,
    start: async (t: string) => (started.push(t), true),
    clearCommands: () => void cleared.push(text),
  } as unknown as BoardComposer;
  const posted: HostMessage[] = [];
  const ui = new PanelUi((m) => posted.push(m));
  const ctx: SubmitContext = { text, submission: classifySubmission(text, BUILTINS), choice, composer, ui };
  return { ctx, ui, typed, opened, picks, started, cleared, posted, setEmpty: (e: boolean) => (empty = e) };
}

const notices = (posted: HostMessage[]) => posted.filter((m) => m.type === 'notice' && m.text);

describe('category C: sent to a running session', () => {
  it('checks the session as it is now when a hook gave it its session id after the pick (and it is working)', async () => {
    const picked = card('tmux:s:%1', { state: 'unknown', tmuxServer: 's', tmuxPane: '%1' });
    const now = [card('sid-1', { state: 'working', tmuxServer: 's', tmuxPane: '%1', tmuxSession: picked.tmuxSession })];
    const t = context('/compact', { cards: [picked], now });
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.typed).toEqual([]);
    expect(notices(t.posted).at(-1)).toMatchObject({ tone: 'warning', text: expect.stringContaining('is working') });
  });

  it('cuts a long command short in the pick title and the Sent notice, but types all of it', async () => {
    const text = `/btw ${'x'.repeat(1200)}`;
    const t = context(text);
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.picks[0].title.length).toBeLessThan(200);
    expect(t.picks[0].title).toMatch(/^Send \/btw x+… to$/);
    const sent = notices(t.posted).at(-1) as { text: string };
    expect(sent.text.length).toBeLessThan(300);
    expect(sent.text).toMatch(/^Sent \/btw x+… to "Session a"\.$/);
    expect(t.typed).toEqual([{ id: 'a', text }]);
  });

  it("types a command (an alias too) typed in another case with the catalog's spelling", async () => {
    const t = context('/COST');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.picks).toMatchObject([{ title: 'Send /cost to' }]);
    expect(t.typed).toEqual([{ id: 'a', text: '/cost' }]);
    const c = context('/Compact keep the test plan');
    await dispatch(c.ctx);
    expect(c.typed).toEqual([{ id: 'a', text: '/compact keep the test plan' }]);
  });

  it('types the command as written (an alias too) into the picked session, then offers to open it', async () => {
    const t = context('/cost');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.picks).toMatchObject([{ title: 'Send /cost to', preferDir: '/w/worktrees/feat' }]);
    expect(t.typed).toEqual([{ id: 'a', text: '/cost' }]);
    expect(t.started).toEqual([]);
    expect(notices(t.posted)).toEqual([{ type: 'notice', text: 'Sent /cost to "Session a".', tone: 'info', actions: [{ id: expect.any(String), label: 'Open session' }] }]);
    await t.ui.runAction(t.ui.actionIds[0].id);
    expect(t.opened).toEqual(['a']);
  });

  it('says the session has ended when Open session finds it gone, and opens nothing', async () => {
    const cards = [card('a')];
    const t = context('/context', { cards });
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    cards.length = 0;
    await t.ui.runAction(t.ui.actionIds[0].id);
    expect(t.opened).toEqual([]);
    expect(notices(t.posted).at(-1)).toEqual({ type: 'notice', text: '"Session a" has ended.', tone: 'warning', actions: [] });
  });

  it('tells a session that ended from one still running (stopped, gone, or out of tmux)', () => {
    const a = card('a');
    expect(sessionEnded([a], a)).toBe(false);
    expect(sessionEnded([card('sid', { tmuxPane: a.tmuxPane })], a)).toBe(false);
    expect(sessionEnded([], a)).toBe(true);
    expect(sessionEnded([card('a', { state: 'stopped' })], a)).toBe(true);
    expect(sessionEnded([card('a', { state: 'parked', endReason: 'parked' })], a)).toBe(true);
    expect(sessionEnded([card('a', { tmuxSession: undefined })], a)).toBe(true);
  });

  it('keeps arguments', async () => {
    const t = context('/compact keep the test plan', { cards: [card('a'), card('b')], pick: (cs) => cs[1] });
    await dispatch(t.ctx);
    expect(t.typed).toEqual([{ id: 'b', text: '/compact keep the test plan' }]);
    expect(t.cleared).toEqual([]);
  });

  it("asks the CLI for the / menu again after /reload-skills or /reload-plugins", async () => {
    const t = context('/reload-skills');
    await dispatch(t.ctx);
    expect(t.typed).toEqual([{ id: 'a', text: '/reload-skills' }]);
    expect(t.cleared).toEqual(['/reload-skills']);
  });

  it('keeps the text when the pick is dismissed', async () => {
    const t = context('/context', { pick: () => undefined });
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.typed).toEqual([]);
    expect(notices(t.posted)).toEqual([]);
  });

  it('lists a session started a moment ago, though the last refresh predates it', async () => {
    const t = context('/context', { cards: [card('a')], stale: true });
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.typed).toEqual([{ id: 'a', text: '/context' }]);
  });

  it('says when no session is running, without asking', async () => {
    const t = context('/compact', { cards: [card('x', { state: 'stopped' })] });
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.picks).toEqual([]);
    expect(notices(t.posted)[0]).toMatchObject({ tone: 'warning', text: 'No Claude session is running to send /compact to: start one first.' });
  });

  it('asks for a required argument', async () => {
    const t = context('/btw');
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.picks).toEqual([]);
    expect(notices(t.posted)[0]).toMatchObject({ tone: 'warning', text: 'Type <question> after /btw.' });
  });

  it('does not type over text in the prompt or a dialog; Try again sends it once the prompt is empty', async () => {
    const t = context('/rename auth-fix', { empty: false });
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.typed).toEqual([]);
    const [warning] = notices(t.posted);
    expect(warning).toMatchObject({ tone: 'warning', text: expect.stringMatching(/"Session a" is not at an empty prompt/) });
    expect(t.ui.actionIds.map((a) => a.label)).toEqual(['Open session', 'Try again']);
    t.setEmpty(true);
    t.posted.length = 0;
    await t.ui.runAction(t.ui.actionIds[1].id);
    expect(t.typed).toEqual([{ id: 'a', text: '/rename auth-fix' }]);
    expect(t.posted.at(-1)).toEqual({ type: 'clearBox' });
  });

  it('waits for a working session, but /btw goes to it', async () => {
    const working = [card('a', { state: 'working' })];
    const t = context('/compact', { cards: working });
    await dispatch(t.ctx);
    expect(t.typed).toEqual([]);
    expect(notices(t.posted)[0]).toMatchObject({ text: '"Session a" is working: send /compact when it is done.' });
    const btw = context('/btw why is it slow?', { cards: working });
    expect(await dispatch(btw.ctx)).toEqual({ clear: true });
    expect(btw.typed).toEqual([{ id: 'a', text: '/btw why is it slow?' }]);
  });

  it('names the command as typed (an alias) when the session is working or its prompt is not empty', async () => {
    const t = context('/name new title', { cards: [card('a', { state: 'working' })] });
    await dispatch(t.ctx);
    expect(t.typed).toEqual([]);
    expect(notices(t.posted).at(-1)).toMatchObject({ text: '"Session a" is working: send /name when it is done.' });
    const busy = context('/name new title', { empty: false });
    await dispatch(busy.ctx);
    expect(notices(busy.posted).at(-1)).toMatchObject({ text: expect.stringContaining('then send /name again.') });
  });

  it('shows why typing failed', async () => {
    const t = context('/diff');
    t.ctx.composer.sessions.typeInto = async () => {
      throw new Error('permission denied');
    };
    expect(await dispatch(t.ctx)).toEqual({ clear: false, error: 'Cannot type into "Session a": permission denied' });
  });

  it('says the session has ended (not the tmux error) when it ended between the pick and the send', async () => {
    for (const message of ["can't find pane: %1", 'no server running on /tmp/tmux-501/devdesk', 'error connecting to /tmp/tmux-501/devdesk (No such file or directory)']) {
      const t = context('/usage');
      t.ctx.composer.sessions.promptScreen = async () => {
        throw new Error(message);
      };
      expect(await dispatch(t.ctx)).toEqual({ clear: false });
      expect(t.typed).toEqual([]);
      expect(notices(t.posted).at(-1)).toMatchObject({ tone: 'warning', text: '"Session a" has ended: start a session to send /usage to.', actions: [] });
    }
    const typing = context('/usage');
    typing.ctx.composer.sessions.typeInto = async () => {
      throw new Error("can't find pane: %1");
    };
    expect(await dispatch(typing.ctx)).toEqual({ clear: false });
    expect(notices(typing.posted).at(-1)).toMatchObject({ text: expect.stringContaining('has ended') });
    // The refresh after the pick already saw it stop.
    const stopped = context('/usage', { now: [card('a', { state: 'stopped' })] });
    expect(await dispatch(stopped.ctx)).toEqual({ clear: false });
    expect(stopped.typed).toEqual([]);
    expect(notices(stopped.posted).at(-1)).toMatchObject({ text: expect.stringContaining('has ended') });
    // Parked meanwhile (devdesk.sessions.parkAfterDays): its row stays, still naming the tmux session, but nothing is typed or resumed.
    const parked = context('/usage', { now: [card('a', { state: 'parked', endReason: 'parked' })] });
    expect(await dispatch(parked.ctx)).toEqual({ clear: false });
    expect(parked.typed).toEqual([]);
    expect(notices(parked.posted).at(-1)).toMatchObject({ text: expect.stringContaining('has ended') });
  });

  it('offers no parked or ended row, though it keeps its tmux session: says no session is running', async () => {
    const t = context('/compact', { cards: [card('p', { state: 'parked', endReason: 'parked' }), card('e', { state: 'parked', endReason: 'exited' })] });
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.picks).toEqual([]);
    expect(t.typed).toEqual([]);
    expect(notices(t.posted)[0]).toMatchObject({ tone: 'warning', text: 'No Claude session is running to send /compact to: start one first.' });
  });

  it('types nothing when the pane runs a shell (Claude exited there, its old prompt box still showing above the shell prompt)', async () => {
    const t = context('/btw does $(touch /tmp/marker) run');
    t.ctx.composer.sessions.promptScreen = async () => ({ empty: true, working: false, exited: true });
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.typed).toEqual([]);
    expect(notices(t.posted).at(-1)).toMatchObject({ tone: 'warning', text: expect.stringContaining('has ended') });
  });
});
