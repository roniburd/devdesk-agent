import { tmpdir } from 'node:os';
import { spawnLoginShell } from './core/shellRun';

/**
 * Runs `command` through a login shell in a neutral directory, with `input` on stdin: DevDesk's headless model calls
 * (insights, board search). Killed after `timeoutMs`, or when `signal` aborts (error `cancelled`).
 */
export function runInShell(command: string, input: string, o: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; error?: string }> {
  if (o.signal?.aborted) return Promise.resolve({ stdout: '', error: 'cancelled' });
  return new Promise((resolve) => {
    const child = spawnLoginShell(command, tmpdir());
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    const onAbort = () => child.kill();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      done();
      resolve({ stdout, error: err.message });
    });
    child.on('close', (code, signal) => {
      done();
      if (o.signal?.aborted) return resolve({ stdout, error: 'cancelled' });
      const why = timedOut || signal
        ? `timed out after ${o.timeoutMs / 1000}s`
        : code
          ? `exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`
          : undefined;
      resolve({ stdout, ...(why && !stdout.includes('"result"') ? { error: why } : {}) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
