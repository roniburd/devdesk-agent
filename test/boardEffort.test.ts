import { describe, expect, it } from 'vitest';
import { effort } from '../src/board/commands/effort';
import { dispatch, handlerFor } from '../src/board/dispatch';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';
import type { SubmitContext } from '../src/board/types';
import type { BoardComposer } from '../src/boardComposer';
import { BUILTINS, classifySubmission } from '../src/core/builtins';
import { aliasChoices, type LaunchChoice, modelChoices } from '../src/core/composer';

const ROWS = modelChoices(
  [],
  [
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '200K context', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: '', efforts: ['low', 'medium', 'high', 'max'] },
    { value: 'arn:router', displayName: 'Router', description: 'Bedrock prompt router', efforts: [] },
  ],
);

function context(text: string, patch: Partial<LaunchChoice> = {}) {
  const started: string[] = [];
  const composer = {
    start: async (t: string) => started.push(t) > 0,
    modelRows: () => ROWS,
    allowedRows: () => [...ROWS, ...aliasChoices([], ROWS)],
  } as unknown as BoardComposer;
  const posted: HostMessage[] = [];
  const ui = new PanelUi((m) => posted.push(m));
  const choice: LaunchChoice = { where: 'main', mode: 'Default', model: 'claude-opus-5-5', effort: 'Default', ultracode: false, ...patch };
  const ctx: SubmitContext = { text, submission: classifySubmission(text, BUILTINS), choice, composer, ui };
  return { run: () => dispatch(ctx), started, posted };
}

const notices = (posted: HostMessage[]) => posted.filter((m): m is Extract<HostMessage, { type: 'notice' }> => m.type === 'notice');

describe('/effort', () => {
  it("is the board's own handler", () => {
    expect(handlerFor('A', 'effort')).toBe(effort);
  });

  it('opens the effort row without an argument; for a model without effort, says so and opens the model list', async () => {
    const t = context('/effort');
    expect(await t.run()).toEqual({ clear: true });
    expect(t.posted).toEqual([{ type: 'openPicker', picker: 'effort' }]);
    const router = context('/effort', { model: 'arn:router' });
    await router.run();
    expect(router.posted.at(-1)).toEqual({ type: 'openPicker', picker: 'model' });
    expect(notices(router.posted)[0].text).toMatch(/Router takes no effort/);
  });

  it('sets a level for the next session only, auto as Default, and starts nothing', async () => {
    const t = context('/effort high');
    expect(await t.run()).toEqual({ clear: true });
    expect(t.posted[0]).toEqual({ type: 'setChoice', effort: 'high' });
    expect(notices(t.posted)[0]).toMatchObject({ tone: 'info', text: expect.stringContaining('Not saved') });
    const auto = context('/effort auto', { effort: 'max' });
    await auto.run();
    expect(auto.posted[0]).toEqual({ type: 'setChoice', effort: 'Default' });
    expect([...t.started, ...auto.started]).toEqual([]);
  });

  it("sets a level for one of Claude's aliases chosen without a row, which offers every level as the pill does", async () => {
    const t = context('/effort high', { model: 'opus' });
    expect(await t.run()).toEqual({ clear: true });
    expect(t.posted[0]).toEqual({ type: 'setChoice', effort: 'high' });
  });

  it('keeps the text and says which levels the model offers for one it does not', async () => {
    const t = context('/effort xhigh', { model: 'claude-sonnet-4-6' });
    expect(await t.run()).toEqual({ clear: false });
    expect(t.posted.some((m) => m.type === 'setChoice')).toBe(false);
    expect(notices(t.posted)[0]).toMatchObject({ tone: 'warning', text: expect.stringMatching(/Sonnet 4\.6 does not offer xhigh.*low, medium, high, max/) });
  });

  it('flips, sets and reports Ultracode', async () => {
    const toggle = context('/effort ultracode', { ultracode: true });
    await toggle.run();
    expect(toggle.posted[0]).toEqual({ type: 'setChoice', ultracode: false });
    const on = context('/effort ultracode on', { ultracode: true });
    await on.run();
    expect(on.posted[0]).toEqual({ type: 'setChoice', ultracode: true });
    const status = context('/effort status', { effort: 'high', ultracode: true });
    expect(await status.run()).toEqual({ clear: true });
    expect(notices(status.posted)[0].text).toMatch(/high; Ultracode on\. Opus 5\.5 offers low, medium, high, xhigh, max/);
    expect([...toggle.started, ...on.started, ...status.started]).toEqual([]);
  });

  it('warns about anything else and keeps the text', async () => {
    const t = context('/effort turbo');
    expect(await t.run()).toEqual({ clear: false });
    expect(notices(t.posted)[0]).toMatchObject({ tone: 'warning', text: expect.stringContaining('turbo is not an effort level') });
  });
});
