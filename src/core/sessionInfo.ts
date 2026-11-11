import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GrowingFiles, isFiniteNumber, LineScan, parseObject, readJsonFiles } from './json';
import type { SessionCard } from './sessions';

/**
 * What Claude Code itself says about a session, beyond the hook records: the name the agent view shows and the
 * recaps it writes. Claude Code keeps `<config dir>/sessions/<pid>.json` per running process (`name`, with
 * `nameSource` `user` after /rename, `auto` for a background job's generated name, `derived` for a placeholder built
 * from the directory) and appends `custom-title` (/rename), `ai-title` and `away_summary` entries to the transcript.
 */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  name?: string;
  nameSource?: string;
  startedAt?: number;
  /** A background job's id (its directory under `<config dir>/jobs`); a /fork runs as one. */
  jobId?: string;
  /** The background job this interactive process is showing in place of its own conversation. */
  parkedJobId?: string;
}

export function parseRegistryEntry(text: string): RegistryEntry | undefined {
  const r = parseObject(text);
  if (!r) return undefined;
  if (!Number.isInteger(r.pid) || typeof r.sessionId !== 'string' || !r.sessionId) return undefined;
  const entry: RegistryEntry = { pid: r.pid as number, sessionId: r.sessionId };
  if (typeof r.name === 'string' && r.name.trim()) entry.name = r.name.trim();
  if (typeof r.nameSource === 'string') entry.nameSource = r.nameSource;
  if (isFiniteNumber(r.startedAt)) entry.startedAt = r.startedAt;
  if (typeof r.jobId === 'string' && r.jobId) entry.jobId = r.jobId;
  if (typeof r.parkedJobId === 'string' && r.parkedJobId) entry.parkedJobId = r.parkedJobId;
  return entry;
}

/** The background job `entry` shows in place of its own conversation (its name and recap are what is on screen), if it is running. */
export function parkedJob(entries: readonly RegistryEntry[], entry: RegistryEntry | undefined): RegistryEntry | undefined {
  const id = entry?.parkedJobId;
  return id ? entries.find((e) => e.jobId === id && e !== entry) : undefined;
}

/** Running Claude processes from `<dir>/<pid>.json`; unreadable or invalid files are skipped. */
export function readRegistry(dir: string): Promise<RegistryEntry[]> {
  return readJsonFiles(dir, (n) => /^\d+\.json$/.test(n), parseRegistryEntry);
}

/** The registry entry of a session: by session id, else by its Claude process (whose session id a /clear changes). */
export function registryFor(entries: readonly RegistryEntry[], sessionId: string | undefined, pid: number | undefined): RegistryEntry | undefined {
  return (sessionId ? entries.find((e) => e.sessionId === sessionId) : undefined) ?? (pid !== undefined ? entries.find((e) => e.pid === pid) : undefined);
}

/** The session a /fork job was forked from, from its `<config dir>/jobs/<job id>/state.json`. */
export function parseForkParent(text: string): string | undefined {
  const parent = parseObject(text)?.forkParentSessionId;
  return typeof parent === 'string' && parent ? parent : undefined;
}

/** Which session each background job was forked from; a job's parent never changes, so each job is read once. */
export class ForkParentReader {
  private readonly parents = new Map<string, string | undefined>();

  async read(jobsDir: string, jobId: string): Promise<string | undefined> {
    if (!/^[\w-]+$/.test(jobId)) return undefined;
    if (this.parents.has(jobId)) return this.parents.get(jobId);
    let text: string;
    try {
      text = await readFile(join(jobsDir, jobId, 'state.json'), 'utf8');
    } catch {
      return undefined; // not written yet: try again next time
    }
    const parent = parseForkParent(text);
    this.parents.set(jobId, parent);
    return parent;
  }
}

/** The latest titles and recap a transcript holds, and when it started. */
export interface TranscriptMeta {
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  summaryAt?: number;
  startedAt?: number;
}

/** One transcript read so far; fed incrementally since transcripts only grow. */
export class MetaScan extends LineScan {
  readonly meta: TranscriptMeta = {};

  protected line(line: string): void {
    // Most lines are messages; only parse the few kinds this reads.
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"away_summary"') && this.meta.startedAt !== undefined) return;
    const o = parseObject(line);
    if (!o) return;
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (this.meta.startedAt === undefined && Number.isFinite(at)) this.meta.startedAt = at;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') this.meta.customTitle = o.customTitle.trim() || undefined;
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') this.meta.aiTitle = o.aiTitle.trim() || undefined;
    else if (o.type === 'system' && o.subtype === 'away_summary' && typeof o.content === 'string' && o.content.trim()) {
      this.meta.summary = o.content.trim();
      this.meta.summaryAt = Number.isFinite(at) ? at : undefined;
    }
  }
}

/** Transcript metadata, kept across refreshes so each transcript reads only what was appended. */
export class MetaReader {
  private readonly scans = new GrowingFiles(() => new MetaScan());

  async read(path: string): Promise<TranscriptMeta | undefined> {
    return (await this.scans.read(path))?.meta;
  }

  /** Forgets transcripts not read since the last call (sessions that went away). */
  prune(): void {
    this.scans.prune();
  }
}

/**
 * The session's name as Claude Code shows it: a /rename (live from the registry, else from the transcript), then a
 * background job's generated name, then Claude's own title for the conversation. A `derived` registry name is only
 * the directory and a number, so it never wins over a real title. Undefined when Claude has named nothing yet.
 */
/** Whether the session's name is one the user gave it (a /rename), not one Claude or a job generated. */
export function userNamed(entry: RegistryEntry | undefined, meta: TranscriptMeta | undefined): boolean {
  return (!!entry?.name && entry.nameSource === 'user') || !!meta?.customTitle;
}

export function claudeTitle(entry: RegistryEntry | undefined, meta: TranscriptMeta | undefined): string | undefined {
  if (entry?.name && entry.nameSource === 'user') return entry.name;
  if (meta?.customTitle) return meta.customTitle;
  if (entry?.name && entry.nameSource === 'auto') return entry.name;
  return meta?.aiTitle;
}

/**
 * Adds names, recaps and start times from Claude Code's own session registry and transcripts to `cards` (in place),
 * then forgets the transcripts `meta` read before that no card named now.
 */
export async function addSessionInfo(cards: SessionCard[], registry: readonly RegistryEntry[], meta: MetaReader): Promise<void> {
  await Promise.all(
    cards.map(async (card) => {
      const own = card.sessionId || card.pid !== undefined ? registryFor(registry, card.sessionId, card.pid) : undefined;
      // Attached to a background job: its conversation (name, recap) is what the terminal shows.
      const job = parkedJob(registry, own);
      const entry = job ?? own;
      const transcript = job && card.transcriptPath ? join(dirname(card.transcriptPath), `${job.sessionId}.jsonl`) : card.transcriptPath;
      const read = transcript ? await meta.read(transcript) : undefined;
      const name = claudeTitle(entry, read);
      if (name) card.name = name;
      if (userNamed(entry, read)) card.nameByUser = true;
      if (read?.summary) {
        card.summary = read.summary;
        if (read.summaryAt !== undefined) card.summaryAt = read.summaryAt;
      }
      const startedAt = entry?.startedAt ?? read?.startedAt;
      if (startedAt !== undefined) card.startedAt = startedAt;
    }),
  );
  meta.prune();
}
