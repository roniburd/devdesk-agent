import { describe, expect, it } from 'vitest';
import { isMutating, MAX_BODY_BYTES, MAX_TEXT_BYTES, parseKeyBody, parseNewSessionBody, parseRoute, parseSendBody } from '../../src/core/web/routes';

describe('parseRoute', () => {
  it.each([
    ['GET', '/', { kind: 'page', asset: 'html' }],
    ['GET', '/app.js', { kind: 'page', asset: 'js' }],
    ['GET', '/app.css', { kind: 'page', asset: 'css' }],
    ['GET', '/api/sessions', { kind: 'cards' }],
    ['GET', '/api/events', { kind: 'events' }],
    ['GET', '/api/folders', { kind: 'folders' }],
    ['POST', '/api/sessions', { kind: 'start' }],
    ['GET', '/api/sessions/abc-123', { kind: 'detail', id: 'abc-123' }],
    ['POST', '/api/sessions/abc-123/send', { kind: 'send', id: 'abc-123' }],
    ['POST', '/api/sessions/abc-123/key', { kind: 'key', id: 'abc-123' }],
  ])('%s %s', (method, path, route) => {
    expect(parseRoute(method, path)).toEqual(route);
  });

  it('decodes ids', () => {
    expect(parseRoute('GET', '/api/sessions/tmux%3Adevdesk%3A%253')).toEqual({ kind: 'detail', id: 'tmux:devdesk:%3' });
    expect(parseRoute('POST', '/api/sessions/tmux%3Adevdesk%3Acc-main/send')).toEqual({ kind: 'send', id: 'tmux:devdesk:cc-main' });
  });

  it('ignores a query', () => {
    expect(parseRoute('GET', '/api/sessions?x=1')).toEqual({ kind: 'cards' });
  });

  it.each([
    ['GET', '/nope'],
    ['GET', '/index.html'],
    ['GET', '/api'],
    ['GET', '/api/sessions/'],
    ['GET', '/api/sessions/a/b'],
    ['POST', '/api/sessions/a/kill'],
    ['GET', '/api/sessions/%E0'],
    ['GET', '/api/sessions/..'],
    ['GET', '/api/sessions/.'],
    ['GET', '/api/sessions/%2E%2E'],
    ['GET', '/api/sessions/a%2Fb'],
    ['GET', '/api/../app.js'],
    ['GET', '//app.js'],
    ['GET', '/app.js/'],
    ['GET', ''],
    ['GET', 'app.js'],
  ])('404 for %s %s', (method, path) => {
    expect(parseRoute(method, path)).toEqual({ status: 404 });
  });

  it.each([
    ['POST', '/'],
    ['DELETE', '/api/sessions'],
    ['PUT', '/api/sessions'],
    ['POST', '/api/events'],
    ['POST', '/api/folders'],
    ['POST', '/api/sessions/abc'],
    ['GET', '/api/sessions/abc/send'],
    ['GET', '/api/sessions/abc/key'],
    ['HEAD', '/'],
    ['OPTIONS', '/api/sessions'],
  ])('405 for %s %s', (method, path) => {
    expect(parseRoute(method, path)).toEqual({ status: 405 });
  });

  it('marks the mutating routes', () => {
    expect(isMutating({ kind: 'send', id: 'a' })).toBe(true);
    expect(isMutating({ kind: 'key', id: 'a' })).toBe(true);
    expect(isMutating({ kind: 'start' })).toBe(true);
    expect(isMutating({ kind: 'cards' })).toBe(false);
    expect(isMutating({ kind: 'detail', id: 'a' })).toBe(false);
    expect(isMutating({ kind: 'page', asset: 'html' })).toBe(false);
  });

  it('caps bodies above the text cap', () => {
    expect(MAX_TEXT_BYTES).toBe(65536);
    expect(MAX_BODY_BYTES).toBe(131072);
  });
});

describe('parseSendBody', () => {
  it('accepts text', () => {
    expect(parseSendBody({ text: 'hello' })).toEqual({ text: 'hello' });
    expect(parseSendBody({ text: 'hello', extra: 1 })).toEqual({ text: 'hello' });
  });

  it.each([[null], ['hello'], [[]], [{}], [{ text: 1 }], [{ text: null }], [{ text: '' }], [{ text: '  \n ' }]])('400 for %j', (raw) => {
    expect(parseSendBody(raw)).toMatchObject({ status: 400 });
  });

  it('413 over 64 KiB, counting bytes', () => {
    expect(parseSendBody({ text: 'a'.repeat(MAX_TEXT_BYTES) })).toEqual({ text: 'a'.repeat(MAX_TEXT_BYTES) });
    expect(parseSendBody({ text: 'a'.repeat(MAX_TEXT_BYTES + 1) })).toMatchObject({ status: 413 });
    // 3 bytes each: under the cap in characters, over it in bytes.
    expect(parseSendBody({ text: '€'.repeat(30000) })).toMatchObject({ status: 413 });
  });
});

describe('parseKeyBody', () => {
  it.each(['1', '9', 'Enter', 'Escape', 'Up', 'Down'])('accepts %s', (key) => {
    expect(parseKeyBody({ key })).toEqual({ key });
  });

  it.each([[{ key: 'C-c' }], [{ key: 'Enter;kill-server' }], [{ key: 'enter' }], [{ key: '0' }], [{ key: '10' }], [{ key: 1 }], [{}], [null], ['Enter']])(
    '400 for %j',
    (raw) => {
      expect(parseKeyBody(raw)).toMatchObject({ status: 400 });
    },
  );
});

describe('parseNewSessionBody', () => {
  it('accepts a dir and a prompt', () => {
    expect(parseNewSessionBody({ dir: '/w', prompt: 'fix it' })).toEqual({ dir: '/w', prompt: 'fix it' });
    expect(parseNewSessionBody({ dir: '/w', prompt: '' })).toEqual({ dir: '/w', prompt: '' });
    expect(parseNewSessionBody({ dir: '/w' })).toEqual({ dir: '/w', prompt: '' });
  });

  it.each([[null], [{}], [{ dir: '' }], [{ dir: 3, prompt: '' }], [{ dir: '/w', prompt: 3 }], [{ dir: ['/w'] }]])('400 for %j', (raw) => {
    expect(parseNewSessionBody(raw)).toMatchObject({ status: 400 });
  });

  it('413 for a long prompt', () => {
    expect(parseNewSessionBody({ dir: '/w', prompt: 'a'.repeat(MAX_TEXT_BYTES + 1) })).toMatchObject({ status: 413 });
  });
});
