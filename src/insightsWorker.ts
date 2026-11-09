import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import {
  buildExcerpt,
  type CallResult,
  type Insight,
  INSIGHT_SYSTEM_PROMPT,
  earlierPromptsPart,
  firstPrompts,
  insightDue,
  latestPrompt,
  insightFileName,
  type InsightKind,
  ledgerLine,
  mergeAnswer,
  parseCallOutput,
  parseInsight,
  turnEnd,
} from './core/insights';
import { writeFileAtomic } from './core/atomicWrite';
import { removeOldFiles } from './core/oldFiles';
import { FileLockBusy, withFileLock } from './core/fileLock';
import { createPriorityLimiter } from './core/limit';
import type { SessionCard } from './core/sessions';
import { oneLine } from './core/text';
import { headlessClaudeCommand } from './core/shellRun';
import { log } from './log';
import { runInShell } from './shellCall';
import { readHead, readTail } from './core/transcriptTail';
import { appendLedgerLine } from './usageCount';

/** Where insights live: `<state dir>/insights`, out of the way of the hook records the sessions watcher reads. */
export const insightsDir = (stateDir: string) => join(stateDir, 'insights');
/** DevDesk's own token usage, one line per call. */
export const usageLedger = (stateDir: string) => join(stateDir, 'usage.jsonl');

export async function readInsight(stateDir: string, sessionId: string): Promise<Insight | undefined> {
  const name = insightFileName(sessionId, 'json');
  if (!name) return undefined;
  try {
    return parseInsight(await readFile(join(insightsDir(stateDir), name), 'utf8'));
  } catch {
    return undefined;
  }
}

const CALL_TIMEOUT_MS = 30_000;
/** A lock this old was left by a window that went away mid-call. */
const STALE_LOCK_MS = 2 * 60_000;
/** Insight files of sessions not seen for this long are removed. */
const PRUNE_AFTER_MS = 7 * 24 * 3600_000;
/** How much of the transcript's end a call reads. */
const TAIL_BYTES = 256 * 1024;
/** How much of a transcript's start is read for the session's first prompts (its objective). */
const HEAD_BYTES = 128 * 1024;

export interface InsightsOptions {
  stateDir: () => string;
  enabled: () => boolean;
  refreshMs: () => number;
  maxConcurrent: () => number;
  model: () => string;
  /** The Claude binary, in shell syntax. */
  claude: () => string;
  /** Runs one call; tests replace it. */
  run?: (command: string, input: string) => Promise<{ stdout: string; error?: string }>;
}

/** What the call is about, first in its input. */
function insightHeader(kind: InsightKind, detail: string): string {
  if (kind === 'done') return 'The turn has FINISHED; Claude now waits for the next prompt.';
  if (kind === 'ask') return `Claude is WAITING for the user to answer or approve something before it can go on. The terminal shows: ${oneLine(detail).slice(0, 300)}`;
  return 'Claude is still WORKING on this turn.';
}

async function transcriptSize(path: string): Promise<number> {
  return (await stat(path).catch(() => undefined))?.size ?? 0;
}

/**
 * Asks a small model about sessions as they change: once per finished turn, and while one works after new activity
 * at most every `refreshMs`. Each call is a `claude -p --bare` run of its own; the user's sessions are never touched.
 * Answers go to `<state dir>/insights/<session id>.json`, which every window reads; a lock file there makes one
 * window do each call.
 */
export class InsightsWorker implements vscode.Disposable {
  /** Calls start in the order they are due, at most `maxConcurrent` at a time. */
  private readonly limit = createPriorityLimiter(() => this.o.maxConcurrent());
  private readonly busy = new Set<string>();
  private disposed = false;
  private pruned = false;

  constructor(private readonly o: InsightsOptions) {}

  /** Looks at the current cards; called on every sessions change. */
  update(cards: readonly SessionCard[]): void {
    if (this.disposed || !this.o.enabled()) return;
    if (!this.pruned) {
      this.pruned = true;
      void this.prune();
    }
    for (const card of cards) {
      if (!card.sessionId || !card.transcriptPath || this.busy.has(card.sessionId)) continue;
      if (card.state !== 'working' && card.state !== 'done' && card.state !== 'waiting') continue;
      void this.consider(card);
    }
  }

  private async consider(card: SessionCard): Promise<void> {
    const id = card.sessionId!;
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const insight = await readInsight(this.o.stateDir(), id);
      const kind = insightDue(card, insight, Date.now(), this.o.refreshMs(), await transcriptSize(card.transcriptPath!));
      if (!kind) {
        this.busy.delete(id);
        return;
      }
      void this.limit(() => (this.disposed ? Promise.resolve() : this.call(card, kind))).promise.finally(() => this.busy.delete(id));
    } catch (err) {
      this.busy.delete(id);
      log.warn(`insights: cannot look at session ${id}: ${(err as Error).message}`);
    }
  }

  private async call(card: SessionCard, kind: InsightKind): Promise<void> {
    const id = card.sessionId!;
    const turn = kind === 'done' ? turnEnd(card)! : kind === 'ask' ? card.updatedAt! : card.turnStartedAt!;
    const stateDir = this.o.stateDir();
    const dir = insightsDir(stateDir);
    await mkdir(dir, { recursive: true });
    const name = insightFileName(id, 'json');
    if (!name) return;
    const jsonPath = join(dir, name);
    try {
      // `<id>.lock`, which every window respects: one asks for a session at a time; the others skip it.
      await withFileLock(join(dir, id), () => this.callLocked(card, kind, turn, stateDir, jsonPath), { waitMs: 0, staleMs: STALE_LOCK_MS });
    } catch (err) {
      if (!(err instanceof FileLockBusy)) log.warn(`insights: call for session ${id} failed: ${(err as Error).message}`);
    }
  }

  private async callLocked(card: SessionCard, kind: InsightKind, turn: number, stateDir: string, jsonPath: string): Promise<void> {
    const id = card.sessionId!;
    try {
      // Another window may have answered between the check and the lock.
      const before = await readInsight(stateDir, id);
      const tail = await readTail(card.transcriptPath!, TAIL_BYTES);
      if (!tail || insightDue(card, before, Date.now(), this.o.refreshMs(), tail.bytes) !== kind) return;
      const excerpt = buildExcerpt(tail.lines, card.prompt);
      if (!excerpt) return;
      // The session's first prompts (what its objective is about): the excerpt shows only the latest.
      const head = tail.bytes > TAIL_BYTES ? await readHead(card.transcriptPath!, HEAD_BYTES) : tail.lines;
      const earlier = earlierPromptsPart(firstPrompts(head), latestPrompt(tail.lines) || card.prompt);
      const input = [
        insightHeader(kind, card.detail),
        before?.title ? `Current title: ${before.title}` : '',
        before?.objective ? `Current objective: ${before.objective}` : '',
        earlier,
        excerpt,
      ]
        .filter(Boolean)
        .join('\n\n');
      const result = await this.ask(input);
      await appendLedgerLine(usageLedger(stateDir), ledgerLine(Date.now(), kind, id, result)).catch(() => undefined);
      if (!result.answer) {
        log.warn(`insights: no answer for session ${id} (${kind}): ${result.error ?? 'unknown error'}`);
        return;
      }
      const latest = await readInsight(stateDir, id);
      await writeFileAtomic(jsonPath, JSON.stringify(mergeAnswer(latest, kind, turn, result.answer, Date.now(), tail.bytes)), true);
    } catch (err) {
      log.warn(`insights: call for session ${id} failed: ${(err as Error).message}`);
    }
  }

  private async ask(input: string): Promise<CallResult> {
    const run = this.o.run ?? ((command: string, stdin: string) => runInShell(command, stdin, { timeoutMs: CALL_TIMEOUT_MS }));
    const { stdout, error } = await run(headlessClaudeCommand(this.o.claude(), this.o.model(), INSIGHT_SYSTEM_PROMPT), input);
    if (error) return { ...parseCallOutput(stdout), error };
    return parseCallOutput(stdout);
  }

  /** Removes insight files (and abandoned locks) not written for a week. */
  private async prune(): Promise<void> {
    await removeOldFiles(insightsDir(this.o.stateDir()), () => true, Date.now() - PRUNE_AFTER_MS).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
  }
}
