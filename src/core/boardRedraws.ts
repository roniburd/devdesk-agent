/** One redraw of the board's webview, as its `rendered` message reports it. */
export interface Redraw {
  /** The webview's own script time: applying the board to the page. */
  scriptMs: number;
  /** Until the next frame was painted after it. */
  frameMs: number;
  /** Cards built again (the rest were left as shown), of `cards`. */
  rebuilt: number;
  cards: number;
}

/** How often the board's redraws are summed up in the log. */
export const REDRAW_SUMMARY_MS = 60_000;

/** The board's redraws since the last summary; `add` returns the next summary once `REDRAW_SUMMARY_MS` has passed. */
export class RedrawLog {
  private redraws: Redraw[] = [];

  constructor(private since: number) {}

  add(redraw: Redraw, now: number): string | undefined {
    this.redraws.push(redraw);
    if (now - this.since < REDRAW_SUMMARY_MS) return undefined;
    const line = summarizeRedraws(this.redraws, now - this.since);
    this.redraws = [];
    this.since = now;
    return line;
  }
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ms = (n: number) => `${Math.round(n * 10) / 10}ms`;

/** `board: 18 redraws in the last 60s; script median 2ms, max 9ms; painted median 8ms, max 21ms; cards rebuilt median 1, max 3; 91 cards shown`. */
export function summarizeRedraws(redraws: readonly Redraw[], windowMs: number): string {
  const of = (pick: (r: Redraw) => number) => redraws.map(pick);
  const stat = (values: number[], unit: (n: number) => string | number) => `median ${unit(median(values))}, max ${unit(Math.max(...values))}`;
  return (
    `board: ${redraws.length} redraw${redraws.length === 1 ? '' : 's'} in the last ${Math.round(windowMs / 1000)}s; ` +
    `script ${stat(of((r) => r.scriptMs), ms)}; painted ${stat(of((r) => r.frameMs), ms)}; ` +
    `cards rebuilt ${stat(of((r) => r.rebuilt), (n) => n)}; ${redraws[redraws.length - 1].cards} cards shown`
  );
}
