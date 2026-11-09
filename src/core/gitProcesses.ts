/** Above this many runnable processes per CPU (load average), background git work slows down. */
const BUSY_LOAD_PER_CPU = 1.5;

/**
 * How many git processes the Worktrees view runs at once for background loads, out of `max`
 * (`devdesk.worktrees.maxGitProcesses`): half of it, or a quarter while the machine is busy (`load1` / `cpus` above
 * 1.5), where more would only compete with builds for the CPUs; at least one.
 */
export function backgroundGitProcesses(max: number, load1: number, cpus: number): number {
  const busy = cpus > 0 && load1 / cpus > BUSY_LOAD_PER_CPU;
  return Math.max(1, Math.floor(max / (busy ? 4 : 2)));
}

