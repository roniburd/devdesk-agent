import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Deletes the evidence the extension host leaves when it runs out of memory, once it is old: V8 heap snapshots
 * (several GB each, in the extension host's working directory, usually `~`) and Node's fatal-error reports (in
 * `devdesk.diagnostics.dir`). Only files with the names Node gives them, at the top of each directory.
 */

/** `Heap.20261030.150551.37125.0.001.heapsnapshot`, as `setHeapSnapshotNearHeapLimit` names them. */
const HEAP_SNAPSHOT = /^Heap\.\d{8}\.\d{6}\.\d+\.\d+\.\d{3}\.heapsnapshot$/;
/** `report.20261030.150551.37125.0.001.json`, as `process.report` names them. */
const REPORT = /^report\.\d{8}\.\d{6}\.\d+\.\d+\.\d{3}\.json$/;

export function isDiagnosticsFile(name: string): boolean {
  return HEAP_SNAPSHOT.test(name) || REPORT.test(name);
}

export interface Removed {
  path: string;
  bytes: number;
}

/**
 * Deletes the diagnostics files in `dirs` last written more than `keepDays` days before `now` (0 keeps them all).
 * Unreadable directories and files another window deleted first are skipped.
 */
export async function removeOldDiagnostics(dirs: readonly string[], keepDays: number, now: number): Promise<Removed[]> {
  if (!(keepDays > 0)) return [];
  const before = now - keepDays * 24 * 60 * 60 * 1000;
  const removed: Removed[] = [];
  for (const dir of new Set(dirs)) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !isDiagnosticsFile(e.name)) continue;
      const path = join(dir, e.name);
      try {
        const s = await stat(path);
        if (s.mtimeMs >= before) continue;
        await unlink(path);
        removed.push({ path, bytes: s.size });
      } catch {
        // Gone already (another window cleaned it), or not ours to delete.
      }
    }
  }
  return removed;
}
