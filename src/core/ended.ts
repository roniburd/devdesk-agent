import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite';
import { withFileLock } from './fileLock';
import { isFiniteNumber, parseObject, readJsonFiles } from './json';
import { type HookRecord, parseHookRecord } from './sessions';
import { isSessionId } from './tmux';

/**
 * Why a session stopped running: DevDesk parked it (see `parkPlan`), Claude exited (`/exit`, End), or
 * its process died mid-turn.
 */
export type EndReason = 'parked' | 'exited' | 'crashed';

/** A session that no longer runs: its last hook record, kept so the Claude view can list it and resume it. */
export interface EndedRecord extends HookRecord {
  endedAt: number;
  endReason: EndReason;
}

const END_REASONS: ReadonlySet<string> = new Set(['parked', 'exited', 'crashed']);

/** Where ended sessions are kept: `<state dir>/ended`, out of the way of the live records the watcher follows. */
export const endedDir = (stateDir: string) => join(stateDir, 'ended');

export function parseEndedRecord(text: string): EndedRecord | undefined {
  const record = parseHookRecord(text);
  if (!record) return undefined;
  const r = parseObject(text)!;
  if (!isFiniteNumber(r.endedAt)) return undefined;
  if (typeof r.endReason !== 'string' || !END_REASONS.has(r.endReason)) return undefined;
  return { ...record, endedAt: r.endedAt, endReason: r.endReason as EndReason };
}

/** Valid ended records in `dir`; unreadable or invalid files are skipped. */
export function readEndedRecords(dir: string): Promise<EndedRecord[]> {
  return readJsonFiles(dir, (n) => n.endsWith('.json'), parseEndedRecord);
}

const endedFile = (dir: string, sessionId: string) => join(dir, `${sessionId}.json`);

/**
 * Keeps `record` as ended because of `reason`, unless an ended record written after the session's last activity is
 * already there (DevDesk parked it, then its process died): that one says why it ended. True if written.
 */
export async function writeEndedRecord(dir: string, record: HookRecord, reason: EndReason, now = Date.now()): Promise<boolean> {
  if (!isSessionId(record.sessionId)) return false;
  const path = endedFile(dir, record.sessionId);
  // Under a lock: another window may be recording the same session's end (parked, then found dead) at the same moment.
  return withFileLock(path, async () => {
    try {
      const existing = parseEndedRecord(await readFile(path, 'utf8'));
      if (existing && existing.endedAt >= record.updatedAt) return false;
    } catch {
      // None yet.
    }
    const ended: EndedRecord = { ...record, endedAt: now, endReason: reason };
    await writeFileAtomic(path, JSON.stringify(ended), true);
    return true;
  });
}

export async function removeEndedRecord(dir: string, sessionId: string): Promise<void> {
  if (!isSessionId(sessionId)) return;
  try {
    await unlink(endedFile(dir, sessionId));
  } catch {
    // Already gone.
  }
}

/**
 * Ended records worth listing: not running (a resume keeps the session id), and with a transcript to resume from
 * (Claude Code deletes old ones, `cleanupPeriodDays`). `stale` are those to delete: their transcript is gone, or the
 * session ran again after it ended (`live`: the last activity of each running session). A session that is still dying
 * (just parked) is not listed, but its record stays.
 */
export function listableEnded(
  ended: readonly EndedRecord[],
  live: ReadonlyMap<string, number>,
  exists: (path: string) => boolean = existsSync,
): { listed: EndedRecord[]; stale: EndedRecord[] } {
  const listed: EndedRecord[] = [];
  const stale: EndedRecord[] = [];
  for (const r of ended) {
    const active = live.get(r.sessionId);
    if (active !== undefined) {
      if (active > r.endedAt) stale.push(r);
    } else if (r.transcriptPath && !exists(r.transcriptPath)) stale.push(r);
    else listed.push(r);
  }
  return { listed, stale };
}
