import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { writeFileAtomic } from '../core/atomicWrite';
import { withFileLock } from '../core/fileLock';
import { readTextIfExists } from '../core/json';
import { log } from '../log';

export interface JsonFileFormat<T> {
  /** What the store holds while the file does not exist. */
  empty: () => T;
  /** Parses the file's text; throws when it is damaged (a damaged file is never overwritten). */
  parse: (text: string) => T;
  serialize: (value: T) => string;
  /** Shown in log lines and the error message, for example "the Claude Board's prompts for later". */
  label: string;
  /** The file's permissions (for private data, 0o600). */
  mode?: number;
}

/**
 * A JSON file on this machine that several windows read and change: use it for any state kept in a file, so none of
 * them needs its own locking, re-reading or watching.
 *
 * - `value` is what was last read or written; `onDidChange` fires when it changes, also when another window wrote it.
 * - `update(change)` runs `change` on the file's current content (read again under a lock every window respects), so a
 *   change made by another window a moment ago is never lost, then writes the result atomically.
 * - A file that exists but does not parse is left as it is: updates fail, and an error is shown once.
 */
export class JsonFileStore<T> implements vscode.Disposable {
  private current: T;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** This window's reloads and updates, one at a time (the file lock orders them with other windows'). */
  private queue: Promise<unknown> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private lastText: string | undefined;
  private damagedShown = false;

  constructor(
    readonly file: string,
    private readonly format: JsonFileFormat<T>,
  ) {
    this.current = format.empty();
  }

  get value(): T {
    return this.current;
  }

  /** Reads the file and starts watching it for other windows' changes. */
  async load(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
    await this.reload();
    this.watch();
  }

  /** Reads the file again, firing `onDidChange` when its content changed. */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      try {
        this.set(await this.read());
      } catch (err) {
        this.damaged(err);
      }
    });
  }

  /**
   * Applies `change` to the file's current content and writes it; resolves to the new value. `change` returning the
   * same object it was given skips the write.
   */
  update(change: (value: T) => T): Promise<T> {
    return this.enqueue(() =>
      withFileLock(this.file, async () => {
        let value: T;
        try {
          value = await this.read();
        } catch (err) {
          this.damaged(err);
          throw new Error(`${this.file} is damaged, so it was left as it is (see the DevDesk log)`);
        }
        const next = change(value);
        if (next !== value) await writeFileAtomic(this.file, this.format.serialize(next), true, this.format.mode);
        this.set(next);
        return next;
      }),
    );
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private set(value: T): void {
    const text = this.format.serialize(value);
    this.current = value;
    if (text === this.lastText) return;
    this.lastText = text;
    this.changed.fire();
  }

  /** The file's content; `empty` when it does not exist. Throws when it exists but cannot be read or parsed. */
  private async read(): Promise<T> {
    const text = await readTextIfExists(this.file);
    return text === undefined ? this.format.empty() : this.format.parse(text);
  }

  private damaged(err: unknown): void {
    log.warn(`cannot read ${this.format.label} in ${this.file}: ${(err as Error).message}`);
    if (this.damagedShown) return;
    this.damagedShown = true;
    void vscode.window.showErrorMessage(`DevDesk: ${this.file} cannot be read, so ${this.format.label} are not saved until it is fixed or removed.`);
  }

  /** Watches the file's directory, as every write replaces the file. */
  private watch(): void {
    if (this.watcher) return;
    const name = basename(this.file);
    try {
      this.watcher = watch(dirname(this.file), (_event, changed) => {
        if (changed === name) void this.reload();
      });
    } catch (err) {
      log.warn(`cannot watch ${this.file} for other windows' changes: ${(err as Error).message}`);
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.changed.dispose();
  }
}
