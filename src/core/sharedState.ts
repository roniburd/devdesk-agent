/*
 * State that both DevDesk for Claude Code versions (v1 and v2, see `edition.ts`) keep, in a file of the storage folder they share.
 * VS Code keeps each extension's `globalState` and `workspaceState` apart, so what one version saved there (which
 * sessions are read, the board's draft, the terminals to reattach) would be lost on switching to the other. The file
 * holds those Memento keys instead (`SHARED_GLOBAL_KEYS`, `SHARED_PROJECT_KEYS`), and each version copies what it saved
 * in its own Memento into it once (`importValues`).
 *
 * The same code is on `main` (v1) and `v2_experiment` (v2): keep the two copies the same.
 */

/** The file in the shared storage folders (`globalStorageUri` for this host, `storageUri` for this project folder). */
export const SHARED_STATE_FILE = 'shared-state.json';

/** The file's content: Memento values by key, and the extensions whose own Memento was copied in already. */
export interface SharedState {
  imported: string[];
  values: Record<string, unknown>;
}

/**
 * `globalState` keys kept in the host's shared file: what the user has read of each session and the colors given to
 * them, per host (`hostKey`), and the read state saved for every host together by versions before that.
 */
export function isSharedGlobalKey(key: string): boolean {
  return /^devdesk\.sessions\.(seen|colors)(@|$)/.test(key);
}

/** `workspaceState` keys kept in the project folder's shared file. */
export const SHARED_PROJECT_KEYS: ReadonlySet<string> = new Set([
  // The Claude terminals to reattach (`state/reattachTerminals.ts`), and the list versions up to 0.5.55 kept.
  'devdesk.claudeTerminalEntries',
  'devdesk.claudeTerminals',
  // What the board's prompt box keeps (`board/projectState.ts`).
  'devdesk.board.choice',
  'devdesk.board.draft',
  'devdesk.board.promptHistory',
  'devdesk.board.view',
  // The project whose usage this window shows (`usageScopeState.ts`).
  'devdesk.usage.scope',
]);

export const isSharedProjectKey = (key: string): boolean => SHARED_PROJECT_KEYS.has(key);

export const emptySharedState = (): SharedState => ({ imported: [], values: {} });

/** Parses the file; throws when it is not a shared state object (a damaged file is left as it is). */
export function parseSharedState(text: string): SharedState {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not a JSON object');
  const { imported, values } = raw as Partial<SharedState>;
  return {
    imported: Array.isArray(imported) ? imported.filter((id): id is string => typeof id === 'string') : [],
    values: typeof values === 'object' && values !== null && !Array.isArray(values) ? { ...values } : {},
  };
}

export function serializeSharedState(state: SharedState): string {
  return `${JSON.stringify(state)}\n`;
}

const isEntries = (v: unknown): v is [string, unknown][] => Array.isArray(v) && v.every((e) => Array.isArray(e) && typeof e[0] === 'string');

/**
 * `state` with `from`'s values copied in, once per extension (`id`): a key the file lacks takes the value, a list of
 * `[id, value]` entries (read state, colors, terminals) gets the entries it lacks after its own, and any other value in
 * the file stays. Returns `state` itself when `id` was copied in already.
 */
export function importValues(state: SharedState, id: string, from: Iterable<readonly [string, unknown]>): SharedState {
  if (state.imported.includes(id)) return state;
  const values = { ...state.values };
  for (const [key, value] of from) {
    if (value === undefined) continue;
    const saved = values[key];
    if (saved === undefined) values[key] = value;
    else if (isEntries(saved) && isEntries(value)) {
      const ids = new Set(saved.map(([entry]) => entry));
      values[key] = [...saved, ...value.filter(([entry]) => !ids.has(entry))];
    }
  }
  return { imported: [...state.imported, id], values };
}

/** `state` with `key` set to `value`, or removed (undefined). */
export function withValue(state: SharedState, key: string, value: unknown): SharedState {
  const values = { ...state.values };
  if (value === undefined) delete values[key];
  else values[key] = value;
  return { ...state, values };
}
