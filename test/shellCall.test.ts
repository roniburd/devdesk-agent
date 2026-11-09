import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInShell } from '../src/shellCall';
import { readTail } from '../src/core/transcriptTail';

describe('runInShell', () => {
  it('passes the input on stdin and returns stdout', async () => {
    expect(await runInShell('cat', 'hello', { timeoutMs: 10_000 })).toEqual({ stdout: 'hello' });
  });

  it('reports a non-zero exit with the last stderr line', async () => {
    const r = await runInShell("sh -c 'echo first >&2; echo boom >&2; exit 3'", '', { timeoutMs: 10_000 });
    expect(r.error).toBe('exited with 3: boom');
  });

  it('kills a call that runs past the timeout', async () => {
    const start = Date.now();
    const r = await runInShell('sleep 5', '', { timeoutMs: 300 });
    expect(r.error).toBe('timed out after 0.3s');
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('kills a call when its signal aborts', async () => {
    const ac = new AbortController();
    const p = runInShell('sleep 5', '', { timeoutMs: 10_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await p).error).toBe('cancelled');
  });

  it('does not start a call whose signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await runInShell('echo ran', '', { timeoutMs: 10_000, signal: ac.signal })).toEqual({ stdout: '', error: 'cancelled' });
  });
});

describe('readTail', () => {
  it('reads the last bytes, dropping the line cut in the middle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-'));
    const path = join(dir, 't.jsonl');
    writeFileSync(path, 'aaaaaaaaaa\nbbb\nccc\n');
    expect(await readTail(path, 9)).toEqual({ lines: ['bbb', 'ccc'], bytes: 19 });
    expect(await readTail(path, 1000)).toEqual({ lines: ['aaaaaaaaaa', 'bbb', 'ccc'], bytes: 19 });
  });

  it('is undefined for a missing file', async () => {
    expect(await readTail('/nonexistent/t.jsonl', 100)).toBeUndefined();
  });
});
