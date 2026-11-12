import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webBuild } from '../../scripts/webBuild.mjs';
import type { HookRecord } from '../../src/core/sessions';
import { type DaemonConfig, defaultDaemonConfig, resolveWebSettings } from '../../src/core/web/config';
import { EXIT_BAD_CONFIG, EXIT_PORT_IN_USE, parseWebState, type WebState } from '../../src/core/web/webState';
import { runTunnel } from '../../src/web/tunnel';
import { EMPTY_SCREEN, paneLine } from './fakes';

/**
 * The web access daemon as it ships: dist/web.js built into a temporary folder, run with plain Node against a fake tmux
 * (fixtures/fake-tmux.mjs) and a hook record for a fake Claude (a `claude` process: `sleep` through a symlink), and
 * driven over HTTP.
 */

const ROOT = join(__dirname, '..', '..');
const USER_HEADER = 'x-test-user';

let tmp: string;
let webJs: string;
let tmuxBin: string;
let repo: string;
let tmuxLog: string;
let tmuxState: string;
let claude: ChildProcess;
const daemons: ChildProcess[] = [];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const readState = async (stateDir: string) => {
  const text = await readFile(join(stateDir, 'web', 'web.json'), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : parseWebState(text);
};

interface Daemon {
  child: ChildProcess;
  port: number;
  stateDir: string;
  state: WebState;
  stderr: () => string;
}

/** Starts `node web.js --config <file>` with `over` on the config, waits for its web.json. */
async function startDaemon(over: Partial<DaemonConfig> = {}, env: Record<string, string> = {}): Promise<Daemon> {
  const stateDir = await mkdtemp(join(tmp, 'state-'));
  const port = over.port ?? (await freePort());
  const record: HookRecord = {
    sessionId: 'sess-1',
    pid: claude.pid,
    tmuxSession: 'cc-repo',
    tmuxPane: '%1',
    tmuxServer: 'devdesk',
    cwd: repo,
    event: 'Stop',
    state: 'done',
    detail: 'Finished',
    updatedAt: Date.now() - 1000,
  };
  await writeFile(join(stateDir, 'sess-1.json'), JSON.stringify(record));
  const config: DaemonConfig = {
    ...defaultDaemonConfig(tmp, 'roni'),
    stateDir,
    webDir: join(stateDir, 'web'),
    root: repo,
    scopeDirs: [repo],
    scope: 'workspace',
    claudeSessionsDirs: [join(tmp, 'no-registry')],
    insights: false,
    identityHeader: USER_HEADER,
    allowedUsers: ['roni'],
    pollMs: 500,
    tmux: { bin: tmuxBin, server: 'devdesk', options: [], env: {} },
    ...over,
    port,
  };
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [webJs, '--config', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DEVDESK_FAKE_TMUX_LOG: tmuxLog, DEVDESK_FAKE_TMUX_STATE: tmuxState, ...env },
  });
  daemons.push(child);
  let err = '';
  child.stderr?.setEncoding('utf8').on('data', (c: string) => (err += c));
  const state = await until('web.json', async () => {
    if (child.exitCode !== null) throw new Error(`the daemon exited ${child.exitCode}: ${err}`);
    const s = await readState(stateDir);
    return s?.pid === child.pid ? s : undefined;
  });
  return { child, port, stateDir, state, stderr: () => err };
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', (code) => resolve(code))));

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One HTTP request to the daemon (node:http, so Host can be set). */
function call(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

const as = (user: string) => ({ [USER_HEADER]: user });
const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(port, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...as('roni'), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const tmuxCalls = async () =>
  (await readFile(tmuxLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as string[]).join(' '));

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'web-daemon-'));
  const out = join(tmp, 'out');
  await webBuild(ROOT, { outdir: out });
  webJs = join(out, 'web.js');
  // The fake Claude: a process ps names `claude`.
  await symlink('/bin/sleep', join(tmp, 'claude'));
  claude = spawn(join(tmp, 'claude'), ['600'], { stdio: 'ignore' });
  repo = join(tmp, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  tmuxBin = join(tmp, 'tmux');
  await writeFile(tmuxBin, `#!/bin/sh\nexec '${process.execPath}' '${join(__dirname, 'fixtures', 'fake-tmux.mjs')}' "$@"\n`);
  await chmod(tmuxBin, 0o755);
  tmuxLog = join(tmp, 'tmux.log');
  tmuxState = join(tmp, 'tmux.json');
  await writeFile(
    tmuxState,
    JSON.stringify({ panes: [paneLine({ session: 'cc-repo', pane: '%1', pid: claude.pid!, command: 'claude', cwd: repo })], capture: EMPTY_SCREEN, pid: claude.pid }),
  );
}, 60_000);

afterAll(async () => {
  for (const d of daemons) if (d.exitCode === null) d.kill('SIGKILL');
  claude?.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
});

describe('web access daemon (header auth, tunnel)', () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon({ tunnelCommand: 'echo https://tunnel.example/x; sleep 30' });
  }, 30_000);

  it('writes web.json for itself on 127.0.0.1', () => {
    expect(d.state).toMatchObject({ version: 1, host: '127.0.0.1', port: d.port, pid: d.child.pid });
  });

  it('listens on loopback only', async () => {
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal && a.family === 'IPv4')
      .map((a) => a!.address);
    // A firewall may drop the packets instead of refusing: no answer within 2 s is not a listener either.
    const results = await Promise.all(
      [...others, '::1'].map(
        (host) =>
          new Promise<[string, string | undefined]>((resolve) => {
            const s = connect({ host, port: d.port });
            s.setTimeout(2000, () => {
              s.destroy();
              resolve([host, 'ETIMEDOUT']);
            });
            s.once('connect', () => {
              s.destroy();
              resolve([host, 'connected']);
            });
            s.once('error', (e: NodeJS.ErrnoException) => resolve([host, e.code]));
          }),
      ),
    );
    for (const [host, code] of results) expect(code, `connecting on ${host}`).toMatch(/ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/);
  });

  it('lets in only the allowed user', async () => {
    const none = await call(d.port, { path: '/api/sessions' });
    expect(none.status).toBe(403);
    const page = await call(d.port, { path: '/' });
    expect(page.status).toBe(403);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('devdesk.web.identityHeader');
    expect(page.body).not.toContain('roni');
    expect((await call(d.port, { path: '/api/sessions', headers: as('mallory') })).status).toBe(403);
    expect((await call(d.port, { path: '/api/sessions', headers: as('Roni') })).status).toBe(403);
    const ok = await call(d.port, { path: '/api/sessions', headers: as('roni') });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/json; charset=utf-8');
    const cards = JSON.parse(ok.body).cards as { id: string; pane?: string; canSend: boolean }[];
    expect(cards).toEqual([expect.objectContaining({ id: 'sess-1', pane: '%1', canSend: true })]);
  });

  it('serves the default view, the terminal script, and guards the terminal routes', async () => {
    const settings = await call(d.port, { path: '/api/settings', headers: as('roni') });
    expect(JSON.parse(settings.body)).toEqual({ sessionView: 'transcript' });
    expect((await call(d.port, { path: '/api/settings' })).status).toBe(403);
    const js = await call(d.port, { path: '/term.js', headers: as('roni') });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.body).toContain('DevdeskXterm');
    expect((await call(d.port, { path: '/term.css', headers: as('roni') })).body).toContain('.xterm');
    // The stream resizes the session's window: not from another site, nor for anyone not allowed.
    const cross = await call(d.port, { path: '/api/sessions/sess-1/term?cols=40&rows=20', headers: { ...as('roni'), 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(403);
    expect((await call(d.port, { path: '/api/sessions/sess-1/term' })).status).toBe(403);
    // Input needs the page's Origin, and an open terminal.
    expect((await post(d.port, '/api/sessions/sess-1/term/input', { term: 'abcdefgh1234', data: 'x' }, { origin: 'http://evil.example' })).status).toBe(403);
    const closed = await post(d.port, '/api/sessions/sess-1/term/input', { term: 'abcdefgh1234', data: 'x' });
    expect(closed.status, closed.body).toBe(410);
    expect(await tmuxCalls()).not.toContainEqual(expect.stringMatching(/-H/));
  });

  it('refuses a Host it does not answer on', async () => {
    const r = await call(d.port, { path: '/api/sessions', headers: { ...as('roni'), host: 'evil.example' } });
    expect(r.status).toBe(403);
  });

  it('checks Origin and Content-Type before typing, then types and submits', async () => {
    const noOrigin = await call(d.port, {
      method: 'POST',
      path: '/api/sessions/sess-1/send',
      headers: { ...as('roni'), 'content-type': 'application/json' },
      body: '{"text":"hello"}',
    });
    expect(noOrigin.status).toBe(403);
    expect((await post(d.port, '/api/sessions/sess-1/send', { text: 'hello' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(d.port, '/api/sessions/sess-1/send', { text: 'hello' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(await tmuxCalls()).not.toContainEqual(expect.stringMatching(/^send-keys/));
    const ok = await post(d.port, '/api/sessions/sess-1/send', { text: 'hello' });
    expect(ok.status, ok.body).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    // Pasted through a tmux buffer of its own, as the Claude Board types, then Enter.
    const sent = (await tmuxCalls()).filter((c) => /^(load-buffer|paste-buffer|send-keys)/.test(c));
    expect(sent).toEqual([
      expect.stringMatching(/^load-buffer -b devdesk-send-\w+ /),
      expect.stringMatching(/^paste-buffer -d -p -b devdesk-send-\w+ -t %1$/),
      'send-keys -t %1 Enter',
    ]);
    expect(d.stderr()).toMatch(/POST send sess-1 200 user=roni/);
    expect(d.stderr()).not.toContain('hello');
  });

  it('presses only the fixed keys', async () => {
    expect((await post(d.port, '/api/sessions/sess-1/key', { key: 'Escape' })).status).toBe(200);
    expect(await tmuxCalls()).toContain('send-keys -t %1 Escape');
    expect((await post(d.port, '/api/sessions/sess-1/key', { key: 'C-c' })).status).toBe(400);
    expect(await tmuxCalls()).not.toContain('send-keys -t %1 C-c');
  });

  it('404s an unknown session and 405s a wrong method', async () => {
    expect((await post(d.port, '/api/sessions/nope/key', { key: 'Enter' })).status).toBe(404);
    expect((await call(d.port, { path: '/api/sessions/nope', headers: as('roni') })).status).toBe(404);
    expect((await call(d.port, { method: 'DELETE', path: '/api/sessions', headers: as('roni') })).status).toBe(405);
  });

  it('refuses a body over 128 KiB', async () => {
    const r = await post(d.port, '/api/sessions/sess-1/send', JSON.stringify({ text: 'x'.repeat(200 * 1024) }));
    expect(r.status).toBe(413);
  });

  it('serves the session detail', async () => {
    const r = await call(d.port, { path: '/api/sessions/sess-1', headers: as('roni') });
    expect(r.status).toBe(200);
    const detail = JSON.parse(r.body);
    expect(detail).toMatchObject({ card: { id: 'sess-1' }, ended: false, prompt: { empty: true } });
    expect(detail.screen.length).toBeGreaterThan(0);
  });

  it('lists the folders', async () => {
    const r = await call(d.port, { path: '/api/folders', headers: as('roni') });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).folders).toEqual([expect.objectContaining({ dir: repo, isMain: true })]);
  });

  it('streams the cards', async () => {
    const text = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: d.port, path: '/api/events', headers: as('roni') }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
        expect(res.headers['x-accel-buffering']).toBe('no');
        expect(res.headers['cache-control']).toBe('no-store');
        let got = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          got += c;
          if (got.includes('\n\n')) {
            req.destroy();
            resolve(got);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(text).toMatch(/^event: cards\ndata: /);
    expect(JSON.parse(text.split('\n')[1].slice('data: '.length)).cards[0].id).toBe('sess-1');
  });

  it('sends the security headers with the page and its assets', async () => {
    for (const path of ['/', '/app.js', '/app.css']) {
      const r = await call(d.port, { path, headers: as('roni') });
      expect(r.status, path).toBe(200);
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
    expect((await call(d.port, { path: '/', headers: as('roni') })).body).toContain('app.js');
  });

  it('records the tunnel URL and answers on its host', async () => {
    const s = await until('tunnel up', async () => {
      const st = await readState(d.stateDir);
      return st?.tunnel === 'up' ? st : undefined;
    });
    expect(s.url).toBe('https://tunnel.example/x');
    expect(s.tunnelPid).toBeGreaterThan(0);
    expect((await call(d.port, { path: '/api/sessions', headers: { ...as('roni'), host: 'tunnel.example' } })).status).toBe(200);
  });

  it('restarts the tunnel on SIGUSR1', async () => {
    const before = (await readState(d.stateDir))!.tunnelPid!;
    d.child.kill('SIGUSR1');
    const after = await until('a new tunnel', async () => {
      const st = await readState(d.stateDir);
      return st?.tunnel === 'up' && st.tunnelPid !== before ? st : undefined;
    });
    expect(after.pid).toBe(d.child.pid);
    await until('the old tunnel gone', () => (alive(before) ? undefined : true));
  });

  it('exits 3 when its port is taken', async () => {
    const child = spawn(process.execPath, [webJs, '--auth', 'loopback', '--port', String(d.port), '--state-dir', join(tmp, 'second')], {
      stdio: 'ignore',
    });
    daemons.push(child);
    expect(await exited(child)).toBe(EXIT_PORT_IN_USE);
  });

  it('removes web.json and stops the tunnel on SIGTERM', async () => {
    const tunnelPid = (await readState(d.stateDir))!.tunnelPid!;
    d.child.kill('SIGTERM');
    expect(await exited(d.child)).toBe(0);
    expect(await readState(d.stateDir)).toBeUndefined();
    await until('the tunnel gone', () => (alive(tunnelPid) ? undefined : true));
  });
});

describe('web access daemon (fail closed, loopback, tunnel down)', () => {
  it('denies everyone when no user is allowed', async () => {
    const d = await startDaemon({ allowedUsers: [] });
    const r = await call(d.port, { path: '/api/sessions', headers: as('roni') });
    expect(r.status).toBe(403);
    expect((await call(d.port, { path: '/', headers: as('roni') })).body).toContain('devdesk.web.allowedUsers');
    d.child.kill('SIGTERM');
    await exited(d.child);
  });

  it('needs no header in loopback mode, and answers only on loopback hosts', async () => {
    const d = await startDaemon({ auth: 'loopback', identityHeader: '', allowedUsers: [] });
    expect((await call(d.port, { path: '/api/sessions' })).status).toBe(200);
    expect((await call(d.port, { path: '/api/sessions', headers: { host: 'me.example.com' } })).status).toBe(403);
    d.child.kill('SIGTERM');
    expect(await exited(d.child)).toBe(0);
  });

  it('refuses to start in loopback mode with a tunnel command or a public host', async () => {
    for (const flag of [['--tunnel-command', 'echo https://tunnel.example/x; sleep 30'], ['--public-host', 'me.example.com']]) {
      const child = spawn(process.execPath, [webJs, '--auth', 'loopback', ...flag, '--port', String(await freePort()), '--state-dir', join(tmp, 'conflict')], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      daemons.push(child);
      let err = '';
      child.stderr?.setEncoding('utf8').on('data', (c: string) => (err += c));
      expect(await exited(child)).toBe(EXIT_BAD_CONFIG);
      expect(err).toContain("devdesk.web.auth 'loopback'");
    }
  });

  it('reports a tunnel that fails', async () => {
    const d = await startDaemon({ tunnelCommand: 'echo starting; echo boom >&2; exit 1' });
    expect((await call(d.port, { path: '/api/sessions', headers: as('roni') })).status).toBe(200);
    const s = await until('tunnel down', async () => {
      const st = await readState(d.stateDir);
      return st?.tunnel === 'down' ? st : undefined;
    });
    expect(s.tunnelError).toBe('boom');
    expect(s.url).toBeUndefined();
    expect((await call(d.port, { path: '/api/sessions', headers: as('roni') })).status).toBe(200);
    d.child.kill('SIGTERM');
    expect(await exited(d.child)).toBe(0);
  });
});

describe('runTunnel', () => {
  const events = (command: string, timeoutMs?: number) =>
    new Promise<{ url?: string; down?: string; pid?: number }>((resolve) => {
      const t = runTunnel(
        command,
        {
          onUrl: (url) => {
            t.stop();
            resolve({ url, pid: t.pid });
          },
          onDown: (down) => resolve({ down, pid: t.pid }),
        },
        timeoutMs,
      );
    });

  it('takes a URL printed in pieces whole', async () => {
    const r = await events("printf 'ready at https://a.exa'; sleep 0.2; printf 'mple/x\\n'; sleep 30");
    expect(r.url).toBe('https://a.example/x');
    await until('the tunnel stopped', () => (alive(r.pid!) ? undefined : true));
  });

  it('skips URLs the rules do not take, reports action links once, and takes a ready line', async () => {
    const actions: string[] = [];
    const r = await new Promise<{ url?: string; down?: string }>((resolve) => {
      const t = runTunnel(
        'echo https://docs.example/a; echo https://act.example/x; echo https://act.example/x; echo https://me.ts.net/; sleep 30',
        { onUrl: (url) => (t.stop(), resolve({ url })), onDown: (down) => resolve({ down }), onAction: (u) => actions.push(u) },
        undefined,
        { classify: (u) => (u.includes('ts.net') ? 'url' : u.includes('act.') ? 'action' : 'other') },
      );
    });
    expect(r.url).toBe('https://me.ts.net/');
    expect(actions).toEqual(['https://act.example/x']);
    const ready = await new Promise<{ url?: string }>((resolve) => {
      const t = runTunnel('echo https://docs.example/a >&2; echo "Registered tunnel connection" >&2; sleep 30', { onUrl: (url) => (t.stop(), resolve({ url })), onDown: () => resolve({}) }, undefined, {
        classify: () => 'other',
        ready: /Registered tunnel connection/,
        readyUrl: 'https://d.example.com/',
      });
    });
    expect(ready.url).toBe('https://d.example.com/');
  });

  it('is down, and stopped, when no URL comes in time', async () => {
    const r = await events('echo waiting >&2; sleep 30', 300);
    expect(r.down).toMatch(/^no URL within .*: waiting$/);
    await until('the tunnel stopped', () => (alive(r.pid!) ? undefined : true));
  });
});

describe('web access daemon (tunnel presets, with fake tools on PATH)', () => {
  let bin = '';
  const PATH = () => ({ PATH: `${bin}:${process.env.PATH}` });
  const tool = async (name: string, script: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, name), 0o755);
  };
  /** The settings a preset resolves to, for the daemon config. */
  const preset = (s: Record<string, unknown>) => {
    const { port: _, ...r } = resolveWebSettings({ port: undefined, auth: undefined, identityHeader: '', allowedUsers: [], publicHost: '', tunnelCommand: '', pollMs: 500, ...s }, { user: 'roni' });
    return r;
  };
  const stateOf = (d: Daemon, f: (s: WebState) => boolean) =>
    until('web.json', async () => {
      const s = await readState(d.stateDir);
      return s && f(s) ? s : undefined;
    });

  beforeAll(async () => {
    bin = await mkdtemp(join(tmp, 'bin-'));
    // Serve's first run on a tailnet without HTTPS: a link to turn it on, then the URL.
    await tool('tailscale', 'echo "To enable, visit: https://login.tailscale.com/f/serve?node=n1"; echo "see https://tailscale.com/kb/1312/serve"; sleep 1; echo "Available within your tailnet:"; echo "https://mac.tail1.ts.net/"; sleep 30');
    await tool('devtunnel', 'echo "Connect via browser: https://inspect9-$3-inspect.usw2.devtunnels.ms"; echo "Connect via browser: https://abc1-$3.usw2.devtunnels.ms"; sleep 30');
    await tool('cloudflared', 'case "$2" in run) echo "see https://developers.cloudflare.com/x" >&2; echo "INF Registered tunnel connection connIndex=0" >&2; sleep 30;; *) exit 0;; esac');
    await tool('ngrok', 'cp "$4" "$(dirname "$4")/policy-seen.yml"; echo \'msg="started tunnel" url=https://abc.ngrok-free.app\'; sleep 30');
  });

  it('tailscale: shows the link to open, then comes up on its ts.net URL and lets in only the login', async () => {
    const d = await startDaemon(preset({ tunnel: 'tailscale', allowedUsers: ['me@github'] }), PATH());
    const asked = await stateOf(d, (s) => !!s.tunnelAction || s.tunnel === 'up');
    expect(asked.tunnelAction ?? '').toMatch(/^https:\/\/login\.tailscale\.com\/f\/serve/);
    const up = await stateOf(d, (s) => s.tunnel === 'up');
    expect(up.url).toBe('https://mac.tail1.ts.net/');
    expect(up.tunnelAction).toBeUndefined();
    const via = { host: 'mac.tail1.ts.net' };
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, 'tailscale-user-login': 'me@github' } })).status).toBe(200);
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, 'tailscale-user-login': 'you@github' } })).status).toBe(403);
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, [USER_HEADER]: 'roni' } })).status).toBe(403);
  }, 30_000);

  it('devtunnel: comes up on the browser URL (not inspect) and checks no one itself', async () => {
    const d = await startDaemon(preset({ tunnel: 'devtunnel' }), PATH());
    const up = await stateOf(d, (s) => s.tunnel === 'up');
    expect(up.url).toBe(`https://abc1-${d.port}.usw2.devtunnels.ms`);
    expect((await call(d.port, { path: '/api/sessions', headers: { host: `abc1-${d.port}.usw2.devtunnels.ms` } })).status).toBe(200);
    expect((await call(d.port, { path: '/api/sessions', headers: { host: 'evil.example' } })).status).toBe(403);
  }, 30_000);

  it('cloudflare: up on the public host once connected, and denies all without a verified Access token', async () => {
    const d = await startDaemon(preset({ tunnel: 'cloudflare', publicHost: 'd.example.com', allowedUsers: ['me@example.com'], cloudflareTeam: 'devdesk-e2e-none', cloudflareAudience: 'a'.repeat(64) }), PATH());
    const up = await stateOf(d, (s) => s.tunnel === 'up');
    expect(up.url).toBe('https://d.example.com/');
    const via = { host: 'd.example.com' };
    expect((await call(d.port, { path: '/api/sessions', headers: via })).status).toBe(403);
    // The email header alone is never trusted, nor a token no key signed.
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, 'cf-access-authenticated-user-email': 'me@example.com' } })).status).toBe(403);
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, 'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln' } })).status).toBe(403);
  }, 30_000);

  it('ngrok: writes its private policy, comes up, and lets in only the email the policy names', async () => {
    const d = await startDaemon(preset({ tunnel: 'ngrok', allowedUsers: ['me@example.com'], ngrokProvider: 'github' }), PATH());
    const up = await stateOf(d, (s) => s.tunnel === 'up');
    expect(up.url).toBe('https://abc.ngrok-free.app');
    const policy = await readFile(join(d.stateDir, 'web', 'policy-seen.yml'), 'utf8');
    expect(policy).toContain("['me@example.com']");
    expect(policy).toContain('provider: github');
    const { stat } = await import('node:fs/promises');
    expect(((await stat(join(d.stateDir, 'web', 'ngrok-policy.yml'))).mode & 0o777).toString(8)).toBe('600');
    const via = { host: 'abc.ngrok-free.app' };
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, 'x-devdesk-user': 'me@example.com' } })).status).toBe(200);
    expect((await call(d.port, { path: '/api/sessions', headers: { ...via, 'x-devdesk-user': 'you@example.com' } })).status).toBe(403);
  }, 30_000);
});
