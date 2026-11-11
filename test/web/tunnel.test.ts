import { describe, expect, it } from 'vitest';
import { firstHttpsUrl, LastLine, publicHostOf, TUNNEL_URL_TIMEOUT_MS } from '../../src/core/web/tunnel';

describe('firstHttpsUrl', () => {
  it('finds the URL in noisy output', () => {
    expect(firstHttpsUrl('Starting...\nYour tunnel: https://x.example/ ready\n')).toBe('https://x.example/');
    expect(firstHttpsUrl('\x1b[32mhttps://me.example.com\x1b[0m')).toBe('https://me.example.com');
    expect(firstHttpsUrl('url="https://q.example/a?b=1" ok')).toBe('https://q.example/a?b=1');
    expect(firstHttpsUrl("url='https://q.example/a'")).toBe('https://q.example/a');
    expect(firstHttpsUrl('<https://q.example/a>')).toBe('https://q.example/a');
  });

  it('takes the first of two', () => {
    expect(firstHttpsUrl('see https://docs.example/help then https://me.example')).toBe('https://docs.example/help');
  });

  it('gives nothing without an https URL', () => {
    expect(firstHttpsUrl('no url here')).toBeUndefined();
    expect(firstHttpsUrl('http://insecure.example')).toBeUndefined();
    expect(firstHttpsUrl('https://')).toBeUndefined();
    expect(firstHttpsUrl('')).toBeUndefined();
  });

  it('allows 60 s for a URL', () => {
    expect(TUNNEL_URL_TIMEOUT_MS).toBe(60_000);
  });
});

describe('publicHostOf', () => {
  it('gives the lower-cased host and port', () => {
    expect(publicHostOf('https://Me.Example.com/path')).toBe('me.example.com');
    expect(publicHostOf('https://me.example.com:8443/')).toBe('me.example.com:8443');
    expect(publicHostOf('https://me.example.com:443/')).toBe('me.example.com');
  });

  it('gives nothing for other URLs', () => {
    expect(publicHostOf('http://me.example.com')).toBeUndefined();
    expect(publicHostOf('not a url')).toBeUndefined();
    expect(publicHostOf('https://user:pw@me.example.com')).toBeUndefined();
  });
});

describe('LastLine', () => {
  it('keeps the last non-empty line across chunks', () => {
    const l = new LastLine();
    expect(l.value).toBe('');
    l.push('first\nsec');
    expect(l.value).toBe('sec');
    l.push('ond line\n\n  \n');
    expect(l.value).toBe('second line');
    l.push('\x1b[31mError: denied\x1b[0m\r\n');
    expect(l.value).toBe('Error: denied');
  });

  it('caps a long line', () => {
    const l = new LastLine();
    l.push('x'.repeat(10_000));
    expect(l.value.length).toBeLessThanOrEqual(500);
  });
});
