import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollLoop } from '../../src/core/web/pollLoop';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A tick that waits until release() each time, counting the calls. */
function slowTick() {
  let calls = 0;
  let waiting: Array<() => void> = [];
  return {
    tick: () => {
      calls++;
      return new Promise<void>((r) => waiting.push(r));
    },
    release: async () => {
      const w = waiting;
      waiting = [];
      for (const r of w) r();
      await vi.advanceTimersByTimeAsync(0);
    },
    get calls() {
      return calls;
    },
  };
}

describe('pollLoop', () => {
  it('ticks every ms from start to stop', async () => {
    const tick = vi.fn(async () => undefined);
    const loop = pollLoop(tick, 100);
    loop.start();
    loop.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(tick).toHaveBeenCalledTimes(3);
    loop.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('keeps one chain when start() comes during a tick', async () => {
    const t = slowTick();
    const loop = pollLoop(t.tick, 100);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(t.calls).toBe(1);
    loop.start();
    await t.release();
    for (let i = 2; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
      expect(t.calls).toBe(i);
      await t.release();
    }
  });

  it('keeps one chain when stop() and start() both come during a tick', async () => {
    const t = slowTick();
    const loop = pollLoop(t.tick, 100);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    loop.stop();
    loop.start();
    await t.release();
    for (let i = 2; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
      expect(t.calls).toBe(i);
      await t.release();
    }
  });

  it('does not go on after stop() during a tick', async () => {
    const t = slowTick();
    const loop = pollLoop(t.tick, 100);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    loop.stop();
    await t.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls).toBe(1);
  });

  it('goes on after a tick that throws', async () => {
    const tick = vi.fn(async () => {
      throw new Error('tmux');
    });
    const loop = pollLoop(tick, 100);
    loop.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(tick).toHaveBeenCalledTimes(3);
    loop.stop();
  });
});
