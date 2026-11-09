/**
 * The Worktrees view loads every package once (the prefetch), so the idle ones all come due for their timed reload
 * (`devdesk.worktrees.idleReloadMinutes`) at the same moment: hundreds of git loads in one burst. Reloading only the
 * oldest few on each tick spreads that work over the interval instead.
 */

/**
 * How many idle packages to reload on one tick: enough to get through all `idlePackages` in half of `idleMs`, so a
 * package waits at most about half an interval more than it would in one burst. No limit without ticks or reloads.
 */
export function idleReloadsPerTick(idlePackages: number, tickMs: number, idleMs: number): number {
  if (tickMs <= 0 || idleMs <= 0) return Infinity;
  return Math.ceil((idlePackages * tickMs) / (idleMs / 2));
}

/** The `count` entries loaded longest ago. */
export function oldestFirst<T extends { startedAt: number }>(due: readonly T[], count: number): T[] {
  return [...due].sort((a, b) => a.startedAt - b.startedAt).slice(0, count);
}
