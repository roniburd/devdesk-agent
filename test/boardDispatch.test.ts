import { describe, expect, it } from 'vitest';
import { dispatch, handlerFor, notHandled } from '../src/board/dispatch';
import { interactiveOnly } from '../src/board/commands/interactiveOnly';
import { model } from '../src/board/commands/model';
import { sendToSession } from '../src/board/commands/sendToSession';
import { passThrough } from '../src/board/commands/passThrough';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { SubmitContext } from '../src/board/types';
import type { BoardComposer } from '../src/boardComposer';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import { type LaunchChoice, modelChoices } from '../src/core/composer';

const choice: LaunchChoice = { where: 'main', mode: 'Default', model: 'Default', effort: 'Default', ultracode: true };

/** A composer that records what it was asked to start and which models were added. */
function fakeComposer(setting: string[] = []) {
  const started: { text: string; ultracode?: boolean }[] = [];
  const custom: string[] = [];
  const composer = {
    start: async (text: string, _choice: LaunchChoice, options: { ultracode?: boolean } = {}) => {
      started.push({ text, ultracode: options.ultracode });
      return true;
    },
    modelRows: () =>
      modelChoices(
        setting,
        [
          { value: 'global.anthropic.claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 · Recommended', efforts: ['low'] },
          { value: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 at 200K context', efforts: ['low'] },
          { value: 'router', displayName: 'Auto model router', description: 'Bedrock model router', efforts: [] },
          { value: 'router[1m]', displayName: 'Auto model router (1M context)', description: 'Bedrock model router', efforts: [] },
        ],
        custom,
      ),
    addCustomModel: (v: string) => custom.push(v),
  };
  return { composer: composer as unknown as BoardComposer, started, custom };
}

function context(text: string, setting: string[] = []) {
  const { composer, started, custom } = fakeComposer(setting);
  const posted: HostMessage[] = [];
  const ui = new PanelUi((m) => posted.push(m));
  const ctx: SubmitContext = { text, submission: classifySubmission(text, BUILTINS, [{ name: 'deep-research' }]), choice, composer, ui };
  return { ctx, started, custom, posted, ui };
}

describe('handlerFor', () => {
  it("picks the command's handler, else its category's; prompts start a session", () => {
    expect(handlerFor('A', 'model')).toBe(model);
    expect(handlerFor('A', 'not-a-command')).toBe(notHandled);
    expect(handlerFor('A', 'toString')).toBe(notHandled);
    expect(handlerFor('F', 'deep-research')).toBe(passThrough);
    expect(handlerFor('text', undefined)).toBe(passThrough);
    expect(handlerFor('C', 'compact')).toBe(sendToSession);
    expect(handlerFor('D', 'theme')).toBe(interactiveOnly);
  });

  it('has a handler for every command in the catalog', () => {
    for (const b of BUILTINS) expect(handlerFor(b.category, b.name), `/${b.name}`).not.toBe(notHandled);
  });
});

describe('dispatch', () => {
  it('starts prompts with Ultracode as chosen; a command with no handler starts nothing', async () => {
    const t = context('fix it');
    expect(await dispatch(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.started).toEqual([{ text: 'fix it', ultracode: true }]);
    const c = context('/model x');
    expect(await notHandled({ ...c.ctx })).toEqual({ clear: false, error: 'The board does not run /model yet.' });
    expect(c.started).toEqual([]);
  });
});

describe('command spelling', () => {
  it('starts a command typed in another case with its own spelling', async () => {
    const t = context('/DEEP-Research fix it');
    expect(await dispatch(t.ctx)).toEqual({ clear: true, started: true });
    expect(t.started).toEqual([{ text: '/deep-research fix it', ultracode: true }]);
  });
});

describe('/model', () => {
  it('opens the model list without an argument, starting nothing', async () => {
    const t = context('/model');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.started).toEqual([]);
    expect(t.posted).toEqual([{ type: 'openPicker', picker: 'model' }]);
  });

  it('sets a listed model by value or name, and Default', async () => {
    const byName = context('/model opus');
    await dispatch(byName.ctx);
    expect(byName.posted[0]).toEqual({ type: 'setChoice', model: 'claude-opus-5-5' });
    expect(byName.posted[1]).toMatchObject({ type: 'notice', tone: 'info' });
    const reset = context('/model default');
    await dispatch(reset.ctx);
    expect(reset.posted[0]).toEqual({ type: 'setChoice', model: 'Default' });
    expect(reset.started).toEqual([]);
  });

  it('with devdesk.board.models listing no Default, /model default says so and changes nothing', async () => {
    const t = context('/model default', ['opus', 'claude-sonnet-4-6', 'my-model']);
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.custom).toEqual([]);
    expect(t.posted.some((m) => m.type === 'setChoice')).toBe(false);
    expect(t.posted[0]).toMatchObject({ type: 'notice', tone: 'warning' });
    // A custom model whose name starts with "default" is not what /model default means.
    const c = context('/model default-model', ['opus']);
    await dispatch(c.ctx);
    const again = { ...c.ctx, text: '/model default', submission: classifySubmission('/model default', BUILTINS, []) };
    c.posted.length = 0;
    await dispatch(again);
    expect(c.custom).toEqual(['default-model']);
    expect(c.posted.some((m) => m.type === 'setChoice')).toBe(false);
  });

  it("takes the name the pill shows for Default, and says which rows a name several start with could mean", async () => {
    const shown = context('/model Default model');
    expect(await dispatch(shown.ctx)).toEqual({ clear: true });
    expect(shown.custom).toEqual([]);
    expect(shown.posted[0]).toEqual({ type: 'setChoice', model: 'Default' });
    const auto = context('/model auto');
    expect(await dispatch(auto.ctx)).toEqual({ clear: false });
    expect(auto.custom).toEqual([]);
    expect(auto.posted.some((m) => m.type === 'setChoice')).toBe(false);
    expect(auto.posted[0]).toMatchObject({
      type: 'notice',
      tone: 'warning',
      text: 'auto could be Auto model router or Auto model router (1M context): type more of the name.',
    });
  });

  it('accepts a model it has no row for, with a warning, and offers it from then on', async () => {
    const t = context('/model my-gateway-model');
    expect(await dispatch(t.ctx)).toEqual({ clear: true });
    expect(t.custom).toEqual(['my-gateway-model']);
    expect(t.posted[0]).toEqual({ type: 'setChoice', model: 'my-gateway-model' });
    expect(t.posted[1]).toMatchObject({ type: 'notice', tone: 'warning' });
  });

  it("says what a row is, and where its 1M context is; picks the 1M row by name, with its exact value", async () => {
    const opus = context('/model opus');
    await dispatch(opus.ctx);
    expect(opus.posted[1]).toMatchObject({
      type: 'notice',
      text: 'Model for new sessions: Opus (claude-opus-5-5): Opus 5.5 at 200K context. Not saved in your Claude settings. For 1M context, pick Opus (1M context).',
    });
    const long = context('/model opus 1m');
    await dispatch(long.ctx);
    expect(long.posted[0]).toEqual({ type: 'setChoice', model: 'global.anthropic.claude-opus-5-5[1m]' });
    expect(long.custom).toEqual([]);
  });

  it('rejects a model id with whitespace in it (text after it, or a second line), keeping the text', async () => {
    for (const text of ['/model sonnet explain the bug', '/model\nmore text']) {
      const t = context(text);
      const out = await dispatch(t.ctx);
      expect(out.clear, text).toBe(false);
      expect(t.custom, text).toEqual([]);
      expect(t.posted.some((m) => m.type === 'setChoice'), text).toBe(false);
      expect(t.posted[0], text).toMatchObject({ type: 'notice', tone: 'warning' });
    }
  });

  it("takes Claude's aliases without a warning", async () => {
    const t = context('/model opusplan');
    await dispatch(t.ctx);
    expect(t.custom).toEqual(['opusplan']);
    expect(t.posted).toEqual([
      { type: 'setChoice', model: 'opusplan' },
      { type: 'notice', text: "Model for new sessions: Claude's opusplan alias (--model opusplan). Not saved in your Claude settings.", tone: 'info', actions: [] },
    ]);
  });

  it("takes Claude's aliases typed in another case, spelled as Claude knows them, without a warning", async () => {
    const t = context('/model OPUSPLAN');
    await dispatch(t.ctx);
    expect(t.custom).toEqual(['opusplan']);
    expect(t.posted).toEqual([
      { type: 'setChoice', model: 'opusplan' },
      { type: 'notice', text: "Model for new sessions: Claude's opusplan alias (--model opusplan). Not saved in your Claude settings.", tone: 'info', actions: [] },
    ]);
  });

  it("picks the CLI's 1M-context row for a [1m] alias, in any case, adding no row", async () => {
    for (const text of ['/model opus[1m]', '/model OPUS[1M]']) {
      const t = context(text);
      await dispatch(t.ctx);
      expect(t.custom, text).toEqual([]);
      expect(t.posted[0], text).toEqual({ type: 'setChoice', model: 'global.anthropic.claude-opus-5-5[1m]' });
    }
  });
});

describe('PanelUi', () => {
  it('runs a notice action once by its id, then empties the box', async () => {
    const posted: HostMessage[] = [];
    const ui = new PanelUi((m) => posted.push(m));
    let runs = 0;
    ui.notice({ text: 'Unknown command', tone: 'warning', actions: [{ label: 'Send as text anyway', run: () => (runs++, { clear: true }) }] });
    const [{ id }] = ui.actionIds;
    expect(posted[0]).toEqual({ type: 'notice', text: 'Unknown command', tone: 'warning', actions: [{ id, label: 'Send as text anyway' }] });
    await ui.runAction(id);
    await ui.runAction(id);
    expect(runs).toBe(1);
    expect(posted.slice(1)).toEqual([{ type: 'notice', text: '', tone: 'info', actions: [] }, { type: 'clearBox' }]);
    expect(ui.takeRecorded()).toHaveLength(3);
    expect(ui.takeRecorded()).toEqual([]);
  });

  it('shows what a failed action says', async () => {
    const posted: HostMessage[] = [];
    const ui = new PanelUi((m) => posted.push(m));
    ui.notice({ text: 'x', actions: [{ label: 'Go', run: () => Promise.reject(new Error('no session')) }] });
    await ui.runAction(ui.actionIds[0].id);
    expect(posted.at(-1)).toMatchObject({ type: 'notice', text: 'no session', tone: 'error' });
  });

  it('answers compose: empty the box, keep it, or show the error', () => {
    const posted: HostMessage[] = [];
    const ui = new PanelUi((m) => posted.push(m));
    ui.composed({ clear: true, started: true });
    ui.composed({ clear: false });
    ui.composed({ clear: false, error: 'nope' });
    expect(posted).toEqual([
      { type: 'composed', ok: true, started: true },
      { type: 'composed', ok: true, keep: true },
      { type: 'composed', ok: false, error: 'nope' },
    ]);
  });
});
