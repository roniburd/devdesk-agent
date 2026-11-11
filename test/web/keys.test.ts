import { describe, expect, it } from 'vitest';
import { isWebKey, keyArgs } from '../../src/core/web/keys';
import { WEB_KEYS } from '../../src/core/web/types';

describe('keys', () => {
  it.each(WEB_KEYS.map((k) => [k]))('sends %s as one key', (key) => {
    expect(keyArgs('%3', key)).toEqual(['send-keys', '-t', '%3', key]);
    expect(keyArgs('=cc-main:', key)).toEqual(['send-keys', '-t', '=cc-main:', key]);
  });

  it('knows the keys', () => {
    expect(isWebKey('Escape')).toBe(true);
    expect(isWebKey('C-c')).toBe(false);
    expect(isWebKey(undefined)).toBe(false);
    expect(isWebKey(1)).toBe(false);
  });

  it('throws on a bad target', () => {
    expect(() => keyArgs('cc-main', 'Enter')).toThrow();
    expect(() => keyArgs('%3;kill-server', 'Enter')).toThrow();
    expect(() => keyArgs('', 'Enter')).toThrow();
  });

  it('throws on a key outside the list', () => {
    expect(() => keyArgs('%3', 'C-c' as 'Enter')).toThrow();
  });
});
