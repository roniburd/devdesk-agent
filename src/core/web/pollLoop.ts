/** A loop that runs `tick` `ms` after the previous one finished, from start() to stop(). */
export interface PollLoop {
  /** Starts the loop; does nothing when it runs (a tick under way included). */
  start(): void;
  /** Stops it: a tick under way finishes, but nothing more is scheduled. */
  stop(): void;
}

/**
 * One tick at a time and one timer at most: a start() while a tick is under way (a client connecting while the
 * snapshot is read), even after a stop(), never starts a second chain. A tick that throws doesn't end the loop.
 */
export function pollLoop(tick: () => Promise<void>, ms: number): PollLoop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let wanted = false;
  const schedule = () => {
    timer = setTimeout(() => void run(), ms);
  };
  const run = async () => {
    timer = undefined;
    ticking = true;
    try {
      await tick();
    } catch {
      // The tick reports its own errors; the loop goes on.
    } finally {
      ticking = false;
    }
    if (wanted && !timer) schedule();
  };
  return {
    start: () => {
      wanted = true;
      if (!timer && !ticking) schedule();
    },
    stop: () => {
      wanted = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
