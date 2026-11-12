import * as vscode from 'vscode';

/** A quick pick item button, told apart by its id. */
export interface PickButton extends vscode.QuickInputButton {
  id: string;
}

export interface Picked<T> {
  item: T;
  /** The id of the item's button that was clicked, when one was (instead of the item being accepted). */
  button?: string;
}

/** The quick pick `pickOne` shows now, for the e2e tests: its items, and a way to answer it as a click would. */
export interface ShownPick {
  title: string;
  labels: string[];
  /** Accepts the item labelled `label`, or clicks its button `button`; false when there is no such item. */
  choose(label: string, button?: string): boolean;
}

let shown: ShownPick | undefined;

/** The quick pick `pickOne` shows now, if any (the e2e tests wait on it instead of on time). */
export const shownPick = (): ShownPick | undefined => shown;

/**
 * Shows a quick pick of `items` and resolves with the item accepted, or the item whose button was clicked (with the
 * button's id); undefined when dismissed. Like `showQuickPick`, with item buttons.
 */
export function pickOne<T extends vscode.QuickPickItem & { buttons?: readonly PickButton[] }>(
  items: readonly T[],
  options: { title: string; placeHolder: string; matchOnDescription?: boolean; matchOnDetail?: boolean; active?: T },
): Promise<Picked<T> | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.title = options.title;
    qp.placeholder = options.placeHolder;
    qp.matchOnDescription = options.matchOnDescription ?? false;
    qp.matchOnDetail = options.matchOnDetail ?? false;
    qp.items = items;
    if (options.active) qp.activeItems = [options.active];
    let done = false;
    const finish = (picked: Picked<T> | undefined) => {
      if (done) return;
      done = true;
      if (shown === me) shown = undefined;
      resolve(picked);
      qp.hide();
      qp.dispose();
    };
    const me: ShownPick = {
      title: options.title,
      labels: items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator).map((i) => i.label),
      choose: (label, button) => {
        const item = items.find((i) => i.label === label && i.kind !== vscode.QuickPickItemKind.Separator);
        if (!item || (button && !item.buttons?.some((b) => (b as PickButton).id === button))) return false;
        finish({ item, button });
        return true;
      },
    };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] ?? qp.activeItems[0];
      if (item) finish({ item });
    });
    qp.onDidTriggerItemButton((e) => finish({ item: e.item, button: (e.button as PickButton).id }));
    qp.onDidHide(() => finish(undefined));
    shown = me;
    qp.show();
  });
}
