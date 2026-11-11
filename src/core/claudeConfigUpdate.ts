import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** How `updateClaudeConfig` ended. */
export type ClaudeConfigUpdate =
  /** The change was written. */
  | 'written'
  /** `update` changed nothing. */
  | 'unchanged'
  /** There is no config file (nothing is trusted then): none is made. */
  | 'missing'
  /** The file could not be read or is not JSON: left alone. */
  | 'unreadable'
  /** Claude held its lock on the file the whole wait. */
  | 'busy'
  /** The file kept changing while it was read and the change made: left alone. */
  | 'changed';

export interface ClaudeConfigUpdateOptions {
  /** How long to wait for Claude's lock on the file. Default 3 s. */
  waitMs?: number;
  /** Reads before giving up on a file that changes between the read and the write. Default 3. */
  attempts?: number;
  /** Runs between computing the change and checking the file is unchanged (tests use it to change the file). */
  beforeWrite?: () => Promise<void>;
}

/** Whether a file is still the one read: same size and modification time. */
const same = (a: { mtimeMs: number; size: number }, b: { mtimeMs: number; size: number }) => a.mtimeMs === b.mtimeMs && a.size === b.size;

/**
 * Changes Claude Code's global config file (`~/.claude.json`) by `update`, which gets the parsed file and returns the
 * new content, or undefined to change nothing. Claude rewrites the file often and from every running session, so:
 * - it holds the lock Claude takes for its own writes (the directory `<file>.lock`, as `proper-lockfile` makes it),
 *   waiting for it, and never taking it over (a stale one is Claude's to clean up);
 * - it reads the file under that lock and changes only what `update` changes, so every other key stays;
 * - just before writing it checks the file is still the one it read (Claude may write without the lock when it cannot
 *   get it), and reads it again if not, giving up after `attempts`;
 * - it writes a temporary file next to the real one (the target of a link) with the same permissions, then renames it.
 */
export async function updateClaudeConfig(file: string, update: (json: unknown) => unknown, options: ClaudeConfigUpdateOptions = {}): Promise<ClaudeConfigUpdate> {
  const target = await realpath(file).catch(() => undefined);
  if (!target) return 'missing';
  const lock = `${file}.lock`;
  if (!(await takeLock(lock, options.waitMs ?? 3000))) return 'busy';
  try {
    for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
      let read;
      let text: string;
      let json: unknown;
      try {
        read = await stat(target);
        text = await readFile(target, 'utf8');
        json = JSON.parse(text);
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      }
      const next = update(json);
      if (next === undefined) return 'unchanged';
      await options.beforeWrite?.();
      const now = await stat(target).catch(() => undefined);
      if (!now) return 'missing';
      if (!same(read, now) || (await readFile(target, 'utf8').catch(() => undefined)) !== text) continue;
      const tmp = join(dirname(target), `.${randomUUID()}.devdesk.tmp`);
      try {
        // Claude writes the file with 2-space indentation and mode 0600.
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode: read.mode & 0o777 });
        await rename(tmp, target);
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      return 'written';
    }
    return 'changed';
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

/** Makes the lock directory (true), waiting up to `waitMs` while another process holds it. */
async function takeLock(lock: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
}
