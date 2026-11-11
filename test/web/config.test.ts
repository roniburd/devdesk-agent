import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_PORT,
  defaultDaemonConfig,
  fillTunnelCommand,
  shortHostName,
  parseDaemonArgs,
  parseDaemonConfig,
  resolveWebSettings,
  type WebProviderDefaults,
  type WebSettings,
} from '../../src/core/web/config';

const empty: WebSettings = { port: undefined, auth: undefined, identityHeader: '', allowedUsers: [], publicHost: '', tunnelCommand: '', pollMs: undefined };
const provider: WebProviderDefaults = { tunnelCommand: 'expose {port} --as {user}', identityHeader: 'X-Proxy-User' };

describe('resolveWebSettings', () => {
  it('defaults to header auth that denies everything', () => {
    expect(resolveWebSettings(empty, { user: 'roni' })).toEqual({
      port: DEFAULT_WEB_PORT,
      auth: 'header',
      identityHeader: '',
      allowedUsers: [],
      publicHost: '',
      tunnelCommand: '',
      pollMs: 2000,
      tunnel: '',
      tunnelUrlHost: '',
      tunnelReadyLine: '',
      tunnelActionHost: '',
      cloudflare: { team: '', audience: '' },
      ngrokProvider: 'google',
    });
    expect(DEFAULT_WEB_PORT).toBe(7690);
  });

  it('keeps a port in range and falls back otherwise', () => {
    const port = (p: unknown) => resolveWebSettings({ ...empty, port: p }, { user: 'u' }).port;
    expect(port(8080)).toBe(8080);
    expect(port(1024)).toBe(1024);
    expect(port(65535)).toBe(65535);
    expect(port(80)).toBe(DEFAULT_WEB_PORT);
    expect(port(70000)).toBe(DEFAULT_WEB_PORT);
    expect(port(8080.5)).toBe(DEFAULT_WEB_PORT);
    expect(port('8080')).toBe(DEFAULT_WEB_PORT);
    expect(port(NaN)).toBe(DEFAULT_WEB_PORT);
  });

  it('clamps the poll interval', () => {
    const poll = (p: unknown) => resolveWebSettings({ ...empty, pollMs: p }, { user: 'u' }).pollMs;
    expect(poll(1000)).toBe(1000);
    expect(poll(10)).toBe(500);
    expect(poll(10 ** 9)).toBe(60_000);
    expect(poll('fast')).toBe(2000);
    expect(poll(Infinity)).toBe(2000);
  });

  it('gives loopback auth only for the exact string', () => {
    const auth = (a: unknown) => resolveWebSettings({ ...empty, auth: a }, { user: 'u' }).auth;
    expect(auth('loopback')).toBe('loopback');
    expect(auth('header')).toBe('header');
    expect(auth('Loopback')).toBe('header');
    expect(auth(' loopback')).toBe('header');
    expect(auth('none')).toBe('header');
    expect(auth(true)).toBe('header');
  });

  it('lower-cases the identity header and drops an invalid one', () => {
    expect(resolveWebSettings({ ...empty, identityHeader: ' Tailscale-User-Login ' }, { user: 'u' }).identityHeader).toBe('tailscale-user-login');
    expect(resolveWebSettings({ ...empty, identityHeader: 'bad header' }, { user: 'u' }).identityHeader).toBe('');
    expect(resolveWebSettings({ ...empty, identityHeader: 42 }, { user: 'u' }).identityHeader).toBe('');
  });

  it('keeps allowed users exactly as written and drops non-strings', () => {
    const users = resolveWebSettings({ ...empty, allowedUsers: [' roni', 'Roni', 'roni', '', 7, null, 'a@b.c'] }, { user: 'u' }).allowedUsers;
    expect(users).toEqual([' roni', 'Roni', 'roni', 'a@b.c']);
    expect(resolveWebSettings({ ...empty, allowedUsers: 'roni' }, { user: 'u' }).allowedUsers).toEqual([]);
  });

  it('lower-cases the public host and trims the tunnel command', () => {
    const r = resolveWebSettings({ ...empty, publicHost: ' Me.Example.COM ', tunnelCommand: '  run {port}  ' }, { user: 'u' });
    expect(r.publicHost).toBe('me.example.com');
    expect(r.tunnelCommand).toBe('run {port}');
  });

  it("uses the provider's tunnel, header and the local user when all are empty", () => {
    const r = resolveWebSettings(empty, { provider, user: 'roni' });
    expect(r.tunnelCommand).toBe('expose {port} --as {user}');
    expect(r.identityHeader).toBe('x-proxy-user');
    expect(r.allowedUsers).toEqual(['roni']);
  });

  it("keeps configured users and header over the provider's", () => {
    const r = resolveWebSettings({ ...empty, identityHeader: 'X-Other', allowedUsers: ['alice'] }, { provider, user: 'roni' });
    expect(r.identityHeader).toBe('x-other');
    expect(r.allowedUsers).toEqual(['alice']);
  });

  it('fails closed with a custom tunnel command and nothing else configured, even with a provider', () => {
    const r = resolveWebSettings({ ...empty, tunnelCommand: 'my-proxy {port}' }, { provider, user: 'roni' });
    expect(r.tunnelCommand).toBe('my-proxy {port}');
    expect(r.identityHeader).toBe('');
    expect(r.allowedUsers).toEqual([]);
  });

  it("never runs the provider's tunnel in loopback mode (no identity check behind a tunnel)", () => {
    const r = resolveWebSettings({ ...empty, auth: 'loopback' }, { provider, user: 'roni' });
    expect(r).toMatchObject({ auth: 'loopback', tunnelCommand: '', identityHeader: '', allowedUsers: [] });
  });

  it('gives no users when the local user is unknown', () => {
    expect(resolveWebSettings(empty, { provider, user: '' }).allowedUsers).toEqual([]);
  });
});

describe('parseDaemonConfig', () => {
  const good = () => JSON.parse(JSON.stringify(defaultDaemonConfig('/home/u', 'u')));

  it('accepts the default config', () => {
    const parsed = parseDaemonConfig(good());
    expect('config' in parsed && parsed.config).toEqual(defaultDaemonConfig('/home/u', 'u'));
  });

  it('keeps optional fields', () => {
    const raw = { ...good(), root: '/w', scopeDirs: ['/w', '/real/w'], tmux: { ...good().tmux, configFile: '/c.conf' }, claude: { command: 'c', path: 'p', args: 'a', modeArgs: '--x' } };
    const parsed = parseDaemonConfig(raw);
    expect('config' in parsed && parsed.config.root).toBe('/w');
    expect('config' in parsed && parsed.config.tmux.configFile).toBe('/c.conf');
    expect('config' in parsed && parsed.config.claude).toEqual({ command: 'c', path: 'p', args: 'a', modeArgs: '--x' });
  });

  it('re-applies the clamps', () => {
    const parsed = parseDaemonConfig({ ...good(), pollMs: 1, identityHeader: 'X-H', publicHost: 'A.B' });
    expect('config' in parsed && parsed.config.pollMs).toBe(500);
    expect('config' in parsed && parsed.config.identityHeader).toBe('x-h');
    expect('config' in parsed && parsed.config.publicHost).toBe('a.b');
  });

  it.each([
    ['not an object', () => 'x'],
    ['an array', () => []],
    ['wrong version', () => ({ ...good(), version: 2 })],
    ['missing stateDir', () => ({ ...good(), stateDir: undefined })],
    ['empty stateDir', () => ({ ...good(), stateDir: '' })],
    ['missing webDir', () => ({ ...good(), webDir: undefined })],
    ['port as string', () => ({ ...good(), port: '7690' })],
    ['port out of range', () => ({ ...good(), port: 80 })],
    ['unknown auth', () => ({ ...good(), auth: 'none' })],
    ['users not an array', () => ({ ...good(), allowedUsers: 'u' })],
    ['a user not a string', () => ({ ...good(), allowedUsers: [1] })],
    ['scope unknown', () => ({ ...good(), scope: 'some' })],
    ['showAll not boolean', () => ({ ...good(), showAll: 'yes' })],
    ['scopeDirs with a number', () => ({ ...good(), scopeDirs: [1] })],
    ['bad tmux server', () => ({ ...good(), tmux: { ...good().tmux, server: '../x' } })],
    ['tmux options not pairs', () => ({ ...good(), tmux: { ...good().tmux, options: [['a']] } })],
    ['tmux env with a number', () => ({ ...good(), tmux: { ...good().tmux, env: { A: 1 } } })],
    ['missing tmux', () => ({ ...good(), tmux: undefined })],
    ['missing modeArgs', () => ({ ...good(), claude: {} })],
    ['root a number', () => ({ ...good(), root: 3 })],
    ['missing discovery', () => ({ ...good(), discovery: undefined })],
    ['stuckMs negative', () => ({ ...good(), stuckMs: -1 })],
    ['user missing', () => ({ ...good(), user: undefined })],
    ['tunnelCommand a number', () => ({ ...good(), tunnelCommand: 1 })],
  ])('rejects %s', (_name, raw) => {
    expect(parseDaemonConfig(raw())).toHaveProperty('error');
  });

  it('rejects loopback auth with a tunnel command or a public host, naming the conflict', () => {
    const loopback = { ...good(), auth: 'loopback' };
    expect(parseDaemonConfig(loopback)).toHaveProperty('config');
    for (const raw of [{ ...loopback, tunnelCommand: 'cloudflared tunnel --url http://127.0.0.1:{port}' }, { ...loopback, publicHost: 'me.example.com' }]) {
      const r = parseDaemonConfig(raw);
      expect('error' in r && r.error).toMatch(/devdesk\.web\.auth.*loopback.*(tunnelCommand|publicHost)/);
    }
    expect(parseDaemonConfig({ ...loopback, tunnelCommand: '   ' })).toHaveProperty('config');
  });
});

describe('parseDaemonArgs', () => {
  it('reads every flag', () => {
    const r = parseDaemonArgs([
      '--config', '/c.json',
      '--port', '9000',
      '--auth', 'loopback',
      '--identity-header', 'X-U',
      '--allow-user', 'a',
      '--allow-user', 'b',
      '--public-host', 'h.example',
      '--tunnel-command', 'run {port}',
      '--state-dir', '/s',
      '--root', '/w',
      '--poll-ms', '1000',
    ]);
    expect(r).toEqual({
      configPath: '/c.json',
      overrides: {
        port: 9000,
        auth: 'loopback',
        identityHeader: 'X-U',
        allowedUsers: ['a', 'b'],
        publicHost: 'h.example',
        tunnelCommand: 'run {port}',
        stateDir: '/s',
        webDir: '/s/web',
        root: '/w',
        scopeDirs: ['/w'],
        pollMs: 1000,
      },
    });
  });

  it('accepts --flag=value', () => {
    expect(parseDaemonArgs(['--port=9001'])).toEqual({ overrides: { port: 9001 } });
  });

  it('gives no overrides without flags', () => {
    expect(parseDaemonArgs([])).toEqual({ overrides: {} });
  });

  it.each([
    [['--host', '0.0.0.0']],
    [['--bind', '0.0.0.0']],
    [['--host=0.0.0.0']],
    [['--nope']],
    [['stray']],
    [['--port']],
    [['--port', 'x']],
    [['--port', '80']],
    [['--auth', 'none']],
    [['--poll-ms', 'x']],
  ])('rejects %j', (argv) => {
    expect(parseDaemonArgs(argv)).toHaveProperty('error');
  });

  it('names the loopback-only bind when asked for a host', () => {
    const r = parseDaemonArgs(['--host', '0.0.0.0']);
    expect('error' in r && r.error).toMatch(/127\.0\.0\.1/);
  });
});

describe('defaultDaemonConfig', () => {
  it('describes a manual run', () => {
    const c = defaultDaemonConfig('/home/u', 'u');
    expect(c.stateDir).toBe('/home/u/.claude/devdesk/state');
    expect(c.webDir).toBe('/home/u/.claude/devdesk/state/web');
    expect(c.claudeSessionsDir).toBe('/home/u/.claude/sessions');
    expect(c.tmux.server).toBe('devdesk');
    expect(c.scope).toBe('all');
    expect(c.tunnelCommand).toBe('');
    expect(c.auth).toBe('header');
    expect(c.allowedUsers).toEqual([]);
    expect(c.version).toBe(1);
  });
});

describe('shortHostName', () => {
  it("is the host name's first label, without what goes up to the user's name", () => {
    expect(shortHostName('box-roni-2a-d12984e7.region.example.com', 'roni')).toBe('2a-d12984e7');
    expect(shortHostName('roni-laptop', 'roni')).toBe('laptop');
    expect(shortHostName('ronin-laptop', 'roni')).toBe('ronin-laptop');
    expect(shortHostName('Roni-MacBook-Pro.local', 'roni')).toBe('macbook-pro');
    expect(shortHostName('f8ffc2_ad 99', 'x')).toBe('f8ffc2-ad-99');
  });
  it('is at most 24 characters, without a dash at either end, and never empty', () => {
    expect(shortHostName('a'.repeat(23) + '-bbbb', 'u')).toBe('a'.repeat(23));
    expect(shortHostName('', 'u')).toBe('host');
    expect(shortHostName('---', 'u')).toBe('host');
  });
});

describe('fillTunnelCommand', () => {
  it('fills in quoted values', () => {
    expect(fillTunnelCommand('expose {port} --name {user}-x --allow {user}', { port: 7690, user: 'roni', host: 'mac' })).toBe("expose 7690 --name 'roni'-x --allow 'roni'");
  });

  it('quotes a user with a quote', () => {
    expect(fillTunnelCommand('run {user}', { port: 1, user: "a'b", host: 'h' })).toBe(`run 'a'\\''b'`);
  });

  it('leaves other text alone', () => {
    expect(fillTunnelCommand('t --name devdesk-v1-{host}', { port: 1, user: 'roni', host: 'box-roni-2a-x.example.com' })).toBe('t --name devdesk-v1-2a-x');
    expect(fillTunnelCommand('run {other} $HOME', { port: 1, user: 'u', host: 'h' })).toBe('run {other} $HOME');
  });
});
