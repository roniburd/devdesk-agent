import { describe, expect, it } from 'vitest';
import { createPriorityLimiter } from '../src/core/limit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createPriorityLimiter', () => {
  it('starts foreground tasks before queued background ones, and promotes a background task', async () => {
    const run = createPriorityLimiter(1);
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await sleep(1);
    };
    const first = run(task('bg1'), true);
    const bg2 = run(task('bg2'), true);
    const bg3 = run(task('bg3'), true);
    run(task('fg'));
    bg3.promote();
    first.promote(); // already running: no effect
    await bg2.promise;
    expect(order).toEqual(['bg1', 'fg', 'bg3', 'bg2']);
  });

  it('never runs more than limit at once and frees slots on failure', async () => {
    const run = createPriorityLimiter(2);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, i) =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(3);
        active--;
        if (i === 0) throw new Error('boom');
        return i;
      }, i % 2 === 0).promise.catch((e: Error) => e.message),
    );
    expect(await Promise.all(tasks)).toEqual(['boom', 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('idle() settles once nothing runs or waits, at once when the pool is already idle', async () => {
    const run = createPriorityLimiter(1);
    await run.idle();
    const done: string[] = [];
    run(async () => {
      await sleep(5);
      done.push('a');
    });
    run(async () => {
      await sleep(5);
      done.push('b');
    }, true);
    await run.idle();
    expect(done).toEqual(['a', 'b']);
  });
});

describe('createPriorityLimiter with a background limit', () => {
  it('runs at most backgroundLimit background tasks, while foreground tasks may use every slot, and follows a changing limit', async () => {
    let bgLimit = 1;
    const run = createPriorityLimiter(() => 3, () => bgLimit);
    let active = 0;
    let bgPeak = 0;
    let peak = 0;
    const task = (bg: boolean) => async () => {
      active++;
      peak = Math.max(peak, active);
      if (bg) bgPeak = Math.max(bgPeak, active);
      await sleep(5);
      active--;
    };
    const bg = Array.from({ length: 4 }, () => run(task(true), true));
    const fg = Array.from({ length: 3 }, () => run(task(false)));
    await Promise.all([...bg, ...fg].map((j) => j.promise));
    expect(peak).toBeLessThanOrEqual(3);
    expect(bgPeak).toBeLessThanOrEqual(3);
    // Background alone: never more than its limit.
    active = 0;
    peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => run(task(true), true).promise));
    expect(peak).toBe(1);
    bgLimit = 2;
    peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => run(task(true), true).promise));
    expect(peak).toBe(2);
  });
});
