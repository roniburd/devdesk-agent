import { spawn } from 'node:child_process';
import type { Run, RunResult } from './checks';

/**
 * Runs `file` with `args` (no shell), keeping only the last `maxBytes` of its stdout (a failed log can be large) and
 * of its stderr, and killing it after `timeoutMs`. Never rejects.
 */
export const runBounded: Run = (file, args, o) =>
  new Promise<RunResult>((resolve) => {
    let out: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let err = '';
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message, missing: (e as NodeJS.ErrnoException).code === 'ENOENT' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout: Buffer.concat(out).toString('utf8'), stderr: `${err}\n${file} stopped after ${Math.round(o.timeoutMs / 1000)}s`.trim(), truncated });
    }, o.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out.push(chunk);
      outBytes += chunk.length;
      while (outBytes > o.maxBytes && out.length > 1) {
        outBytes -= out[0].length;
        out.shift();
        truncated = true;
      }
      if (outBytes > o.maxBytes) {
        out = [out[0].subarray(outBytes - o.maxBytes)];
        outBytes = o.maxBytes;
        truncated = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-64 * 1024);
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, stdout: '', stderr: e.message, missing: e.code === 'ENOENT' }));
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, truncated }));
  });
