import type * as vscode from 'vscode';
import { type KeepPatch, type KeptState, parseHistory, parseKeptChoice, parseView, rememberPrompt } from '../core/boardKept';
import { MementoValue } from '../state/mementoState';

/** `workspaceState` keys of what the board's prompt box keeps for this project folder. */
export const KEPT_KEYS = {
  choice: 'devdesk.board.choice',
  draft: 'devdesk.board.draft',
  /** The New Session view's box keeps a draft of its own (the rest it shares with the board's). */
  sideDraft: 'devdesk.board.sideDraft',
  history: 'devdesk.board.promptHistory',
  view: 'devdesk.board.view',
} as const;

/**
 * What the Claude Board's prompt box keeps for this project folder, in `workspaceState` (this folder on this host):
 * the choices picked in the pills (an override of the defaults that stays until changed), the draft, the earlier
 * prompts (⌥↑), and the lanes' filter and search. The webview gets them when it loads (`restore`) and sends each change
 * (`keep`), so they outlast the board's tab, a reload and the webview. Each change is applied to what is saved now.
 */
export class BoardProjectState {
  private readonly choice: MementoValue<ReturnType<typeof parseKeptChoice>>;
  private readonly draft: MementoValue<string | undefined>;
  private readonly sideDraft: MementoValue<string | undefined>;
  private readonly history: MementoValue<string[]>;
  private readonly view: MementoValue<ReturnType<typeof parseView>>;

  constructor(memento: vscode.Memento) {
    this.choice = new MementoValue(memento, KEPT_KEYS.choice, parseKeptChoice);
    const parseDraft = (raw: unknown) => (typeof raw === 'string' ? raw : undefined);
    this.draft = new MementoValue(memento, KEPT_KEYS.draft, parseDraft);
    this.sideDraft = new MementoValue(memento, KEPT_KEYS.sideDraft, parseDraft);
    this.history = new MementoValue(memento, KEPT_KEYS.history, parseHistory);
    this.view = new MementoValue(memento, KEPT_KEYS.view, parseView);
  }

  /**
   * What a webview that loaded starts with: only what is saved (a field not there: the webview may bring its own).
   * `side`: the New Session view's box, with its own draft.
   */
  restore(side = false): KeptState {
    const draft = side ? this.sideDraft : this.draft;
    return {
      ...(this.choice.saved ? { choice: this.choice.get() } : {}),
      ...(draft.saved ? { draft: draft.get() ?? '' } : {}),
      ...(this.history.saved ? { history: this.history.get() } : {}),
      ...(this.view.saved ? this.view.get() : {}),
    };
  }

  /** Forgets all of it: the defaults again (for tests). */
  async forget(): Promise<void> {
    await Promise.all([this.choice, this.draft, this.sideDraft, this.history, this.view].map((v) => v.set(undefined as never)));
  }

  /** Saves a webview's change (`side`: from the New Session view's box). */
  async keep(patch: KeepPatch, side = false): Promise<void> {
    const writes: Thenable<void>[] = [];
    const draft = side ? this.sideDraft : this.draft;
    if (patch.choice) writes.push(this.choice.update((c) => ({ ...c, ...patch.choice })));
    if (patch.draft !== undefined && patch.draft !== draft.get()) writes.push(draft.set(patch.draft));
    if (patch.remember !== undefined) writes.push(this.history.update((h) => rememberPrompt(h, patch.remember!)));
    if (patch.filter !== undefined || patch.query !== undefined) {
      const { filter, query } = patch;
      writes.push(this.view.update((v) => ({ ...v, ...(filter !== undefined ? { filter } : {}), ...(query !== undefined ? { query } : {}) })));
    }
    await Promise.all(writes);
  }
}
