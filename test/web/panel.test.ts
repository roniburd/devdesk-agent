import { describe, expect, it } from 'vitest';
import { daemonScript, sinceText, webPanelRows, type WebPanelInput } from '../../src/core/web/panel';
import type { WebState } from '../../src/core/web/webState';

const SCRIPT = '/home/u/.vscode-server/extensions/roniburd.devdesk-claude-1.6.3/dist/web.js';
const NOW = Date.UTC(2026, 10, 10, 12);
const state = (o: Partial<WebState> = {}): WebState => ({ version: 1, pid: 42, host: '127.0.0.1', port: 7690, startedAt: NOW - 5 * 60_000, configPath: '/s/web/config.json', tunnel: 'none', ...o });
const settings = { auth: 'header' as const, allowedUsers: ['alice'], identityHeader: 'x-forwarded-user' };
const input = (o: Partial<WebPanelInput>): WebPanelInput => ({ status: { kind: 'off' }, script: SCRIPT, now: NOW, ...o });
const ids = (o: Partial<WebPanelInput>) => webPanelRows(input(o)).map((r) => r.id);

describe('daemonScript', () => {
  it('finds the script and the version of the extension it came from', () => {
    expect(daemonScript(`/srv/node ${SCRIPT.replace('1.6.3', '1.6.0')} --config /s/web/config.json`)).toEqual({ script: SCRIPT.replace('1.6.3', '1.6.0'), version: '1.6.0' });
    expect(daemonScript('/srv/node /x/roniburd.devdesk-claude-beta-2.1.0-prototype.11/dist/web.js --config c')?.version).toBe('2.1.0-prototype.11');
  });
  it('has no version for a daemon run from a checkout, and nothing for another command', () => {
    expect(daemonScript('node dist/web.js --auth loopback')).toEqual({ script: 'dist/web.js' });
    expect(daemonScript('/usr/bin/vim notes.txt')).toBeUndefined();
  });
});

describe('sinceText', () => {
  it('rounds to minutes, hours, then days', () => {
    expect(sinceText(NOW - 10_000, NOW)).toBe('just now');
    expect(sinceText(NOW - 5 * 60_000, NOW)).toBe('5 min');
    expect(sinceText(NOW - 3 * 3600_000, NOW)).toBe('3 h');
    expect(sinceText(NOW - 72 * 3600_000, NOW)).toBe('3 days');
  });
});

describe('webPanelRows', () => {
  it('offers Start when off', () => {
    const [status, more] = webPanelRows(input({}));
    expect(status).toMatchObject({ id: 'status', label: 'Off', action: 'start' });
    expect(more).toMatchObject({ id: 'settings', action: 'settings' });
  });

  it('shows the state, phone URL, tunnel, loopback URL, access and log when on', () => {
    const rows = webPanelRows(input({ status: { kind: 'on', state: state({ tunnel: 'up', url: 'https://t.example/', tunnelPid: 43 }) }, settings, running: { script: SCRIPT, version: '1.6.3' } }));
    expect(rows.map((r) => [r.id, r.label, r.description])).toEqual([
      ['status', 'Running', '5 min · pid 42'],
      ['url', 'Phone URL', 'https://t.example/'],
      ['tunnel', 'Tunnel up', 'pid 43'],
      ['local', 'Loopback URL', 'http://127.0.0.1:7690/'],
      ['access', 'Access: alice', 'x-forwarded-user'],
      ['log', 'Log', 'daemon.log'],
    ]);
    expect(rows.find((r) => r.id === 'url')).toMatchObject({ action: 'copyUrl', contextValue: 'webUrl' });
    expect(rows.find((r) => r.id === 'tunnel')).toMatchObject({ action: 'restartTunnel', contextValue: 'webTunnel' });
  });

  it('warns about a tunnel that is down, with its error', () => {
    const rows = webPanelRows(input({ status: { kind: 'tunnel-down', state: state({ tunnel: 'down', tunnelError: 'no URL within 60 s' }) } }));
    expect(rows[0]).toMatchObject({ label: 'Running, tunnel down', icon: 'warning' });
    expect(rows.find((r) => r.id === 'tunnel')).toMatchObject({ label: 'Tunnel down', description: 'no URL within 60 s', icon: 'error' });
  });

  it('flags a daemon another version started, offering a restart', () => {
    const old = SCRIPT.replace('1.6.3', '1.6.0');
    const rows = webPanelRows(input({ status: { kind: 'on', state: state() }, running: { script: old, version: '1.6.0' } }));
    expect(rows.find((r) => r.id === 'outdated')).toMatchObject({ label: 'Started by version 1.6.0', description: 'Restart to update', action: 'restart' });
    expect(ids({ status: { kind: 'on', state: state() }, running: { script: SCRIPT } })).not.toContain('outdated');
    // ps couldn't tell: no warning.
    expect(ids({ status: { kind: 'on', state: state() } })).not.toContain('outdated');
  });

  it('leaves out the tunnel rows without a tunnel, and says who may use it', () => {
    expect(ids({ status: { kind: 'on', state: state() } })).toEqual(['status', 'local', 'log']);
    const access = (s: WebPanelInput['settings']) => webPanelRows(input({ status: { kind: 'on', state: state() }, settings: s })).find((r) => r.id === 'access');
    expect(access({ ...settings, auth: 'loopback' })).toMatchObject({ label: 'Access: no identity check', icon: 'unlock' });
    expect(access({ ...settings, allowedUsers: [] })).toMatchObject({ label: 'Access: nobody', color: 'problemsWarningIcon.foreground' });
    expect(access({ ...settings, identityHeader: '' })).toMatchObject({ description: 'no identity header', color: 'problemsWarningIcon.foreground' });
  });
});
