import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeTitle, ForkParentReader, MetaReader, MetaScan, parkedJob, parseForkParent, parseRegistryEntry, readRegistry, registryFor } from '../src/core/sessionInfo';

const line = (o: object) => `${JSON.stringify(o)}\n`;

describe('parseRegistryEntry', () => {
  it('reads the name, its source and the start time', () => {
    expect(parseRegistryEntry('{"pid":5582,"sessionId":"s1","name":" VSCode Extension ","nameSource":"user","startedAt":17,"status":"idle"}')).toEqual({
      pid: 5582,
      sessionId: 's1',
      name: 'VSCode Extension',
      nameSource: 'user',
      startedAt: 17,
    });
  });

  it('reads the background job id', () => {
    expect(parseRegistryEntry('{"pid":5582,"sessionId":"s1","kind":"bg","jobId":"729559ef"}')?.jobId).toBe('729559ef');
  });

  it('rejects files without a pid or session id', () => {
    expect(parseRegistryEntry('{"sessionId":"s1"}')).toBeUndefined();
    expect(parseRegistryEntry('{"pid":1}')).toBeUndefined();
    expect(parseRegistryEntry('nope')).toBeUndefined();
  });
});

describe('readRegistry and registryFor', () => {
  it('reads <pid>.json files only, and matches by session id, then by pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'registry-'));
    await writeFile(join(dir, '10.json'), '{"pid":10,"sessionId":"a","name":"job-a","nameSource":"auto"}');
    await writeFile(join(dir, '11.json'), '{"pid":11,"sessionId":"b"}');
    await writeFile(join(dir, '10.abc.key'), 'secret');
    await writeFile(join(dir, '12.json'), 'garbage');
    const entries = await readRegistry(dir);
    expect(entries.map((e) => e.pid).sort()).toEqual([10, 11]);
    expect(registryFor(entries, 'a', undefined)?.pid).toBe(10);
    expect(registryFor(entries, 'cleared', 11)?.sessionId).toBe('b');
    expect(registryFor(entries, 'zzz', 99)).toBeUndefined();
    expect(await readRegistry(join(dir, 'missing'))).toEqual([]);
  });
});

describe('fork parents', () => {
  it('reads the session a /fork job was forked from', () => {
    expect(parseForkParent('{"state":"working","forkSessionId":"f1","forkParentSessionId":"p1"}')).toBe('p1');
    expect(parseForkParent('{"state":"working"}')).toBeUndefined();
    expect(parseForkParent('{"forkParentSessionId":""}')).toBeUndefined();
    expect(parseForkParent('nope')).toBeUndefined();
  });

  it('reads <jobs>/<job id>/state.json once per job, and retries jobs it could not read', async () => {
    const jobs = await mkdtemp(join(tmpdir(), 'jobs-'));
    const reader = new ForkParentReader();
    expect(await reader.read(jobs, 'j1')).toBeUndefined();
    await mkdir(join(jobs, 'j1'));
    await writeFile(join(jobs, 'j1', 'state.json'), '{"forkParentSessionId":"p1"}');
    expect(await reader.read(jobs, 'j1')).toBe('p1');
    await writeFile(join(jobs, 'j1', 'state.json'), '{"forkParentSessionId":"changed"}');
    expect(await reader.read(jobs, 'j1')).toBe('p1');
    await mkdir(join(jobs, 'j2'));
    await writeFile(join(jobs, 'j2', 'state.json'), '{"state":"working"}');
    expect(await reader.read(jobs, 'j2')).toBeUndefined();
    expect(await reader.read(jobs, '../j1')).toBeUndefined();
  });
});

describe('parkedJob', () => {
  it('finds the background job an interactive process shows', () => {
    const shell = parseRegistryEntry('{"pid":923195,"sessionId":"8b6d","kind":"interactive","name":"orders-76","nameSource":"derived","parkedJobId":"c1addc84"}');
    const job = parseRegistryEntry('{"pid":3132846,"sessionId":"c1addc84-90e3","kind":"bg","jobId":"c1addc84","name":"fix local UI findings","nameSource":"user"}');
    expect(shell?.parkedJobId).toBe('c1addc84');
    expect(job?.jobId).toBe('c1addc84');
    const entries = [shell!, job!];
    expect(parkedJob(entries, shell)).toBe(job);
    expect(parkedJob(entries, job)).toBeUndefined();
    expect(parkedJob([shell!], shell)).toBeUndefined(); // the job ended
    expect(parkedJob(entries, undefined)).toBeUndefined();
  });
});

describe('MetaScan', () => {
  it('keeps the latest titles and recap, and the first timestamp', () => {
    const scan = new MetaScan();
    scan.feed(
      Buffer.from(
        line({ type: 'permission-mode', permissionMode: 'default' }) +
          line({ type: 'user', timestamp: '2026-10-29T10:00:00.000Z', message: { content: 'hi' } }) +
          line({ type: 'ai-title', aiTitle: 'first title' }) +
          line({ type: 'system', subtype: 'away_summary', content: 'old recap', timestamp: '2026-10-29T11:00:00.000Z' }) +
          line({ type: 'ai-title', aiTitle: 'second title' }) +
          line({ type: 'system', subtype: 'away_summary', content: 'You fixed the bug.', timestamp: '2026-10-29T12:00:00.000Z' }),
      ),
    );
    expect(scan.meta).toEqual({
      startedAt: Date.parse('2026-10-29T10:00:00.000Z'),
      aiTitle: 'second title',
      summary: 'You fixed the bug.',
      summaryAt: Date.parse('2026-10-29T12:00:00.000Z'),
    });
  });

  it('keeps a line split across chunks, even inside a multi-byte character', () => {
    const scan = new MetaScan();
    const bytes = Buffer.from(line({ type: 'custom-title', customTitle: 'café ⑂ test' }));
    const cut = bytes.indexOf(Buffer.from('⑂')) + 1;
    scan.feed(bytes.subarray(0, cut));
    expect(scan.meta.customTitle).toBeUndefined();
    scan.feed(bytes.subarray(cut));
    expect(scan.meta.customTitle).toBe('café ⑂ test');
  });
});

describe('MetaReader', () => {
  it('reads only what was appended since the last read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'meta-'));
    const path = join(dir, 's.jsonl');
    await writeFile(path, line({ type: 'ai-title', aiTitle: 'auto' }));
    const reader = new MetaReader();
    expect((await reader.read(path))?.aiTitle).toBe('auto');
    await appendFile(path, line({ type: 'custom-title', customTitle: 'Renamed' }));
    expect(await reader.read(path)).toMatchObject({ aiTitle: 'auto', customTitle: 'Renamed' });
    expect(await reader.read(join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});

describe('claudeTitle', () => {
  const meta = { customTitle: 'from transcript', aiTitle: 'ai title' };

  it('prefers a /rename, then a job name, then Claude’s title', () => {
    expect(claudeTitle({ pid: 1, sessionId: 's', name: 'live rename', nameSource: 'user' }, meta)).toBe('live rename');
    expect(claudeTitle({ pid: 1, sessionId: 's', name: 'job-name', nameSource: 'auto' }, meta)).toBe('from transcript');
    expect(claudeTitle({ pid: 1, sessionId: 's', name: 'job-name', nameSource: 'auto' }, { aiTitle: 'ai title' })).toBe('job-name');
    expect(claudeTitle(undefined, { aiTitle: 'ai title' })).toBe('ai title');
  });

  it('never uses a name derived from the directory', () => {
    expect(claudeTitle({ pid: 1, sessionId: 's', name: 'devdesk-agents-92', nameSource: 'derived' }, { aiTitle: 'ai title' })).toBe('ai title');
    expect(claudeTitle({ pid: 1, sessionId: 's', name: 'devdesk-agents-92', nameSource: 'derived' }, undefined)).toBeUndefined();
  });
});
