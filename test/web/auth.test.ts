import { describe, expect, it } from 'vitest';
import { answeredPublicHost, authorize, deniedPage, hostAllowed, mutationCheck, SECURITY_HEADERS } from '../../src/core/web/auth';

const header = { auth: 'header' as const, identityHeader: 'x-proxy-user', allowedUsers: ['roni', 'a@b.c'] };

describe('answeredPublicHost', () => {
  it('is the public host with header auth', () => {
    expect(answeredPublicHost({ auth: 'header' }, 'me.example.com')).toBe('me.example.com');
  });

  it('is none in loopback mode, so only 127.0.0.1 and localhost pass the Host and Origin checks', () => {
    const publicHost = answeredPublicHost({ auth: 'loopback' }, 'me.example.com');
    expect(publicHost).toBe('');
    expect(hostAllowed('me.example.com', 7690, publicHost)).toBe(false);
    expect(hostAllowed('127.0.0.1:7690', 7690, publicHost)).toBe(true);
    const post = { 'content-type': 'application/json' };
    expect(mutationCheck({ ...post, host: '127.0.0.1:7690', origin: 'https://me.example.com' }, 7690, publicHost).ok).toBe(false);
    expect(mutationCheck({ ...post, host: 'me.example.com', origin: 'https://me.example.com' }, 7690, publicHost).ok).toBe(false);
    expect(mutationCheck({ ...post, host: '127.0.0.1:7690', origin: 'http://127.0.0.1:7690' }, 7690, publicHost).ok).toBe(true);
  });
});

describe('authorize', () => {
  it('denies everything when the header is not configured', () => {
    expect(authorize({ 'x-proxy-user': 'roni' }, { ...header, identityHeader: '' })).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('denies everything when no user is allowed', () => {
    expect(authorize({ 'x-proxy-user': 'roni' }, { ...header, allowedUsers: [] })).toEqual({ ok: false, reason: 'not-configured' });
    expect(authorize({ 'x-proxy-user': '' }, { ...header, allowedUsers: [] })).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('denies a request without the header', () => {
    expect(authorize({}, header)).toEqual({ ok: false, reason: 'no-identity' });
    expect(authorize({ 'x-other': 'roni' }, header)).toEqual({ ok: false, reason: 'no-identity' });
    expect(authorize({ 'x-proxy-user': '' }, header)).toEqual({ ok: false, reason: 'no-identity' });
  });

  it('denies a repeated header', () => {
    expect(authorize({ 'x-proxy-user': ['roni', 'roni'] }, header)).toEqual({ ok: false, reason: 'no-identity' });
  });

  it('denies a user not allowed, by exact match only', () => {
    expect(authorize({ 'x-proxy-user': 'mallory' }, header)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(authorize({ 'x-proxy-user': 'Roni' }, header)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(authorize({ 'x-proxy-user': ' roni' }, header)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(authorize({ 'x-proxy-user': 'roni ' }, header)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(authorize({ 'x-proxy-user': 'roni, mallory' }, header)).toEqual({ ok: false, reason: 'not-allowed' });
    expect(authorize({ 'x-proxy-user': 'ron' }, header)).toEqual({ ok: false, reason: 'not-allowed' });
  });

  it('allows an exact match', () => {
    expect(authorize({ 'x-proxy-user': 'roni' }, header)).toEqual({ ok: true, user: 'roni' });
    expect(authorize({ 'x-proxy-user': 'a@b.c' }, header)).toEqual({ ok: true, user: 'a@b.c' });
  });

  it('needs no header in loopback mode', () => {
    expect(authorize({}, { auth: 'loopback', identityHeader: '', allowedUsers: [] })).toEqual({ ok: true });
  });

  it('treats any other auth value as header auth', () => {
    expect(authorize({}, { auth: 'none' as 'header', identityHeader: '', allowedUsers: [] })).toEqual({ ok: false, reason: 'not-configured' });
  });
});

describe('hostAllowed', () => {
  it('allows loopback on the port', () => {
    expect(hostAllowed('127.0.0.1:7690', 7690, '')).toBe(true);
    expect(hostAllowed('localhost:7690', 7690, '')).toBe(true);
    expect(hostAllowed('LOCALHOST:7690', 7690, '')).toBe(true);
  });

  it('denies loopback on another port or without one', () => {
    expect(hostAllowed('127.0.0.1:7691', 7690, '')).toBe(false);
    expect(hostAllowed('127.0.0.1', 7690, '')).toBe(false);
    expect(hostAllowed('localhost', 7690, '')).toBe(false);
  });

  it('denies other hosts (DNS rebinding)', () => {
    expect(hostAllowed('evil.com', 7690, '')).toBe(false);
    expect(hostAllowed('evil.com:7690', 7690, '')).toBe(false);
    expect(hostAllowed('evil.com', 7690, 'me.example.com')).toBe(false);
    expect(hostAllowed('me.example.com.evil.com', 7690, 'me.example.com')).toBe(false);
    expect(hostAllowed('0.0.0.0:7690', 7690, '')).toBe(false);
  });

  it('allows the public host with and without :443', () => {
    expect(hostAllowed('me.example.com', 7690, 'me.example.com')).toBe(true);
    expect(hostAllowed('Me.Example.com', 7690, 'me.example.com')).toBe(true);
    expect(hostAllowed('me.example.com:443', 7690, 'me.example.com')).toBe(true);
    expect(hostAllowed('me.example.com', 7690, 'me.example.com:443')).toBe(true);
    expect(hostAllowed('me.example.com:8443', 7690, 'me.example.com')).toBe(false);
    expect(hostAllowed('me.example.com:8443', 7690, 'me.example.com:8443')).toBe(true);
  });

  it('denies a missing or empty Host', () => {
    expect(hostAllowed(undefined, 7690, '')).toBe(false);
    expect(hostAllowed('', 7690, '')).toBe(false);
    expect(hostAllowed('', 7690, 'me.example.com')).toBe(false);
  });
});

describe('mutationCheck', () => {
  const json = 'application/json';
  const check = (h: Record<string, string | undefined>, publicHost = 'me.example.com') => mutationCheck(h, 7690, publicHost);

  it('denies a request without Origin', () => {
    expect(check({ host: '127.0.0.1:7690', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
  });

  it('allows Origin equal to Host', () => {
    expect(check({ host: '127.0.0.1:7690', origin: 'http://127.0.0.1:7690', 'content-type': json })).toEqual({ ok: true });
    expect(check({ host: 'me.example.com', origin: 'https://me.example.com', 'content-type': json })).toEqual({ ok: true });
  });

  it('allows the public Origin when a proxy rewrote Host to loopback', () => {
    expect(check({ host: '127.0.0.1:7690', origin: 'https://me.example.com', 'content-type': json })).toEqual({ ok: true });
  });

  it('denies a public Host with a loopback Origin', () => {
    expect(check({ host: 'me.example.com', origin: 'http://127.0.0.1:7690', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
  });

  it('denies a foreign or opaque Origin', () => {
    expect(check({ host: '127.0.0.1:7690', origin: 'null', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
    expect(check({ host: '127.0.0.1:7690', origin: 'https://evil.com', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
    expect(check({ host: 'me.example.com', origin: 'https://evil.com', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
    expect(check({ host: '127.0.0.1:7690', origin: 'http://localhost:7691', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
    expect(check({ host: '127.0.0.1:7690', origin: 'file://', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
    expect(check({ host: '127.0.0.1:7690', origin: 'not a url', 'content-type': json })).toMatchObject({ ok: false, status: 403 });
  });

  it('denies the public Origin when no public host is known', () => {
    expect(check({ host: '127.0.0.1:7690', origin: 'https://me.example.com', 'content-type': json }, '')).toMatchObject({ ok: false, status: 403 });
  });

  it('needs a JSON content type', () => {
    const base = { host: '127.0.0.1:7690', origin: 'http://127.0.0.1:7690' };
    expect(check({ ...base, 'content-type': 'text/plain' })).toMatchObject({ ok: false, status: 415 });
    expect(check({ ...base, 'content-type': 'application/x-www-form-urlencoded' })).toMatchObject({ ok: false, status: 415 });
    expect(check({ ...base, 'content-type': 'multipart/form-data; boundary=x' })).toMatchObject({ ok: false, status: 415 });
    expect(check(base)).toMatchObject({ ok: false, status: 415 });
    expect(check({ ...base, 'content-type': 'application/json; charset=utf-8' })).toEqual({ ok: true });
    expect(check({ ...base, 'content-type': 'Application/JSON' })).toEqual({ ok: true });
  });
});

describe('SECURITY_HEADERS', () => {
  it('has the five headers', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toMatch(/default-src 'self'/);
    expect(SECURITY_HEADERS['Content-Security-Policy']).toMatch(/frame-ancestors 'none'/);
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['Cache-Control']).toBe('no-store');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('deniedPage', () => {
  it('names the settings to configure, and no user', () => {
    for (const reason of ['not-configured', 'no-identity', 'not-allowed', 'host'] as const) {
      const page = deniedPage({ ok: false, reason } as Parameters<typeof deniedPage>[0]);
      expect(page).toMatch(/^<!doctype html>/i);
      expect(page).toMatch(/devdesk\.web\./);
      expect(page).not.toMatch(/roni|x-proxy-user/i);
      expect(page).not.toMatch(/<script/i);
    }
    expect(deniedPage({ ok: false, reason: 'not-configured' })).toMatch(/devdesk\.web\.identityHeader/);
    expect(deniedPage({ ok: false, reason: 'not-configured' })).toMatch(/devdesk\.web\.allowedUsers/);
    expect(deniedPage({ reason: 'host' })).toMatch(/devdesk\.web\.publicHost/);
  });
});
