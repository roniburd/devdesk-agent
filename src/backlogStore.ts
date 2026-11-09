import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import * as vscode from 'vscode';
import { writeFileAtomic } from './core/atomicWrite';
import { type BacklogItem, parseBacklog, serializeBacklog } from './core/board';
import type { LaunchChoice } from './core/composer';
import { withFileLock } from './core/fileLock';
import { readTextIfExists } from './core/json';
import { JsonFileStore } from './state/jsonFileStore';

/**
 * The Claude Board's prompts for later, in `backlog.json`: the project folder's own, in `context.storageUri` (a window
 * with no folder uses the host-wide one in `globalStorageUri`). Every window on the file shares it through a
 * `JsonFileStore` (changes are made on what is in the file now, under a lock, and another window's change reloads it
 * here).
 */
export class BacklogStore implements vscode.Disposable {
  private readonly store: JsonFileStore<BacklogItem[]>;
  readonly onDidChange: vscode.Event<void>;

  constructor(file: string) {
    this.store = new JsonFileStore(file, { empty: () => [], parse: parseBacklog, serialize: serializeBacklog, label: "the Claude Board's prompts for later" });
    this.onDidChange = this.store.onDidChange;
  }

  /** The file the prompts are kept in. */
  get file(): string {
    return this.store.file;
  }

  all(): readonly BacklogItem[] {
    return this.store.value;
  }

  /** The item with this id, if any (webview messages carry ids, which are checked against this). */
  find(id: unknown): BacklogItem | undefined {
    return typeof id === 'string' ? this.store.value.find((i) => i.id === id) : undefined;
  }

  load(): Promise<void> {
    return this.store.load();
  }

  /** Re-reads the file (another window may have changed it), telling listeners when it did. */
  reload(): Promise<void> {
    return this.store.reload();
  }

  /**
   * Moves the prompts for later in `oldFile` (the host-wide `backlog.json` every project shared before) that `belongs`
   * says are this project's into this store, and takes them out of `oldFile` (removed once empty), under `oldFile`'s
   * lock so two project folders opening at once never both take one. They are added here before they leave `oldFile`,
   * and by id, so a move cut short is finished by the next one without losing or doubling any. Returns how many moved.
   * A damaged `oldFile` is left as it is.
   */
  async adopt(oldFile: string, belongs: (item: BacklogItem) => boolean): Promise<number> {
    if (oldFile === this.store.file) return 0;
    return withFileLock(oldFile, async () => {
      const text = await readTextIfExists(oldFile);
      if (text === undefined) return 0;
      const items = parseBacklog(text);
      const mine = items.filter(belongs);
      if (!mine.length) return 0;
      await this.store.update((have) => {
        const ids = new Set(have.map((i) => i.id));
        const added = mine.filter((i) => !ids.has(i.id));
        return added.length ? [...have, ...added] : have;
      });
      const rest = items.filter((i) => !mine.includes(i));
      if (rest.length) await writeFileAtomic(oldFile, serializeBacklog(rest), true);
      else await unlink(oldFile).catch(() => undefined);
      return mine.length;
    });
  }

  async add(prompt: string, choice?: Partial<LaunchChoice>): Promise<BacklogItem> {
    const item: BacklogItem = { id: randomUUID(), prompt: prompt.trim(), createdAt: Date.now(), ...(choice ? { choice } : {}) };
    await this.store.update((items) => [...items, item]);
    return item;
  }

  async update(id: string, prompt: string, choice?: Partial<LaunchChoice>): Promise<void> {
    await this.store.update((items) => items.map((i) => (i.id === id ? { id: i.id, prompt: prompt.trim(), createdAt: i.createdAt, ...(choice ? { choice } : {}) } : i)));
  }

  async remove(id: string): Promise<void> {
    await this.store.update((items) => items.filter((i) => i.id !== id));
  }

  dispose(): void {
    this.store.dispose();
  }
}
