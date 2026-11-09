import { hostname } from 'node:os';
import type * as vscode from 'vscode';
import { applyEntries } from '../core/entries';

/*
 * Where state lives (pick by what it belongs to, see DEVELOPING.md "Where state lives"):
 * - `context.globalState`: every window of this VS Code, local and remote alike (it is kept on the laptop). For the
 *   user's own choices that mean the same on every host. Key it with `hostKey` when it is about this host's things
 *   (sessions, tmux servers, paths).
 * - `context.workspaceState`: this project folder on this host. For anything that belongs to the project.
 * - A `JsonFileStore` in `globalStorageUri` (this host) or `storageUri` (this project folder on this host): for state
 *   too big for a Memento, or shared with other processes.
 * Never keep a copy of shared state in a field and write it back whole: other windows change it too. Read it through
 * `MementoValue`/`MementoEntries`, which read it afresh (VS Code keeps `globalState` current when another window writes).
 */

/** `<key>@<this host>`: a `globalState` key for state about this host's sessions, worktrees or paths. */
export function hostKey(key: string, host = hostname()): string {
  return `${key}@${host}`;
}

/** One value in a Memento, read afresh each time and validated by `parse` (which gets undefined when nothing is saved). */
export class MementoValue<T> {
  private parsed: { from: unknown; value: T } | undefined;

  constructor(
    private readonly memento: vscode.Memento,
    readonly key: string,
    private readonly parse: (raw: unknown) => T,
  ) {}

  /** Whether anything is saved under the key. */
  get saved(): boolean {
    return this.memento.get(this.key) !== undefined;
  }

  /** The saved value, parsed (again only when it changed: a Memento returns the same object until it is updated). */
  get(): T {
    const raw = this.memento.get<unknown>(this.key);
    if (!this.parsed || this.parsed.from !== raw) this.parsed = { from: raw, value: this.parse(raw) };
    return this.parsed.value;
  }

  /** Saves `change` applied to the value saved now (by this window or another). */
  update(change: (value: T) => T): Thenable<void> {
    return this.memento.update(this.key, change(this.get()));
  }

  set(value: T): Thenable<void> {
    return this.memento.update(this.key, value);
  }
}

/**
 * A map saved as `[id, value][]` in a Memento that several windows change: `apply` saves only the entries this window
 * changed, on top of what is saved now, so another window's entries are never lost. Optional `limit` caps the entries.
 */
export class MementoEntries<V> {
  private readonly raw: MementoValue<[string, V][]>;
  private map: { from: readonly [string, V][]; map: ReadonlyMap<string, V> } | undefined;

  constructor(
    memento: vscode.Memento,
    key: string,
    isValue: (v: unknown) => v is V,
    private readonly limit = Number.POSITIVE_INFINITY,
  ) {
    this.raw = new MementoValue(memento, key, (raw) =>
      Array.isArray(raw) ? raw.filter((e): e is [string, V] => Array.isArray(e) && typeof e[0] === 'string' && isValue(e[1])) : [],
    );
  }

  get key(): string {
    return this.raw.key;
  }

  get saved(): boolean {
    return this.raw.saved;
  }

  /** The saved entries, as a map (the same object until they change). */
  get(): ReadonlyMap<string, V> {
    const entries = this.raw.get();
    if (!this.map || this.map.from !== entries) this.map = { from: entries, map: new Map(entries) };
    return this.map.map;
  }

  /**
   * Sets (a value) or removes (undefined) these entries on top of what is saved now. With no changes it saves nothing,
   * except an empty map when nothing is saved yet, so `saved` says this key has been written once.
   */
  apply(changes: ReadonlyMap<string, V | undefined>): Thenable<void> {
    if (!changes.size && this.saved) return Promise.resolve();
    return this.raw.update((saved) => applyEntries(saved, changes, this.limit));
  }
}
