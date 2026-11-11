import { describe, expect, it } from 'vitest';
import { check, devtunnelUser, hostNameOf, ngrokConfigPath, ngrokHasAuthtoken, setupSettings, tailscaleLogin, tunnelHint } from '../../src/core/web/tunnelSetup';

describe('tunnel setup', () => {
  it('reads the Tailscale login of this device', () => {
    const status = (o: object) => JSON.stringify({ BackendState: 'Running', Self: { UserID: 42 }, User: { '42': { LoginName: 'me@github' } }, ...o });
    expect(tailscaleLogin(status({}))).toEqual({ login: 'me@github' });
    expect(tailscaleLogin(status({ BackendState: 'NeedsLogin' }))).toEqual({ problem: expect.stringMatching(/not connected \(NeedsLogin\)/) });
    expect(tailscaleLogin(status({ User: {} }))).toEqual({ problem: expect.stringMatching(/tagged/) });
    expect(tailscaleLogin('')).toEqual({ problem: expect.any(String) });
  });

  it('reads who is signed in to Dev Tunnels', () => {
    expect(devtunnelUser('Logged in as roni using GitHub.')).toBe('roni');
    expect(devtunnelUser('Logged in as me@example.com using Microsoft.')).toBe('me@example.com');
    expect(devtunnelUser('Not logged in.')).toBeUndefined();
  });

  it('finds an ngrok authtoken', () => {
    expect(ngrokConfigPath('Valid configuration file at /h/.config/ngrok/ngrok.yml')).toBe('/h/.config/ngrok/ngrok.yml');
    expect(ngrokHasAuthtoken('version: "3"\nagent:\n    authtoken: 2abcDEF123456789_xyz\n')).toBe(true);
    expect(ngrokHasAuthtoken('version: "3"\n')).toBe(false);
  });

  it('checks what is typed', () => {
    expect(hostNameOf('https://DevDesk.Example.com/')).toBe('devdesk.example.com');
    expect(hostNameOf('localhost')).toBe('');
    expect(hostNameOf('a b.com')).toBe('');
    expect(check.email('me@example.com')).toBeUndefined();
    expect(check.email('me')).toBeDefined();
    expect(check.team('acme')).toBeUndefined();
    expect(check.audience('nope')).toBeDefined();
  });

  it('writes the settings of each choice', () => {
    expect(setupSettings({ tunnel: 'tailscale', login: 'me@github' })).toEqual({ tunnel: 'tailscale', allowedUsers: ['me@github'] });
    expect(setupSettings({ tunnel: 'devtunnel' })).toEqual({ tunnel: 'devtunnel' });
    expect(setupSettings({ tunnel: 'ngrok', email: ' me@example.com ', provider: 'github' })).toEqual({ tunnel: 'ngrok', allowedUsers: ['me@example.com'], 'ngrok.oauthProvider': 'github' });
    expect(setupSettings({ tunnel: 'cloudflare', email: 'me@example.com', host: 'D.example.com', team: 'Acme', audience: 'A'.repeat(64) })).toEqual({
      tunnel: 'cloudflare',
      allowedUsers: ['me@example.com'],
      publicHost: 'd.example.com',
      'cloudflare.team': 'acme',
      'cloudflare.audience': 'a'.repeat(64),
    });
    expect(setupSettings({ tunnel: 'none' })).toEqual({ tunnel: 'none' });
  });

  it('hints at what to do when a tunnel goes down', () => {
    expect(tunnelHint('tailscale', 'Access denied: serve config denied')).toMatch(/--operator/);
    expect(tunnelHint('ngrok', 'ERR_NGROK_4018 authentication failed')).toMatch(/add-authtoken/);
    expect(tunnelHint('devtunnel', 'Login required')).toMatch(/devtunnel user login/);
    expect(tunnelHint('cloudflare', 'sh: cloudflared: not found')).toMatch(/Install Cloudflare Tunnel/);
    expect(tunnelHint('', 'whatever')).toBeUndefined();
  });
});
