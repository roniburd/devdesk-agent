import { spawn } from 'node:child_process';
import { firstHttpsUrl, LastLine, TUNNEL_URL_TIMEOUT_MS } from '../core/web/tunnel';

/**
 * Runs the tunnel command (`devdesk.web.tunnelCommand`, placeholders filled) in `/bin/sh`, in a process group of its
 * own so stopping it stops what it started. The first https URL it prints (stdout or stderr) is the public URL. It is
 * down when it exits, or prints no URL within `timeoutMs` (then it is stopped): `onDown` gets its last stderr line.
 */

export interface TunnelEvents {
  onUrl(url: string): void;
  onDown(error: string): void;
}

/** Output kept per stream while looking for the URL. */
const SCAN_MAX = 64 * 1024;

export function runTunnel(command: string, ev: TunnelEvents, timeoutMs = TUNNEL_URL_TIMEOUT_MS): { pid?: number; stop(): void } {
  const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lastErr = new LastLine();
  const lastOut = new LastLine();
  let url: string | undefined;
  let done = false;
  const pending = { stdout: '', stderr: '' };

  const down = (error: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ev.onDown(error);
  };
  const killGroup = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };
  /** Looks for the URL in complete lines (a URL cut between two chunks is not taken for a shorter one). */
  const scan = (stream: 'stdout' | 'stderr', chunk: string, final = false) => {
    if (url || done) return;
    const text = (pending[stream] + chunk).slice(-SCAN_MAX);
    const end = final ? text.length : text.lastIndexOf('\n') + 1;
    pending[stream] = text.slice(end);
    const found = firstHttpsUrl(text.slice(0, end));
    if (!found) return;
    url = found;
    clearTimeout(timer);
    ev.onUrl(found);
  };

  child.stdout.setEncoding('utf8').on('data', (c: string) => {
    lastOut.push(c);
    scan('stdout', c);
  });
  child.stderr.setEncoding('utf8').on('data', (c: string) => {
    lastErr.push(c);
    scan('stderr', c);
  });
  child.on('error', (err) => down(`the tunnel command could not start: ${err.message}`));
  child.on('close', (code, signal) => {
    scan('stdout', '', true);
    scan('stderr', '', true);
    down(lastErr.value || lastOut.value || `the tunnel command exited (${signal ?? `code ${code}`})`);
  });
  const timer = setTimeout(() => {
    if (url) return;
    killGroup();
    down(`no URL within ${Math.round(timeoutMs / 1000)} s${lastErr.value ? `: ${lastErr.value}` : ''}`);
  }, timeoutMs);
  timer.unref();

  return {
    pid: child.pid,
    stop() {
      done = true;
      clearTimeout(timer);
      killGroup();
    },
  };
}
