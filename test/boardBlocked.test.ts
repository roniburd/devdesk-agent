import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/board/dispatch';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { BoardUi, SubmitContext } from '../src/board/types';
import type { BoardComposer } from '../src/boardComposer';
import { BUILTINS, blockedNotice, classifySubmission, type SubmissionKind, unknownCommandNotice } from '../src/core/builtins';
import type { LaunchChoice } from '../src/core/composer';

const choice: LaunchChoice = { where: 'main', mode: 'Default', model: 'Default', effort: 'Default', ultracode: true };
const classify = (text: string) => classifySubmission(text, BUILTINS, [{ name: 'deep-research' }]);

/** A composer whose `submit` classifies (or takes `as`) and dispatches, recording what it starts. */
function context(text: string) {
  const started: { text: string; ultracode?: boolean }[] = [];
  const posted: HostMessage[] = [];
  const ui = new PanelUi((m) => posted.push(m));
  const composer = {
    start: async (t: string, _c: LaunchChoice, options: { ultracode?: boolean } = {}) => (started.push({ text: t, ultracode: options.ultracode }), true),
    submit: (t: string, c: LaunchChoice, u: BoardUi, options: { as?: SubmissionKind } = {}) => {
      const s = classify(t);
      return dispatch({ text: t, submission: options.as ? { ...s, kind: options.as } : s, choice: c, composer: composer as unknown as BoardComposer, ui: u });
    },
  } as unknown as BoardComposer;
  const ctx: SubmitContext = { text, submission: classify(text), choice, composer, ui };
  return { ctx, started, posted, ui };
}

describe('blocked commands (E)', () => {
  it('start nothing, keep the text, and say why for each one', async () => {
    for (const b of BUILTINS.filter((c) => c.category === 'E')) {
      const t = context(`/${b.name} now`);
      expect(await dispatch(t.ctx)).toEqual({ clear: false });
      expect(t.started).toEqual([]);
      expect(t.posted).toEqual([{ type: 'notice', text: blockedNotice(t.ctx.submission), tone: 'warning', actions: [] }]);
      expect(t.posted[0]).toMatchObject({ text: expect.stringContaining(b.reason!) });
    }
  });

  it('say which command an alias stands for, and why removed or Bedrock ones are not there', () => {
    expect(blockedNotice(classify('/quit'))).toMatch(/^\/quit \(\/exit\) does not run from the board\. End a session/);
    expect(blockedNotice(classify('/vim'))).toMatch(/removed \/vim/);
    expect(blockedNotice(classify('/fast on'))).toMatch(/Bedrock/);
    expect(blockedNotice(classify('/design'))).toMatch(/Bedrock/);
    expect(blockedNotice(classify('/LOGIN'))).toMatch(/^\/login does not run/);
  });
});

describe('unknown commands', () => {
  it('warn and start nothing, until "Send as text anyway" starts a session on the text as typed', async () => {
    const t = context('/frobnicate the cache');
    expect(t.ctx.submission.kind).toBe('unknown');
    expect(await dispatch(t.ctx)).toEqual({ clear: false });
    expect(t.started).toEqual([]);
    expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning', text: unknownCommandNotice(t.ctx.submission) });
    expect(t.ui.actionIds.map((a) => a.label)).toEqual(['Send as text anyway']);
    await t.ui.runAction(t.ui.actionIds[0].id);
    // As category F: a new session's prompt, with Ultracode as chosen.
    expect(t.started).toEqual([{ text: '/frobnicate the cache', ultracode: true }]);
    expect(t.posted.at(-1)).toEqual({ type: 'clearBox', started: true });
  });

  it('name the command as typed', () => {
    expect(unknownCommandNotice(classify('/foo'))).toMatch(/^\/foo is not a command/);
  });
});
