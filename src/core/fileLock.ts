import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileLockOptions {
  /** A lock older than this (its holder crashed or hangs) is taken over. Default 30 s. */
  staleMs?: number;
  /** How long to wait for another holder before giving up. Default 10 s; 0 tries once. */
  waitMs?: number;
  /** The lock directory's permissions when it has to be created (for example 0o700 for private data). */
  dirMode?: number;
}

/** Thrown by `withFileLock` when another process holds a fresh lock for longer than `waitMs`. */
export class FileLockBusy extends Error {
  constructor(readonly lockPath: string) {
    super(`${lockPath} is held by another window`);
  }
}

/**
 * Runs `fn` while holding `<path>.lock`, a lock every window and process on this machine respects (created with `wx`,
 * so only one can make it). Use it around every read-modify-write of a file that several windows change, so one
 * window's change is never written over by another's copy read a moment earlier. A lock left by a crashed holder is
 * taken over once it is `staleMs` old; a long `fn` keeps its lock fresh.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const lock = `${path}.lock`;
  const staleMs = options.staleMs ?? 30_000;
  const token = await acquire(lock, staleMs, options.waitMs ?? 10_000, options.dirMode);
  const keepFresh = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => undefined), Math.max(1000, staleMs / 3));
  try {
    return await fn();
  } finally {
    clearInterval(keepFresh);
    // Only remove the lock if it is still ours (it may have been taken over as stale).
    if ((await readFile(lock, 'utf8').catch(() => '')) === token) await unlink(lock).catch(() => undefined);
  }
}

async function acquire(lock: string, staleMs: number, waitMs: number, dirMode: number | undefined): Promise<string> {
  await mkdir(dirname(lock), { recursive: true, ...(dirMode === undefined ? {} : { mode: dirMode }) });
  const deadline = Date.now() + waitMs;
  for (let delay = 20; ; delay = Math.min(delay * 2, 100)) {
    try {
      const handle = await open(lock, 'wx');
      const token = randomUUID();
      await handle.writeFile(token).finally(() => handle.close());
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const held = await readFile(lock, 'utf8').catch(() => undefined);
    const info = await stat(lock).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs >= staleMs) {
      // Another window may have taken the stale lock over meanwhile: remove it only if it is still the stale one.
      if ((await readFile(lock, 'utf8').catch(() => undefined)) === held) await unlink(lock).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) throw new FileLockBusy(lock);
    await new Promise((r) => setTimeout(r, delay));
  }
}
