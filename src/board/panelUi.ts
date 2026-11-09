import { randomBytes } from 'node:crypto';
import type { HostMessage } from './messages';
import type { BoardUi, ChoicePatch, Notice, NoticeAction, SubmitOutcome } from './types';

/** How many posted messages `PanelUi` keeps for tests. */
const RECORDED = 100;

/**
 * `BoardUi` over a webview: posts each change as a `HostMessage`, and keeps the shown notice's actions until one is
 * clicked (`runAction`) or another notice replaces them. Remembers the last messages posted, for the e2e tests.
 */
export class PanelUi implements BoardUi {
  private actions = new Map<string, NoticeAction>();
  private recorded: HostMessage[] = [];
  /** The notice the box shows, for a new webview (the board's is gone while its tab is hidden). */
  private shown: HostMessage | undefined;

  constructor(private readonly post: (m: HostMessage) => void) {}

  notice(notice: Notice): void {
    this.actions.clear();
    const actions = (notice.actions ?? []).map((a) => {
      const id = randomBytes(8).toString('hex');
      this.actions.set(id, a);
      return { id, label: a.label };
    });
    this.shown = { type: 'notice', text: notice.text, tone: notice.tone ?? 'info', actions };
    this.send(this.shown);
  }

  clearNotice(): void {
    this.dismissed();
    this.send({ type: 'notice', text: '', tone: 'info', actions: [] });
  }

  /** The webview removed the notice itself (typing in the box): forgets it and its actions. */
  dismissed(): void {
    this.actions.clear();
    this.shown = undefined;
  }

  /** Shows the notice again in a new webview (the board shown again, or reloaded). */
  replay(): void {
    if (this.shown) this.send(this.shown);
  }

  setChoice(patch: ChoicePatch): void {
    this.send({ type: 'setChoice', ...patch });
  }

  openPicker(picker: 'model' | 'effort'): void {
    this.send({ type: 'openPicker', picker });
  }

  clearBox(started?: boolean): void {
    this.send({ type: 'clearBox', ...(started ? { started: true } : {}) });
  }

  /** Answers a `compose` with what its handler did. */
  composed(outcome: SubmitOutcome): void {
    this.send({ type: 'composed', ok: !outcome.error, ...(outcome.error ? { error: outcome.error } : !outcome.clear ? { keep: true } : outcome.started ? { started: true } : {}) });
  }

  /** Runs the clicked notice action (once; a stale id does nothing), then empties the box or shows its error. */
  async runAction(id: string): Promise<void> {
    const action = this.actions.get(id);
    if (!action) return;
    this.clearNotice();
    let outcome: SubmitOutcome | void;
    try {
      outcome = await action.run();
    } catch (err) {
      outcome = { clear: false, error: (err as Error).message };
    }
    if (outcome?.error) this.notice({ text: outcome.error, tone: 'error' });
    else if (outcome?.clear) this.clearBox(outcome.started);
  }

  /** The labels of the shown notice's actions, by id (for tests). */
  get actionIds(): { id: string; label: string }[] {
    return [...this.actions].map(([id, a]) => ({ id, label: a.label }));
  }

  /** The messages posted since the last call (for tests). */
  takeRecorded(): HostMessage[] {
    const out = this.recorded;
    this.recorded = [];
    return out;
  }

  private send(m: HostMessage): void {
    this.recorded = [...this.recorded, m].slice(-RECORDED);
    this.post(m);
  }
}
