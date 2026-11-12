import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { claudeProjectsDirs, sessionsStateDir, usageHistoryDays, usageHistoryMaxBytes } from './config';
import { UsageReader } from './core/usage';
import { usageLedger } from './insightsWorker';
import { log, noteLatency, track } from './log';
import { type CountProgress, type CountRequest, countUsage, type UsageSnapshot } from './usageCount';
import type { FromWorker, ToWorker } from './usageWorker';

export type { CountProgress, UsageSnapshot } from './usageCount';

const usageHistoryPath = (stateDir: string) => join(stateDir, 'usage-history.jsonl');

/**
 * Token usage for the 📊 popover and the stats page. Days that ended are stored once in the history file (so they stay
 * after Claude Code deletes old transcripts), pruned by `devdesk.usage.historyDays` and `devdesk.usage.historyMaxMB`;
 * only days not stored yet are read from transcripts, incrementally across calls. The counting runs in the usage worker
 * (`workerPath`), or inline when there is none.
 */
export class UsageService {
  private running: Promise<UsageSnapshot> | undefined;
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (s: UsageSnapshot) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(p: CountProgress) => void>();
  private reader: UsageReader | undefined;
  private disposed = false;
  /** Off once the worker could not start; counts then run in the extension host. */
  private useWorker: boolean;
  /** The worker sent a message, so it started. */
  private workerAlive = false;
  /** How far the count in progress has got (undefined when none runs), without its stored days. */
  progress: CountProgress | undefined;
  /** The days the count in progress has stored so far, for a page opened while it runs. */
  stored: CountProgress['stored'];

  /** `names`: session names the board knows, by session id. */
  constructor(
    private readonly names: () => ReadonlyMap<string, string>,
    private readonly workerPath?: string,
  ) {
    this.useWorker = !!workerPath;
  }

  /** The usage now; calls made while one runs share it. */
  snapshot(): Promise<UsageSnapshot> {
    this.running ??= this.compute().finally(() => {
      this.running = undefined;
      this.progress = undefined;
      this.stored = undefined;
    });
    return this.running;
  }

  /** Tells `listener` how far each count has got, until disposed. */
  onProgress(listener: (p: CountProgress) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private request(): CountRequest {
    const stateDir = sessionsStateDir();
    return {
      projectsDir: claudeProjectsDirs(),
      historyPath: usageHistoryPath(stateDir),
      ledgerPath: usageLedger(stateDir),
      keepDays: usageHistoryDays(),
      maxBytes: usageHistoryMaxBytes(),
      names: [...this.names()],
      now: Date.now(),
    };
  }

  private progressed(p: CountProgress): void {
    if (p.stored) this.stored = p.stored;
    this.progress = { ...p, stored: undefined };
    for (const l of this.listeners) l(p);
  }

  private async compute(): Promise<UsageSnapshot> {
    const done = track('usage snapshot');
    const start = Date.now();
    try {
      const req = this.request();
      let snapshot: UsageSnapshot | undefined;
      if (this.useWorker) {
        try {
          snapshot = await this.inWorker(req);
        } catch (err) {
          if (this.workerAlive || this.disposed) throw err;
          // It never started (a broken install): count here rather than not at all.
          log.warn(`cannot start the usage worker (${(err as Error).message}); counting in the extension host`);
          this.useWorker = false;
        }
      }
      snapshot ??= await countUsage((this.reader ??= new UsageReader()), req, (p) => this.progressed(p));
      for (const w of snapshot.warnings) log.warn(w);
      const ms = Date.now() - start;
      noteLatency('usage snapshot', ms);
      if (ms > 10_000) log.info(`counted token usage in ${Math.round(ms / 1000)}s: ${this.progress?.totalFiles ?? 0} transcripts, ${snapshot.history.days} days stored`);
      return snapshot;
    } finally {
      done();
    }
  }

  private startWorker(path: string): Worker {
    const worker = new Worker(path);
    const fail = (err: Error) => {
      if (this.worker === worker) this.worker = undefined;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    worker.on('message', (m: FromWorker) => {
      this.workerAlive = true;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') return this.progressed(m.progress);
      this.pending.delete(m.id);
      if (m.type === 'done') p.resolve(m.snapshot);
      else p.reject(new Error(m.message));
    });
    worker.on('error', (err) => {
      log.warn(`the usage worker failed: ${err.message}`);
      fail(err);
    });
    worker.on('exit', (code) => fail(new Error(`the usage worker stopped (exit code ${code})`)));
    return worker;
  }

  private inWorker(req: CountRequest): Promise<UsageSnapshot> {
    if (this.disposed) return Promise.reject(new Error('the extension is shutting down'));
    const worker = (this.worker ??= this.startWorker(this.workerPath!));
    const id = this.nextId++;
    return new Promise<UsageSnapshot>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, req } satisfies ToWorker);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    void this.worker?.terminate();
    this.worker = undefined;
  }
}
