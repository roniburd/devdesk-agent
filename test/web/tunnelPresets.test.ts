import { describe, expect, it } from 'vitest';
import { fillTunnelCommand, needsTunnelChoice, parseDaemonConfig, resolveWebSettings, defaultDaemonConfig, type WebSettings } from '../../src/core/web/config';
import {
  allowsAnonymous,
  classifyTunnelUrl,
  cloudflareAudienceOf,
  cloudflareTeamOf,
  isPlainEmail,
  ngrokPolicy,
  presetSpec,
  TUNNEL_PRESETS,
  tunnelChoiceOf,
} from '../../src/core/web/tunnelPresets';

const empty: WebSettings = { port: undefined, auth: undefined, identityHeader: '', allowedUsers: [], publicHost: '', tunnelCommand: '', pollMs: undefined };
const provider = { tunnelCommand: 'expose {port}', identityHeader: 'X-Proxy-User' };
const AUD = 'a'.repeat(64);

describe('tunnel choice', () => {
  it('falls back to auto', () => {
    expect(tunnelChoiceOf('tailscale')).toBe('tailscale');
    expect(tunnelChoiceOf('TAILSCALE')).toBe('auto');
    expect(tunnelChoiceOf(undefined)).toBe('auto');
  });

  it('asks on Start only for auto with nothing else to run', () => {
    expect(needsTunnelChoice({ tunnel: 'auto', auth: 'header', tunnelCommand: '' }, false)).toBe(true);
    expect(needsTunnelChoice({ tunnel: undefined, auth: undefined, tunnelCommand: ' ' }, false)).toBe(true);
    expect(needsTunnelChoice({ tunnel: 'auto', auth: 'header', tunnelCommand: '' }, true)).toBe(false);
    expect(needsTunnelChoice({ tunnel: 'auto', auth: 'header', tunnelCommand: 'run' }, false)).toBe(false);
    expect(needsTunnelChoice({ tunnel: 'auto', auth: 'loopback', tunnelCommand: '' }, false)).toBe(false);
    for (const t of ['tailscale', 'none', 'custom']) expect(needsTunnelChoice({ tunnel: t, auth: 'header', tunnelCommand: '' }, false)).toBe(false);
  });
});

describe('resolveWebSettings with a preset', () => {
  it('tailscale: its command and header, whatever identityHeader and tunnelCommand say', () => {
    const r = resolveWebSettings({ ...empty, tunnel: 'tailscale', identityHeader: 'x-evil', tunnelCommand: 'evil', allowedUsers: ['me@github'] }, { user: 'u', provider });
    expect(r).toMatchObject({ auth: 'header', tunnel: 'tailscale', identityHeader: 'tailscale-user-login', allowedUsers: ['me@github'] });
    expect(r.tunnelCommand).toMatch(/ serve \{port\}$/);
    expect(r.tunnelUrlHost).toBe(String.raw`\.ts\.net$`);
  });

  it('tailscale without users denies everyone ($USER is not a Tailscale login)', () => {
    expect(resolveWebSettings({ ...empty, tunnel: 'tailscale' }, { user: 'u' }).allowedUsers).toEqual([]);
  });

  it('devtunnel: tunnel auth, no users, no anonymous access', () => {
    const r = resolveWebSettings({ ...empty, tunnel: 'devtunnel', allowedUsers: ['x'] }, { user: 'u' });
    expect(r).toMatchObject({ auth: 'tunnel', identityHeader: '', allowedUsers: [], tunnelCommand: 'devtunnel host -p {port}' });
    expect(allowsAnonymous(r.tunnelCommand)).toBe(false);
  });

  it('cloudflare: Access auth with the team and audience, ready on its connection line', () => {
    const r = resolveWebSettings(
      { ...empty, tunnel: 'cloudflare', publicHost: 'DevDesk.Example.com', cloudflareTeam: 'https://Acme.cloudflareaccess.com/', cloudflareAudience: AUD.toUpperCase(), allowedUsers: ['me@example.com'] },
      { user: 'u' },
    );
    expect(r).toMatchObject({ auth: 'cloudflare', cloudflare: { team: 'acme', audience: AUD }, publicHost: 'devdesk.example.com', tunnelReadyLine: 'Registered tunnel connection' });
    expect(r.tunnelCommand).toContain('route dns --overwrite-dns devdesk-{host} {publicHost}');
    expect(resolveWebSettings({ ...empty, tunnel: 'cloudflare' }, { user: 'u' }).tunnelReadyLine).toBe('');
  });

  it('ngrok: its policy file, the header the policy sets, and the reserved domain when set', () => {
    const r = resolveWebSettings({ ...empty, tunnel: 'ngrok', ngrokProvider: 'github', allowedUsers: ['me@example.com'] }, { user: 'u' });
    expect(r).toMatchObject({ auth: 'header', identityHeader: 'x-devdesk-user', ngrokProvider: 'github' });
    expect(r.tunnelCommand).toBe('ngrok http 127.0.0.1:{port} --traffic-policy-file {ngrokPolicy} --log stdout --log-format logfmt');
    expect(resolveWebSettings({ ...empty, tunnel: 'ngrok', publicHost: 'me.ngrok.app' }, { user: 'u' }).tunnelCommand).toContain('--url {publicHost}');
    expect(resolveWebSettings({ ...empty, tunnel: 'ngrok', ngrokProvider: 'evil' }, { user: 'u' }).ngrokProvider).toBe('google');
  });

  it('loopback auth runs no preset', () => {
    expect(resolveWebSettings({ ...empty, auth: 'loopback', tunnel: 'tailscale' }, { user: 'u' })).toMatchObject({ auth: 'loopback', tunnel: '', tunnelCommand: '' });
  });

  it('none runs nothing, custom and auto run the command, auto falls back to the provider', () => {
    expect(resolveWebSettings({ ...empty, tunnel: 'none', tunnelCommand: 'run' }, { user: 'u', provider }).tunnelCommand).toBe('');
    expect(resolveWebSettings({ ...empty, tunnel: 'custom', tunnelCommand: 'run' }, { user: 'u', provider }).tunnelCommand).toBe('run');
    expect(resolveWebSettings({ ...empty, tunnel: 'custom' }, { user: 'u', provider }).tunnelCommand).toBe('');
    expect(resolveWebSettings({ ...empty, tunnel: 'auto' }, { user: 'u', provider })).toMatchObject({ tunnelCommand: 'expose {port}', identityHeader: 'x-proxy-user', allowedUsers: ['u'] });
  });
});

describe('the daemon config with a preset', () => {
  const daemon = (o: Record<string, unknown>) => parseDaemonConfig({ ...defaultDaemonConfig('/h', 'u'), ...o });

  it('round-trips each preset', () => {
    for (const tunnel of TUNNEL_PRESETS) {
      const s = resolveWebSettings({ ...empty, tunnel, publicHost: 'd.example.com', allowedUsers: ['me@example.com'], cloudflareTeam: 'acme', cloudflareAudience: AUD }, { user: 'u' });
      const parsed = daemon({ ...s });
      expect('config' in parsed && parsed.config).toMatchObject(s);
    }
  });

  it('refuses tunnel auth without the devtunnel preset or with anonymous access', () => {
    expect(daemon({ auth: 'tunnel', tunnel: '', tunnelCommand: 'devtunnel host -p {port}' })).toEqual({ error: expect.stringMatching(/auth 'tunnel'/) });
    expect(daemon({ auth: 'tunnel', tunnel: 'devtunnel', tunnelCommand: 'devtunnel host -p {port} --allow-anonymous' })).toEqual({ error: expect.stringMatching(/anonymous/) });
    expect(daemon({ auth: 'tunnel', tunnel: 'devtunnel', tunnelCommand: 'devtunnel host -p {port}' })).toHaveProperty('config');
  });

  it('never keeps tunnel auth from a hand-written config without a preset', () => {
    // A preset decides its auth: an edited config that names cloudflare auth and no preset gets header auth (deny all).
    const parsed = daemon({ auth: 'cloudflare', tunnel: '' });
    expect('config' in parsed && parsed.config.auth).toBe('header');
  });

  it('refuses bad URL rules and presets', () => {
    expect(daemon({ tunnelUrlHost: '(' })).toEqual({ error: expect.stringMatching(/tunnelUrlHost/) });
    expect(daemon({ tunnel: 'other' })).toEqual({ error: expect.stringMatching(/tunnel must be/) });
    expect(daemon({ auth: 'everyone' })).toEqual({ error: expect.stringMatching(/auth must be/) });
  });
});

describe('fillTunnelCommand placeholders', () => {
  it('quotes the public host and the policy path', () => {
    expect(fillTunnelCommand('x {publicHost} {ngrokPolicy} {publicHost}', { port: 1, user: 'u', host: 'h', publicHost: 'd.example.com', ngrokPolicy: "/a b/'p'" })).toBe(
      `x 'd.example.com' '/a b/'\\''p'\\''' 'd.example.com'`,
    );
    expect(fillTunnelCommand('x {publicHost}', { port: 1, user: 'u', host: 'h' })).toBe("x ''");
  });
});

describe('classifyTunnelUrl', () => {
  const ts = presetSpec('tailscale', { publicHost: '' });
  const dt = presetSpec('devtunnel', { publicHost: '' });
  const cf = presetSpec('cloudflare', { publicHost: 'd.example.com' });
  const ng = presetSpec('ngrok', { publicHost: '' });

  it('tailscale: the ts.net URL, and the turn-on-HTTPS link as an action', () => {
    expect(classifyTunnelUrl('https://mac.tail1234.ts.net/', ts, '')).toBe('url');
    expect(classifyTunnelUrl('https://login.tailscale.com/f/serve?node=x', ts, '')).toBe('action');
    expect(classifyTunnelUrl('https://tailscale.com/kb/1312/serve', ts, '')).toBe('other');
    expect(classifyTunnelUrl('https://evil.example/?x=.ts.net', ts, '')).toBe('other');
  });

  it('devtunnel: the browser URL, not the inspect one', () => {
    expect(classifyTunnelUrl('https://l3rs99qw-7690.usw2.devtunnels.ms/', dt, '')).toBe('url');
    expect(classifyTunnelUrl('https://l3rs99qw-7690-inspect.usw2.devtunnels.ms/', dt, '')).toBe('other');
  });

  it('cloudflare: only the public host, never a docs link', () => {
    expect(classifyTunnelUrl('https://developers.cloudflare.com/x', cf, 'd.example.com')).toBe('other');
    expect(classifyTunnelUrl('https://d.example.com/', cf, 'd.example.com')).toBe('url');
  });

  it('ngrok: its domains', () => {
    expect(classifyTunnelUrl('https://abc.ngrok-free.app', ng, '')).toBe('url');
    expect(classifyTunnelUrl('https://abc.ngrok.dev', ng, '')).toBe('url');
    expect(classifyTunnelUrl('https://ngrok.com/docs', ng, '')).toBe('other');
  });

  it('a custom command takes any https URL', () => {
    expect(classifyTunnelUrl('https://any.example/', { urlHost: '', actionHost: '' }, '')).toBe('url');
    expect(classifyTunnelUrl('https://u:p@any.example/', { urlHost: '', actionHost: '' }, '')).toBe('other');
  });
});

describe('ngrokPolicy', () => {
  it('signs in, denies everyone else, then replaces the identity header', () => {
    const p = ngrokPolicy(['me@example.com', "o'neil@example.com", 'you@example.org'], 'github');
    expect(p).toContain('provider: github');
    expect(p).toContain(`"!(actions.ngrok.oauth.identity.email in ['me@example.com', 'you@example.org'])"`);
    expect(p.indexOf('remove-headers')).toBeLessThan(p.indexOf('add-headers'));
    expect(p).toContain('x-devdesk-user: "${actions.ngrok.oauth.identity.email}"');
  });

  it('denies everyone with no plain email', () => {
    expect(ngrokPolicy([], 'google')).toContain('email in [])');
  });
});

describe('input checks', () => {
  it('emails', () => {
    expect(isPlainEmail('me@example.com')).toBe(true);
    for (const e of ['me', "a'b@x.com", 'a b@x.com', 'a@b', 'a@@b.com', 'a"@b.com']) expect(isPlainEmail(e)).toBe(false);
  });

  it('cloudflare team and audience', () => {
    expect(cloudflareTeamOf('acme')).toBe('acme');
    expect(cloudflareTeamOf('acme.cloudflareaccess.com')).toBe('acme');
    expect(cloudflareTeamOf('evil.com/x')).toBe('');
    expect(cloudflareTeamOf('a.b')).toBe('');
    expect(cloudflareAudienceOf(AUD)).toBe(AUD);
    expect(cloudflareAudienceOf('xyz')).toBe('');
  });

  it('anonymous dev tunnels', () => {
    expect(allowsAnonymous('devtunnel host -p 1 -a')).toBe(true);
    expect(allowsAnonymous('devtunnel host -p 1 --allow-anonymous')).toBe(true);
    expect(allowsAnonymous('devtunnel access create x --anonymous; devtunnel host x')).toBe(true);
    expect(allowsAnonymous('devtunnel host -p 1')).toBe(false);
  });
});
