import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tickLoop } from '../src/core/tickLoop';

describe('tickLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A tick that ends only when `finish()` is called. */
  function manualTick() {
    let finish = () => {};
    const tick = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    return { tick, finish: () => finish() };
  }

  it('starts the next tick one interval after the previous one finished, never two at once', async () => {
    const { tick, finish } = manualTick();
    const loop = tickLoop({ intervalMs: () => 20_000, active: () => true, tick });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(1);
    // The tick takes 66 s: with setInterval three more would have started meanwhile.
    await vi.advanceTimersByTimeAsync(66_000);
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    loop.dispose();
  });

  it('pauses while inactive and, back after longer than the interval, ticks at once', async () => {
    let active = true;
    const tick = vi.fn(async () => {});
    const loop = tickLoop({ intervalMs: () => 20_000, active: () => active, tick });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(1);
    active = false;
    loop.update();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    active = true;
    loop.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(2);
    loop.dispose();
  });

  it('back after a short pause, waits only what is left of the interval', async () => {
    let active = true;
    const tick = vi.fn(async () => {});
    const loop = tickLoop({ intervalMs: () => 20_000, active: () => active, tick });
    await vi.advanceTimersByTimeAsync(5_000);
    active = false;
    loop.update();
    await vi.advanceTimersByTimeAsync(5_000);
    active = true;
    loop.update();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('applies a new interval, stops at 0, and skips a tick when it became inactive before it fired', async () => {
    let interval = 20_000;
    let active = true;
    const tick = vi.fn(async () => {});
    const loop = tickLoop({ intervalMs: () => interval, active: () => active, tick });
    interval = 60_000;
    loop.update();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    interval = 0;
    loop.update();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    interval = 20_000;
    loop.update();
    active = false; // without an update(): the timer fires, sees it, and does not tick
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('keeps going after a failed or hung tick', async () => {
    const problems: string[] = [];
    let calls = 0;
    const tick = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('boom'));
      return new Promise<void>(() => {}); // never settles
    });
    const loop = tickLoop({ intervalMs: () => 1_000, active: () => true, tick, maxTickMs: 5_000, onProblem: (m) => problems.push(m) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(problems).toEqual(['tick failed: boom']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(loop.running).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(problems[1]).toMatch(/still running after 5s/);
    expect(loop.running).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(3);
    loop.dispose();
  });

  it('waits a full interval again after work done outside the loop', async () => {
    const tick = vi.fn(async () => {});
    const loop = tickLoop({ intervalMs: () => 3000, active: () => true, tick });
    await vi.advanceTimersByTimeAsync(2000);
    loop.postpone();
    await vi.advanceTimersByTimeAsync(2999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    loop.dispose();
  });

  it('never ticks after dispose', async () => {
    const tick = vi.fn(async () => {});
    const loop = tickLoop({ intervalMs: () => 1_000, active: () => true, tick });
    loop.dispose();
    loop.update();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
