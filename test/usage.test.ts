import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cwdOf, firstTimestamp, formatTokens, parseUsageLine, UsageReader, UsageScan } from '../src/core/usage';

const NOW = Date.parse('2026-11-01T15:00:00Z');
const assistant = (requestId: string, at: string, usage: Record<string, number>, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', requestId, timestamp: at, message: { id: `m-${requestId}`, model, usage } });

describe('usage lines', () => {
  it('counts total and cached tokens of assistant lines', () => {
    expect(parseUsageLine(assistant('r1', '2026-11-01T10:00:00Z', { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 5 }))).toEqual([
      'r1',
      { at: Date.parse('2026-11-01T10:00:00Z'), model: 'claude-opus-5-5', total: 1035, cached: 1000 },
    ]);
    expect(parseUsageLine(JSON.stringify({ type: 'user', message: { content: 'usage' } }))).toBeUndefined();
    expect(parseUsageLine('{"usage": broken')).toBeUndefined();
  });

  it('counts a response split over lines once, and keeps a partial last line for later', () => {
    const scan = new UsageScan();
    const line = assistant('r1', '2026-11-01T10:00:00Z', { input_tokens: 10, output_tokens: 5 });
    scan.feed(Buffer.from(`${line}\n${line}\n${assistant('r2', '2026-11-01T11:00:00Z', { input_tokens: 1 }).slice(0, 20)}`));
    expect([...scan.entries.keys()]).toEqual(['r1']);
    scan.feed(Buffer.from(`${assistant('r2', '2026-11-01T11:00:00Z', { input_tokens: 1 }).slice(20)}\n`));
    expect([...scan.entries.keys()]).toEqual(['r1', 'r2']);
  });

  it('formats token counts', () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(12_345), formatTokens(4_560_000), formatTokens(45_600_000), formatTokens(1_221_300_000)]).toEqual(['950', '1.2k', '12k', '4.56M', '45.6M', '1.22B']);
  });
});

describe('UsageReader', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-usage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the transcripts changed since a time, subagents included, incrementally", async () => {
    const projects = join(dir, 'projects');
    const project = join(projects, '-w-x');
    await mkdir(join(project, 's1', 'subagents'), { recursive: true });
    const today = new Date(NOW).toISOString();
    await writeFile(join(project, 's1.jsonl'), `${assistant('r1', today, { input_tokens: 10, cache_read_input_tokens: 90 })}\n`);
    await writeFile(join(project, 's1', 'subagents', 'agent-a.jsonl'), `${assistant('r2', today, { output_tokens: 7 }, 'claude-haiku-5-5')}\n`);
    await writeFile(join(project, 'old.jsonl'), `${assistant('r3', today, { input_tokens: 5000 })}\n`);
    const since = Math.min(NOW, Date.now()) - 3600_000;
    const before = new Date(since - 3600_000);
    await utimes(join(project, 'old.jsonl'), before, before);
    const reader = new UsageReader();
    const ids = (scans: Map<string, UsageScan[]>) => [...scans].map(([id, list]) => [id, list.flatMap((s) => [...s.entries.keys()]).sort()]);
    let scans = await reader.scans(projects, since);
    expect(ids(scans)).toEqual([['s1', ['r1', 'r2']]]);
    const first = scans.get('s1')!;
    await appendFile(join(project, 's1.jsonl'), `${assistant('r4', today, { output_tokens: 3 })}\n`);
    scans = await reader.scans(projects, since);
    expect(ids(scans)).toEqual([['s1', ['r1', 'r2', 'r4']]]);
    // The same scans, fed only what was appended.
    expect(scans.get('s1')!.every((scan) => first.includes(scan))).toBe(true);
  });

  it("finds when a transcript started, past a subagent's long first prompt", async () => {
    const path = join(dir, 'agent.jsonl');
    // The timestamp ends a 49 KB first line, cut between two read chunks.
    await writeFile(path, `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(49_101) }, timestamp: '2026-10-30T13:30:52.921Z' })}\n`);
    expect(await firstTimestamp(path)).toBe(Date.parse('2026-10-30T13:30:52.921Z'));
    await writeFile(path, '{"type":"summary"}\n');
    expect(await firstTimestamp(path)).toBeUndefined();
    expect(await firstTimestamp(join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});

describe('cwd', () => {
  const usage = (id: string, cwd?: string) =>
    JSON.stringify({ type: 'assistant', requestId: id, timestamp: '2026-11-01T12:00:00Z', ...(cwd ? { cwd } : {}), message: { model: 'm', usage: { input_tokens: 1 } } });

  it('reads a line’s cwd without parsing it all', () => {
    expect(cwdOf(JSON.stringify({ type: 'user', cwd: '/w/a "b"' }))).toBe('/w/a "b"');
    expect(cwdOf(JSON.stringify({ type: 'user', message: { content: '"cwd":"x"' } }))).toBeUndefined();
    expect(cwdOf('{"type":"user","message":{"content":{"context":{"git_state":{"cwd":"/nested"}}}},"cwd":"/top"}')).toBe('/top');
    expect(cwdOf(JSON.stringify({ type: 'user', message: { content: [{ cwd: '/nested' }] } }))).toBeUndefined();
    expect(cwdOf(JSON.stringify({ type: 'user', message: { content: 'a "cwd":"x" { [' }, cwd: '/top' }))).toBe('/top');
    expect(parseUsageLine(usage('r1', '/w'))?.[1].cwd).toBe('/w');
    expect(parseUsageLine(usage('r1'))?.[1]).not.toHaveProperty('cwd');
  });

  it('gives a request without a cwd the last one the transcript recorded, and follows a cd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devdesk-cwd-'));
    try {
      const path = join(dir, 's.jsonl');
      writeFileSync(path, [usage('r0'), JSON.stringify({ type: 'user', cwd: '/w/a' }), usage('r1'), usage('r2', '/w/b'), usage('r3'), ''].join('\n'));
      const scan = await new UsageReader().read(path);
      expect([...scan.entries].map(([id, e]) => [id, e.cwd])).toEqual([
        ['r0', undefined],
        ['r1', '/w/a'],
        ['r2', '/w/b'],
        ['r3', '/w/b'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
