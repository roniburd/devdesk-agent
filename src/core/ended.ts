import { access, readdir, readFile, stat, unlink } from 'node:fs/promises';
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
  exists: (path: string) => boolean,
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

/** How often `EndedRecords` checks again that the transcripts it saw before still exist (the park check's pace). */
export const TRANSCRIPT_CHECK_MS = 60_000;

/**
 * The ended records in a directory, kept across reads: a record is written whole (renamed into place) and rarely
 * again, so each read stats the files and parses only new or rewritten ones. Whether each record's transcript exists is checked when the record is
 * first seen, then again every `checkMs` (Claude Code deletes old transcripts rarely), so a record whose transcript goes
 * away stops being listed within one interval.
 */
export class EndedRecords {
  private files = new Map<string, { ino: number; mtimeMs: number; size: number; record: EndedRecord | undefined }>();
  private transcripts = new Map<string, boolean>();
  private lastCheck: number | undefined;

  constructor(
    private readonly checkMs = TRANSCRIPT_CHECK_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The valid records in `dir` (unreadable or invalid files are skipped), and whether a record's transcript exists. */
  async read(dir: string): Promise<{ records: EndedRecord[]; exists: (path: string) => boolean }> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      names = [];
    }
    const files = new Map<string, { ino: number; mtimeMs: number; size: number; record: EndedRecord | undefined }>();
    const records = await Promise.all(
      names.map(async (n) => {
        const path = join(dir, n);
        try {
          const info = await stat(path);
          const kept = this.files.get(path);
          if (kept && kept.ino === info.ino && kept.mtimeMs === info.mtimeMs && kept.size === info.size) {
            files.set(path, kept);
            return kept.record;
          }
          const record = parseEndedRecord(await readFile(path, 'utf8'));
          files.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, record });
          return record;
        } catch {
          return undefined;
        }
      }),
    );
    this.files = files;
    const listed = records.filter((r): r is EndedRecord => r !== undefined);
    await this.checkTranscripts(listed);
    const transcripts = this.transcripts;
    return { records: listed, exists: (path) => transcripts.get(path) !== false };
  }

  private async checkTranscripts(records: readonly EndedRecord[]): Promise<void> {
    const now = this.now();
    const all = this.lastCheck === undefined || now - this.lastCheck >= this.checkMs;
    if (all) this.lastCheck = now;
    const paths = new Set(records.flatMap((r) => (r.transcriptPath ? [r.transcriptPath] : [])));
    const next = new Map<string, boolean>();
    await Promise.all(
      [...paths].map(async (path) => {
        const known = this.transcripts.get(path);
        next.set(path, !all && known !== undefined ? known : await access(path).then(() => true, () => false));
      }),
    );
    this.transcripts = next;
  }
}
