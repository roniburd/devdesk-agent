import { removeOldFiles, type Removed } from './oldFiles';

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

/**
 * Deletes the diagnostics files in `dirs` last written more than `keepDays` days before `now` (0 keeps them all).
 * Unreadable directories and files another window deleted first are skipped.
 */
export async function removeOldDiagnostics(dirs: readonly string[], keepDays: number, now: number): Promise<Removed[]> {
  if (!(keepDays > 0)) return [];
  const before = now - keepDays * 24 * 60 * 60 * 1000;
  const removed: Removed[] = [];
  for (const dir of new Set(dirs)) removed.push(...(await removeOldFiles(dir, isDiagnosticsFile, before).catch(() => [])));
  return removed;
}
