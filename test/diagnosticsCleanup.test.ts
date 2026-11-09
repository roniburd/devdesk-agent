import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDiagnosticsFile, removeOldDiagnostics } from '../src/core/diagnosticsCleanup';

const DAY = 24 * 60 * 60 * 1000;

describe('removeOldDiagnostics', () => {
  let dir: string;
  const now = Date.now();
  const write = async (name: string, daysAgo: number) => {
    const path = join(dir, name);
    await writeFile(path, 'x');
    const at = new Date(now - daysAgo * DAY);
    await utimes(path, at, at);
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-diag-'));
    await write('Heap.20261030.150551.37125.0.001.heapsnapshot', 4);
    await write('Heap.20261102.150551.37125.0.001.heapsnapshot', 1);
    await write('report.20261030.150551.37125.0.001.json', 10);
    await write('mine.heapsnapshot', 30);
    await write('report.json', 30);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes only the snapshots and reports Node named, older than keepDays', async () => {
    const removed = await removeOldDiagnostics([dir, dir, join(dir, 'missing')], 3, now);
    expect(removed.map((r) => r.path.slice(dir.length + 1)).sort()).toEqual([
      'Heap.20261030.150551.37125.0.001.heapsnapshot',
      'report.20261030.150551.37125.0.001.json',
    ]);
    expect((await readdir(dir)).sort()).toEqual(['Heap.20261102.150551.37125.0.001.heapsnapshot', 'mine.heapsnapshot', 'report.json']);
  });

  it('keeps everything with keepDays 0', async () => {
    expect(await removeOldDiagnostics([dir], 0, now)).toEqual([]);
    expect(await readdir(dir)).toHaveLength(5);
  });

  it('recognizes the names Node gives them', () => {
    expect(isDiagnosticsFile('Heap.20261031.074115.129608.0.001.heapsnapshot')).toBe(true);
    expect(isDiagnosticsFile('Heap.snapshot.heapsnapshot')).toBe(false);
  });
});
