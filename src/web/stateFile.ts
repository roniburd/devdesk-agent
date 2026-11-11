import { readFile, unlink } from 'node:fs/promises';
import { writeFileAtomic } from '../core/atomicWrite';
import { parseWebState, type WebState } from '../core/web/webState';

/** The daemon's `web.json` (atomic, mode 0600) and its log (stderr, which the extension points at `daemon.log`). */

export function writeWebState(path: string, state: WebState): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, false, 0o600);
}

/** Removes `web.json` when it is this daemon's (`pid`): a daemon that replaced it keeps its own. */
export async function removeWebState(path: string, pid: number): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined || parseWebState(text)?.pid !== pid) return;
  await unlink(path).catch(() => undefined);
}

export function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}
