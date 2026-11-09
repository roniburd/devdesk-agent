import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { meminfoFreePercent, memorystatusFreePercent } from './core/park';

/**
 * Percent of this machine's memory still available to programs: `MemAvailable` on Linux, the memory pressure level on
 * macOS (where `os.freemem()` counts only never-used pages, a few percent even when memory is plentiful), else
 * `os.freemem()`. Undefined if it cannot be read.
 */
export async function freeMemoryPercent(): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') return meminfoFreePercent(await readFile('/proc/meminfo', 'utf8'));
    if (process.platform === 'darwin') {
      const out = await new Promise<string>((resolve, reject) =>
        execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { timeout: 5_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
      );
      return memorystatusFreePercent(out);
    }
    const total = totalmem();
    return total > 0 ? (freemem() / total) * 100 : undefined;
  } catch {
    return undefined;
  }
}
