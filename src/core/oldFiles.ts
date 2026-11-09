import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface Removed {
  path: string;
  bytes: number;
}

/**
 * Deletes the files at the top of `dir` whose names `accept` takes and that were last written before `before` (ms).
 * Throws when `dir` cannot be read; files that cannot be read or deleted (another window deleted them first) are
 * skipped.
 */
export async function removeOldFiles(dir: string, accept: (name: string) => boolean, before: number): Promise<Removed[]> {
  const removed: Removed[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || !accept(e.name)) continue;
    const path = join(dir, e.name);
    try {
      const s = await stat(path);
      if (s.mtimeMs >= before) continue;
      await unlink(path);
      removed.push({ path, bytes: s.size });
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  return removed;
}
