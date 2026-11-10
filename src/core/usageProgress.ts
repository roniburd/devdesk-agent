// How far a token usage count has got, in words, for the Claude Board's 📊 popover and the Claude Usage page (both
// webviews import it, bundled, so the numbers are in the webview's locale and the page's times go on between
// messages). Nothing here may need Node.

/** What the texts read of a count in progress (`CountProgress` in src/usageCount.ts). */
export interface CountPhase {
  phase: 'listing' | 'reading' | 'today';
  found: number;
  listed: number;
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}

const n = (v: number) => v.toLocaleString();

/** `512 MB`, `6.1 GB` */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * What the count is doing: `Listing <noun>: 900 found…`, `Checking which <noun> changed: 12 of 900…`, then
 * `Reading 12 of 340 transcripts…` (`withBytes`: `Reading 12 of 340 transcripts: 3.0 GB of 12.0 GB`), and
 * `Counting today…`.
 */
export function countHead(p: CountPhase, noun: string, withBytes = false): string {
  if (p.phase === 'listing') {
    if (p.listed && p.found) return `Checking which ${noun} changed: ${n(p.listed)} of ${n(p.found)}…`;
    return p.found ? `Listing ${noun}: ${n(p.found)} found…` : `Listing ${noun}…`;
  }
  if (p.phase === 'reading') return `Reading ${n(p.files)} of ${n(p.totalFiles)} transcripts${withBytes ? `: ${sizeText(p.bytes)} of ${sizeText(p.totalBytes)}` : '…'}`;
  return 'Counting today…';
}

/** `45 s` (with `seconds`; else at least `1 min`), `4 min`, `1 h 5 min` */
export function durationText(ms: number, seconds: boolean): string {
  let m: number;
  if (seconds) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    m = Math.round(s / 60);
  } else {
    m = Math.max(1, Math.round(ms / 60_000));
  }
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** `about 4 min left`, `less than a minute left`, or `unknown` while there is no estimate. */
export function timeLeftText(etaMs: number | undefined, seconds: boolean, unknown = ''): string {
  if (etaMs === undefined) return unknown;
  return etaMs < 60_000 ? 'less than a minute left' : `about ${durationText(etaMs, seconds)} left`;
}
