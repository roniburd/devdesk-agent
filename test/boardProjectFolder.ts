// The extension's side of what the board's prompt box keeps for a project folder, for the webview tests: a
// `workspaceState` that outlives the webview (as it outlives the board's tab and a reload), read and changed through
// the real `BoardProjectState`, answering the webview's `ready` with `restore` and saving its `keep` messages.
import { parseBoardMessage } from '../src/board/messages';
import { BoardProjectState, KEPT_KEYS } from '../src/board/projectState';

/** A project folder's `workspaceState`; `saved` is what it kept (`model`, `effort`, `mode`, `ultracode`, `history`, `draft`, `filter`, `query`). */
export function projectFolder(saved: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void (value === undefined ? values.delete(key) : values.set(key, value)),
    keys: () => [...values.keys()],
  };
  const choice = Object.fromEntries(['mode', 'model', 'effort', 'ultracode'].filter((k) => saved[k] !== undefined).map((k) => [k, saved[k]]));
  if (Object.keys(choice).length) values.set(KEPT_KEYS.choice, choice);
  if (saved.history !== undefined) values.set(KEPT_KEYS.history, saved.history);
  if (saved.draft !== undefined) values.set(KEPT_KEYS.draft, saved.draft);
  if (saved.filter !== undefined || saved.query !== undefined) values.set(KEPT_KEYS.view, { filter: saved.filter, query: saved.query });
  const kept = new BoardProjectState(memento as never);
  return {
    kept,
    values,
    /** What it keeps now, in the shape `saved` takes (so it can start another webview). */
    flat(): Record<string, unknown> {
      const { choice: c, ...rest } = kept.restore();
      return { ...c, ...rest };
    },
    /** Answers what the webview posted, as `BoardPanel` does: `ready` gets `restore`, `keep` is saved. */
    answer(m: Record<string, unknown>, post: (m: Record<string, unknown>) => void): void {
      if (m.type === 'ready') post({ type: 'restore', ...kept.restore() });
      const parsed = parseBoardMessage(m);
      if (parsed?.type === 'keep') {
        const { type: _type, ...patch } = parsed;
        void kept.keep(patch);
      }
    },
  };
}
