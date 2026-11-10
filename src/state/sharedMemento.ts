import type * as vscode from 'vscode';
import {
  emptySharedState,
  importValues,
  parseSharedState,
  serializeSharedState,
  type SharedState,
  withValue,
} from '../core/sharedState';
import { log } from '../log';
import { JsonFileStore } from './jsonFileStore';
import type { ModifiableMemento } from './mementoState';

/**
 * A Memento whose shared keys (`isShared`) live in a file of the storage folder both DevDesk for Claude Code versions use
 * (`core/sharedState.ts`), and every other key in `base`, this extension's own `globalState` or `workspaceState`. With
 * no file (a window with no folder has no project storage) every key stays in `base`.
 *
 * Like `globalState`, `get` returns the same object until the value changes, so `MementoValue` parses it once. Another
 * window's write reaches this one when the file changes (`JsonFileStore` watches it), so read it afresh, never keep a
 * copy. `modify` changes a value on what the file holds now, under its lock (`MementoValue.update` uses it).
 */
export class SharedMemento implements ModifiableMemento, vscode.Disposable {
  private readonly store: JsonFileStore<SharedState> | undefined;
  /**
   * Changes this window made that are still being written: `get` returns them at once, as `globalState` does, so code
   * that reads right after an update sees it (the read state recomputed after a mark by hand keeps the mark).
   */
  private readonly pending = new Map<string, { value: unknown; seq: number }>();
  private seq = 0;
  /** The value last returned for each shared key: what it was read from, the object, and its JSON. */
  private readonly returned = new Map<string, { raw: unknown; value: unknown; text: string }>();

  constructor(
    private readonly base: vscode.Memento,
    file: string | undefined,
    private readonly isShared: (key: string) => boolean,
    label: string,
  ) {
    this.store = file === undefined ? undefined : new JsonFileStore(file, { empty: emptySharedState, parse: parseSharedState, serialize: serializeSharedState, label });
  }

  /** The file, if the shared keys have one. */
  get file(): string | undefined {
    return this.store?.file;
  }

  /**
   * Reads the file (and watches it), then copies this extension's own saved values of the shared keys into it, once
   * (`importValues`): what this version saved before the file existed, or while the other version ran.
   */
  async load(extensionId: string): Promise<void> {
    if (!this.store) return;
    await this.store.load();
    const own = this.base
      .keys()
      .filter(this.isShared)
      .map((key) => [key, this.base.get<unknown>(key)] as const);
    try {
      const before = this.store.value;
      const after = await this.store.update((state) => importValues(state, extensionId, own));
      if (after !== before && !before.imported.includes(extensionId)) {
        log.info(`shared state: copied ${own.length} saved values of ${extensionId} (${own.map(([k]) => k).join(', ') || 'none'}) into ${this.store.file}`);
      }
    } catch (err) {
      log.warn(`shared state: cannot copy the saved values of ${extensionId} into ${this.store.file}: ${(err as Error).message}`);
    }
  }

  private shares(key: string): boolean {
    return !!this.store && this.isShared(key);
  }

  keys(): readonly string[] {
    const own = this.base.keys().filter((key) => !this.shares(key));
    return this.store ? [...own, ...Object.keys(this.store.value.values)] : own;
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.shares(key)) return defaultValue === undefined ? this.base.get<T>(key) : this.base.get<T>(key, defaultValue);
    const value = this.current(key);
    return value === undefined ? defaultValue : (value as T);
  }

  update(key: string, value: unknown): Thenable<void> {
    if (!this.shares(key)) return this.base.update(key, value);
    return this.write(key, value, (state) => withValue(state, key, value));
  }

  /** Sets `key` to `change` of its value saved now (by this window or another), under the file's lock. */
  modify(key: string, change: (saved: unknown) => unknown): Thenable<void> {
    if (!this.shares(key)) return this.base.update(key, change(this.base.get<unknown>(key)));
    return this.write(key, change(this.raw(key)), (state) => withValue(state, key, change(state.values[key])));
  }

  /** Shows `value` at once, and writes `change` of what the file holds now. */
  private write(key: string, value: unknown, change: (state: SharedState) => SharedState): Promise<void> {
    const seq = ++this.seq;
    this.pending.set(key, { value, seq });
    return this.store!.update(change).then(
      () => this.settle(key, seq),
      (err: unknown) => {
        this.settle(key, seq);
        throw err;
      },
    );
  }

  /** The write `seq` is done: the file (now holding it) answers for `key` again, unless a later write is pending. */
  private settle(key: string, seq: number): void {
    if (this.pending.get(key)?.seq === seq) this.pending.delete(key);
  }

  /** What this window sees of the shared key now: its pending change, else the file's value. */
  private raw(key: string): unknown {
    const pending = this.pending.get(key);
    return pending ? pending.value : this.store!.value.values[key];
  }

  /** The shared key's value now: the object returned before when its content did not change. */
  private current(key: string): unknown {
    const raw = this.raw(key);
    const last = this.returned.get(key);
    if (last && last.raw === raw) return last.value;
    if (raw === undefined) {
      this.returned.delete(key);
      return undefined;
    }
    const text = JSON.stringify(raw);
    if (last && last.text === text) {
      this.returned.set(key, { ...last, raw });
      return last.value;
    }
    this.returned.set(key, { raw, value: raw, text });
    return raw;
  }

  dispose(): void {
    this.store?.dispose();
  }
}
