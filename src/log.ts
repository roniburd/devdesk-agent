import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { getHeapStatistics, setHeapSnapshotNearHeapLimit } from 'node:v8';
import * as vscode from 'vscode';
import { removeOldDiagnostics } from './core/diagnosticsCleanup';
import { heapReport, type HeapSample } from './core/heapWatch';
import { LatencyStats, type OutlierRule } from './core/latency';
import type { DiagnosticsConfig } from './config';

/** "DevDesk" channel in the Output panel; also written to the extension host log folder. */
const channel = vscode.window.createOutputChannel('DevDesk', { log: true });
let debugAsInfo = false;
let outlierRule: OutlierRule = { factor: 3, minMs: 50 };
const latencies = new LatencyStats();

/** DevDesk's log. With `devdesk.diagnostics.debugLog`, debug lines are written at info level, so they show without changing VS Code's log level. */
export const log = {
  info: (message: string) => channel.info(message),
  warn: (message: string) => channel.warn(message),
  error: (message: string) => channel.error(message),
  debug: (message: string) => (debugAsInfo && channel.logLevel > vscode.LogLevel.Debug ? channel.info(`[debug] ${message}`) : channel.debug(message)),
  dispose: () => channel.dispose(),
};

const MB = 1024 * 1024;
/** With `devdesk.diagnostics.debugLog`, event-loop stalls this long or longer are logged (at debug level). */
const STALL_DEBUG_MS = 100;

const heapLimitMB = () => Math.round(getHeapStatistics().heap_size_limit / MB);

interface Operation {
  label: string;
  start: number;
  /** Already named in a "still running" warning. */
  reported?: boolean;
}

/** DevDesk operations running now, named in memory and event-loop warnings. */
const running = new Map<number, Operation>();
let nextId = 0;

/**
 * Records how long `label` took (a command, a board render, a tmux call); one that took far longer than it usually does
 * (`devdesk.diagnostics.latencyOutlier*`) is logged with its usual time and the DevDesk operations in flight, so a slow
 * moment can be debugged later.
 */
export function noteLatency(label: string, ms: number): void {
  const now = Date.now();
  const o = latencies.record(label, ms, outlierRule, now);
  if (!o) return;
  const busy = inFlight(now);
  log.info(`slow: ${label} took ${Math.round(o.ms)}ms, usually ${Math.round(o.p50)}ms (p90 ${Math.round(o.p90)}ms, last ${o.samples})${busy.length ? `; DevDesk in flight: ${busy.join(', ')}` : ''}`);
}

const describeOp = (op: Operation, now: number) => `${op.label} ${Math.round((now - op.start) / 1000)}s`;

/** Labels of the running DevDesk operations with how long each has run, oldest first. */
function inFlight(now = Date.now()): string[] {
  return [...running.values()].map((op) => describeOp(op, now));
}

/** Registers a running operation; call the returned function when it ends. */
export function track(label: string): () => void {
  const id = nextId++;
  running.set(id, { label, start: Date.now() });
  return () => running.delete(id);
}

/**
 * Logs when the extension host's event loop was blocked, which delays every tree request and command, and every 10 s
 * the host's memory plus how many tree items VS Code asked for: at info level once the heap is big and as a warning
 * when it grows fast, with the DevDesk operations in flight. The host aborts when the heap reaches V8's limit; the
 * last of these lines before that shows how fast it grew and whether DevDesk was the one allocating.
 */
export function watchEventLoop(treeItemCalls: () => number, settings: () => DiagnosticsConfig): vscode.Disposable {
  const intervalMs = 1000;
  const limitMB = heapLimitMB();
  let last = Date.now();
  let ticks = 0;
  let lastCalls = 0;
  let prev: HeapSample | undefined;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - intervalMs;
    // With debugLog, shorter stalls show too: 100ms is already a key press that feels slow.
    if (lag > 500 || (debugAsInfo && lag >= STALL_DEBUG_MS)) {
      const busy = inFlight(now);
      log[lag > 500 ? 'warn' : 'debug'](`extension host event loop was blocked for ${lag}ms${busy.length ? `; DevDesk in flight: ${busy.join(', ')}` : ''}`);
    }
    last = now;
    if (++ticks % 10 === 0) {
      const s = settings();
      const slowMs = s.slowOperationSeconds * 1000;
      const slow = slowMs > 0 ? [...running.values()].filter((op) => !op.reported && now - op.start >= slowMs) : [];
      for (const op of slow) op.reported = true;
      if (slow.length) log.warn(`DevDesk operations still running: ${slow.map((op) => describeOp(op, now)).join(', ')}`);
      const mem = process.memoryUsage();
      const sample = { heapUsedMB: Math.round(mem.heapUsed / MB), rssMB: Math.round(mem.rss / MB) };
      const calls = treeItemCalls();
      const report = heapReport(
        prev,
        sample,
        10,
        { warnMB: s.heapWarnMB, growthMB: s.heapGrowthWarnMB, limitMB },
        inFlight(now),
        `, external ${Math.round(mem.external / MB)}MB, getTreeItem calls in last 10s: ${calls - lastCalls}`,
      );
      log[report.level](report.message);
      prev = sample;
      lastCalls = calls;
    }
  }, intervalMs);
  return { dispose: () => clearInterval(timer) };
}

let snapshotArmed = false;

/**
 * Makes the extension host leave evidence when it dies: a Node diagnostic report (native stack, heap spaces, resource
 * usage; no JavaScript stack on out-of-memory) in `dir` on any fatal error, and, when enabled, one V8 heap snapshot as
 * the heap nears its limit, which shows what filled it. Both apply to the whole extension host, so they also catch
 * other extensions. Node can arm the snapshot only once per process: turning the setting off takes a reload.
 */
export function applyCrashDiagnostics(c: DiagnosticsConfig): void {
  debugAsInfo = c.debugLog;
  outlierRule = { factor: c.latencyOutlierFactor, minMs: c.latencyOutlierMinMs };
  try {
    mkdirSync(c.dir, { recursive: true });
    process.report.directory = c.dir;
    process.report.reportOnFatalError = true;
    log.info(`extension host pid ${process.pid}: fatal-error reports go to ${c.dir}`);
  } catch (err) {
    log.warn(`cannot enable fatal-error reports in ${c.dir}: ${(err as Error).message}`);
  }
  if (c.heapSnapshotNearLimit && !snapshotArmed) {
    snapshotArmed = true;
    setHeapSnapshotNearHeapLimit(1);
    log.info(`a heap snapshot (Heap.*.heapsnapshot) is written to ${process.cwd()} if the heap nears its ${heapLimitMB()}MB limit`);
  }
}

const CLEAN_EVERY_MS = 6 * 60 * 60 * 1000;

/** Deletes old heap snapshots and fatal-error reports now and every 6 hours (`devdesk.diagnostics.keepDays`). */
export function cleanDiagnosticsRegularly(settings: () => DiagnosticsConfig): vscode.Disposable {
  const clean = async () => {
    const c = settings();
    const removed = await removeOldDiagnostics([process.cwd(), homedir(), c.dir], c.keepDays, Date.now());
    for (const r of removed) log.info(`deleted ${r.path} (${Math.round(r.bytes / (1024 * 1024))}MB), older than ${c.keepDays} days`);
  };
  const run = () => void clean().catch((err: Error) => log.warn(`cannot delete old diagnostics files: ${err.message}`));
  run();
  const timer = setInterval(run, CLEAN_EVERY_MS);
  return { dispose: () => clearInterval(timer) };
}

/** Runs `work` as a tracked operation, logging its start and duration at debug level and a failure as an error. */
export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const done = track(label);
  log.debug(`${label}: start`);
  try {
    const result = await work();
    log.debug(`${label}: done in ${Date.now() - start}ms`);
    noteLatency(label, Date.now() - start);
    return result;
  } catch (err) {
    log.error(`${label}: failed after ${Date.now() - start}ms: ${(err as Error).message}`);
    throw err;
  } finally {
    done();
  }
}

/**
 * `run` as a command handler that logs, at debug level, how long it took (until its promise settled), so a slow key
 * press or click in the Claude view or the board shows which command and how long.
 */
export function timedCommand<A extends unknown[], R>(id: string, run: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const start = Date.now();
    const done = track(`command ${id}`);
    const end = () => {
      done();
      log.debug(`command ${id}: ${Date.now() - start}ms`);
    };
    try {
      const result = run(...args);
      if (result instanceof Promise) void result.then(end, end);
      else end();
      return result;
    } catch (err) {
      end();
      throw err;
    }
  };
}

/** Registers a command whose duration is logged at debug level (`timedCommand`). */
export function registerTimedCommand(id: string, run: (...args: never[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, timedCommand(id, run as (...args: unknown[]) => unknown));
}

/** Times the steps of one operation: `mark(step)` ends a step; `describe()` lists them (`list 80ms, cards 3ms`). */
export function stepTimer(): { mark: (step: string) => void; total: () => number; describe: () => string } {
  const start = Date.now();
  let last = start;
  const steps: string[] = [];
  return {
    mark: (step) => {
      const now = Date.now();
      steps.push(`${step} ${now - last}ms`);
      last = now;
    },
    total: () => last - start,
    describe: () => steps.join(', '),
  };
}
