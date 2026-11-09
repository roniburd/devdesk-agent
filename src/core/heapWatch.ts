/** One reading of the extension host's memory, in MB. */
export interface HeapSample {
  heapUsedMB: number;
  rssMB: number;
}

export interface HeapWatchOptions {
  /** Report at info level once the heap is at least this big (0 disables). */
  warnMB: number;
  /** Warn when the heap grew by at least this much since the previous sample (0 disables). */
  growthMB: number;
  /** V8's heap limit; the host aborts with an out-of-memory error when the heap reaches it. */
  limitMB: number;
}

export interface HeapReport {
  level: 'debug' | 'info' | 'warn';
  message: string;
}

/**
 * The line to log for one sampling window. The extension host is shared by every extension, so a heap that grows
 * fast or gets big is reported with the DevDesk operations in flight: if none are, another extension is allocating.
 */
export function heapReport(
  prev: HeapSample | undefined,
  now: HeapSample,
  windowSeconds: number,
  opts: HeapWatchOptions,
  inFlight: readonly string[],
  extra = '',
): HeapReport {
  const growth = prev ? now.heapUsedMB - prev.heapUsedMB : 0;
  const growing = opts.growthMB > 0 && growth >= opts.growthMB;
  const big = opts.warnMB > 0 && now.heapUsedMB >= opts.warnMB;
  const sign = growth >= 0 ? '+' : '';
  let message = `heap ${now.heapUsedMB}MB of ${opts.limitMB}MB (${sign}${growth}MB in ${windowSeconds}s), rss ${now.rssMB}MB${extra}`;
  if (growing || big) {
    message += inFlight.length ? `; DevDesk in flight: ${inFlight.join(', ')}` : '; no DevDesk operation in flight';
  }
  return { level: growing ? 'warn' : big ? 'info' : 'debug', message };
}
