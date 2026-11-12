import { describe, expect, it } from 'vitest';
import {
  EXIT_BAD_CONFIG,
  EXIT_PORT_IN_USE,
  parseWebSeen,
  parseWebState,
  webConfigPath,
  webDir,
  webLogPath,
  webSeenJson,
  webSeenPath,
  webStatePath,
  webStatus,
  webUnread,
  type WebState,
} from '../../src/core/web/webState';
import type { SessionCard } from '../../src/core/sessions';
import { cardSignature } from '../../src/core/sessionsView';

const state: WebState = { version: 1, pid: 123, host: '127.0.0.1', port: 7690, startedAt: 5, configPath: '/s/web/config.json', tunnel: 'none' };

describe('web state paths', () => {
  it('keeps its files out of the hook records', () => {
    // Apart from v1's daemon (`/s/web`): both can run on one host.
    expect(webDir('/s')).toBe('/s/web-v2');
    expect(webStatePath('/s/web')).toBe('/s/web/web.json');
    expect(webConfigPath('/s/web')).toBe('/s/web/config.json');
    expect(webLogPath('/s/web')).toBe('/s/web/daemon.log');
    expect(EXIT_BAD_CONFIG).toBe(2);
    expect(EXIT_PORT_IN_USE).toBe(3);
  });
});

describe('parseWebState', () => {
  it('reads a valid state', () => {
    expect(parseWebState(JSON.stringify(state))).toEqual(state);
    const up = { ...state, tunnel: 'up', url: 'https://x.example', tunnelPid: 9 };
    expect(parseWebState(JSON.stringify(up))).toEqual(up);
    const down = { ...state, tunnel: 'down', tunnelError: 'no URL within 60 s' };
    expect(parseWebState(JSON.stringify(down))).toEqual(down);
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ ...state, version: 2 })],
    ['another host', JSON.stringify({ ...state, host: '0.0.0.0' })],
    ['no pid', JSON.stringify({ ...state, pid: undefined })],
    ['a pid of 0', JSON.stringify({ ...state, pid: 0 })],
    ['a bad port', JSON.stringify({ ...state, port: 'x' })],
    ['a bad tunnel', JSON.stringify({ ...state, tunnel: 'maybe' })],
    ['a bad url', JSON.stringify({ ...state, url: 3 })],
  ])('rejects %s', (_name, text) => {
    expect(parseWebState(text)).toBeUndefined();
  });
});

describe('webStatus', () => {
  it('is off without a state or with a dead pid', () => {
    expect(webStatus(undefined, () => true)).toEqual({ kind: 'off' });
    expect(webStatus(state, () => false)).toEqual({ kind: 'off' });
  });

  it('is on while the pid runs', () => {
    expect(webStatus(state, (p) => p === 123)).toEqual({ kind: 'on', state });
    expect(webStatus({ ...state, tunnel: 'up' }, () => true).kind).toBe('on');
    expect(webStatus({ ...state, tunnel: 'starting' }, () => true).kind).toBe('on');
  });

  it('says when the tunnel is down', () => {
    const down = { ...state, tunnel: 'down' as const };
    expect(webStatus(down, () => true)).toEqual({ kind: 'tunnel-down', state: down });
  });
});

describe('seen.json (what the Claude view has read)', () => {
  it('round-trips the seen marks', () => {
    const seen = new Map([['a', 'sig-a'], ['b', 'sig-b']]);
    expect(parseWebSeen(webSeenJson(seen))).toEqual(seen);
  });

  it('is undefined when missing or malformed, so the daemon counts every session unread', () => {
    expect(parseWebSeen('')).toBeUndefined();
    expect(parseWebSeen('{')).toBeUndefined();
    expect(parseWebSeen('{"seen": 3}')).toBeUndefined();
  });

  it('skips entries that are not [string, string]', () => {
    expect(parseWebSeen('{"version":1,"seen":[["a","x"],["b",2],"c"]}')).toEqual(new Map([['a', 'x']]));
  });

  it('lives next to web.json', () => {
    expect(webSeenPath('/s/web')).toBe('/s/web/seen.json');
  });
});

describe('webUnread', () => {
  const c = (id: string, state: SessionCard['state']): SessionCard => ({ id, state, detail: 'Finished', attached: false });
  it('uses the seen marks with the Claude view’s unreadCards', () => {
    const cards = [c('a', 'done'), c('b', 'done')];
    const seen = new Map([['a', cardSignature(cards[0])]]);
    expect([...webUnread(seen, cards)]).toEqual(['b']);
  });

  it('counts every session unread without seen marks (as a session never seen)', () => {
    expect([...webUnread(undefined, [c('a', 'done'), c('b', 'idle')])]).toEqual(['a', 'b']);
  });
});
