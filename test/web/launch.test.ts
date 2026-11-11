import { describe, expect, it } from 'vitest';
import { isDaemonCommand, lastLogLine, launchFailure, statusBarText, webMenuChoices } from '../../src/core/web/launch';
import type { WebState, WebStatus } from '../../src/core/web/webState';

const state = (o: Partial<WebState> = {}): WebState => ({ version: 1, pid: 42, host: '127.0.0.1', port: 7690, startedAt: 1, configPath: '/s/web/config.json', tunnel: 'none', ...o });

describe('isDaemonCommand', () => {
  it('knows the daemon by its script', () => {
    expect(isDaemonCommand('/Applications/Code.app/Contents/MacOS/Electron /ext/dist/web.js --config /s/web/config.json')).toBe(true);
    expect(isDaemonCommand('node dist/web.js --auth loopback')).toBe(true);
  });
  it('refuses another process that took over a stale pid', () => {
    expect(isDaemonCommand('/usr/bin/vim notes.txt')).toBe(false);
    expect(isDaemonCommand('node dist/web.json')).toBe(false);
    expect(isDaemonCommand('')).toBe(false);
  });
});

describe('lastLogLine', () => {
  it('is the last non-empty line without its timestamp', () => {
    expect(lastLogLine('2026-11-10T01:02:03.456Z listening\n2026-11-10T01:02:04.000Z bad config: port must be an integer\n\n')).toBe('bad config: port must be an integer');
    expect(lastLogLine('plain line\n')).toBe('plain line');
    expect(lastLogLine('')).toBe('');
  });
});

describe('launchFailure', () => {
  it('names the port and the setting when the port is in use', () => {
    expect(launchFailure({ code: 3, port: 7691, log: '' })).toEqual({ message: 'Web access: port 7691 is in use. Change devdesk.web.port.', settings: true });
  });
  it('shows the log line for a bad config or a crash', () => {
    expect(launchFailure({ code: 2, port: 7690, log: 'x bad config: tmux.bin must be a non-empty string\n' })).toEqual({
      message: 'Web access did not start: x bad config: tmux.bin must be a non-empty string',
      settings: true,
    });
    expect(launchFailure({ code: 1, port: 7690, log: '' }).message).toBe('Web access did not start (exit code 1).');
  });
  it('says it timed out when the daemon never wrote its state', () => {
    expect(launchFailure({ code: undefined, port: 7690, log: '' }).message).toBe('Web access did not start within 5 s.');
  });
});

describe('statusBarText', () => {
  it('shows on, tunnel down, or nothing', () => {
    expect(statusBarText({ kind: 'off' })).toBeUndefined();
    expect(statusBarText({ kind: 'on', state: state() })).toBe('$(broadcast) Web: on');
    expect(statusBarText({ kind: 'tunnel-down', state: state({ tunnel: 'down' }) })).toBe('$(warning) Web: tunnel down');
  });
});

describe('webMenuChoices', () => {
  const ids = (s: WebStatus, qr = true) => webMenuChoices(s, qr).map((c) => c.id);
  it('offers Start and Settings when off', () => {
    expect(ids({ kind: 'off' })).toEqual(['start', 'settings']);
  });
  it('offers the URL actions only with a tunnel URL', () => {
    expect(ids({ kind: 'on', state: state({ tunnel: 'up', url: 'https://x.example/' }) })).toEqual(['copy', 'open', 'qr', 'copyLocal', 'restart', 'stop', 'settings']);
    expect(ids({ kind: 'on', state: state() })).toEqual(['copyLocal', 'stop', 'settings']);
    expect(ids({ kind: 'tunnel-down', state: state({ tunnel: 'down', tunnelError: 'boom' }) })).toEqual(['copyLocal', 'restart', 'stop', 'settings']);
  });
  it('leaves out the QR code when it cannot be drawn', () => {
    expect(ids({ kind: 'on', state: state({ tunnel: 'up', url: 'https://x.example/' }) }, false)).not.toContain('qr');
  });
  it('describes the URLs', () => {
    const c = webMenuChoices({ kind: 'on', state: state({ tunnel: 'up', url: 'https://x.example/' }) }, true);
    expect(c.find((x) => x.id === 'copy')?.description).toBe('https://x.example/');
    expect(c.find((x) => x.id === 'copyLocal')?.description).toBe('http://127.0.0.1:7690/');
  });
});
