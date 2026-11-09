import { describe, expect, it } from 'vitest';
import { heapReport } from '../src/core/heapWatch';

const opts = { warnMB: 1500, growthMB: 300, limitMB: 4096 };

describe('heapReport', () => {
  it('is debug while the heap is small and steady', () => {
    const r = heapReport({ heapUsedMB: 400, rssMB: 700 }, { heapUsedMB: 420, rssMB: 720 }, 10, opts, ['getChildren(root)']);
    expect(r).toEqual({ level: 'debug', message: 'heap 420MB of 4096MB (+20MB in 10s), rss 720MB' });
  });

  it('warns on fast growth and names what DevDesk was doing', () => {
    const r = heapReport({ heapUsedMB: 400, rssMB: 700 }, { heapUsedMB: 900, rssMB: 1200 }, 10, opts, ['getChildren(feature a) 3s']);
    expect(r.level).toBe('warn');
    expect(r.message).toBe('heap 900MB of 4096MB (+500MB in 10s), rss 1200MB; DevDesk in flight: getChildren(feature a) 3s');
  });

  it('says when no DevDesk operation is in flight, so another extension is the allocator', () => {
    const r = heapReport({ heapUsedMB: 1600, rssMB: 1900 }, { heapUsedMB: 1610, rssMB: 1900 }, 10, opts, []);
    expect(r.level).toBe('info');
    expect(r.message).toContain('no DevDesk operation in flight');
  });

  it('reports shrinking heaps and the first sample without growth', () => {
    expect(heapReport({ heapUsedMB: 900, rssMB: 1000 }, { heapUsedMB: 500, rssMB: 1000 }, 10, opts, []).message).toContain('(-400MB in 10s)');
    expect(heapReport(undefined, { heapUsedMB: 500, rssMB: 1000 }, 10, opts, []).message).toContain('(+0MB in 10s)');
  });

  it('treats 0 thresholds as disabled', () => {
    const off = { ...opts, warnMB: 0, growthMB: 0 };
    expect(heapReport({ heapUsedMB: 0, rssMB: 0 }, { heapUsedMB: 3000, rssMB: 3000 }, 10, off, []).level).toBe('debug');
  });

  it('appends extra detail', () => {
    expect(heapReport(undefined, { heapUsedMB: 1, rssMB: 2 }, 10, opts, [], ', 5 getTreeItem calls').message).toBe(
      'heap 1MB of 4096MB (+0MB in 10s), rss 2MB, 5 getTreeItem calls',
    );
  });
});
