import { describe, expect, it } from 'vitest';
import type { HostMessage } from '../src/board/messages';
import { PanelUi } from '../src/board/panelUi';

function ui() {
  const posted: HostMessage[] = [];
  return { posted, ui: new PanelUi((m) => posted.push(m)) };
}

describe('PanelUi notices across webview reloads', () => {
  it('replays the shown notice, with actions that still run, to a new webview', async () => {
    const t = ui();
    let ran = 0;
    t.ui.notice({ text: 'Claude has not trusted the folder', tone: 'warning', actions: [{ label: 'Try again', run: async () => (ran++, { clear: true }) }] });
    const shown = t.posted.at(-1);
    t.posted.length = 0;
    t.ui.replay();
    expect(t.posted).toEqual([shown]);
    await t.ui.runAction((shown as { actions: { id: string }[] }).actions[0].id);
    expect(ran).toBe(1);
  });

  it('replays nothing once the notice is cleared or dismissed in the webview', () => {
    const t = ui();
    t.ui.notice({ text: 'Sent' });
    t.ui.clearNotice();
    t.posted.length = 0;
    t.ui.replay();
    expect(t.posted).toEqual([]);
    t.ui.notice({ text: 'Sent', actions: [{ label: 'Try again', run: async () => ({ clear: true }) }] });
    t.ui.dismissed();
    t.posted.length = 0;
    t.ui.replay();
    expect(t.posted).toEqual([]);
    expect(t.ui.actionIds).toEqual([]);
  });
});
