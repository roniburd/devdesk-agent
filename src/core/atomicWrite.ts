import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes `text` to `path` through a temporary file next to it (creating the directory), so a reader in another window
 * never sees half a file. `unique` adds a random part to the temporary name, for writes that may overlap in one process.
 * `mode`: the file's permissions (default: the process's usual ones).
 */
export async function writeFileAtomic(path: string, text: string, unique = false, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}${unique ? `.${randomUUID()}` : ''}.tmp`;
  await writeFile(tmp, text, mode === undefined ? undefined : { mode });
  await rename(tmp, path);
}
