import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorize } from '../../src/core/web/auth';
import { accessCertsUrl, checkAccessToken, parseAccessCerts } from '../../src/core/web/cfAccess';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const keys = parseAccessCerts({ keys: [jwk, { kty: 'EC', kid: 'ec' }, { kty: 'RSA' }] });
const AUD = 'b'.repeat(64);
const NOW = 1_800_000_000;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(claims: Record<string, unknown>, o: { kid?: string; alg?: string; key?: typeof privateKey } = {}): string {
  const head = b64({ alg: o.alg ?? 'RS256', kid: o.kid ?? 'k1', typ: 'JWT' });
  const body = b64({ iss: 'https://acme.cloudflareaccess.com', aud: [AUD], exp: NOW + 600, iat: NOW, email: 'me@example.com', ...claims });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), o.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const opts = { keys, team: 'acme', audience: AUD, nowS: NOW };

describe('Cloudflare Access tokens', () => {
  it('reads the RSA keys of the certs response by kid', () => {
    expect([...keys.keys()]).toEqual(['k1']);
    expect(parseAccessCerts(null).size).toBe(0);
    expect(accessCertsUrl('acme')).toBe('https://acme.cloudflareaccess.com/cdn-cgi/access/certs');
  });

  it('accepts a token signed by the team for the application', () => {
    expect(checkAccessToken(token({}), opts)).toEqual({ ok: true, email: 'me@example.com' });
    expect(checkAccessToken(token({ aud: AUD }), opts)).toEqual({ ok: true, email: 'me@example.com' });
  });

  it('refuses everything else', () => {
    expect(checkAccessToken(token({}, { key: other.privateKey }), opts)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(checkAccessToken(token({}, { kid: 'k2' }), opts)).toEqual({ ok: false, reason: 'unknown-key' });
    expect(checkAccessToken(token({}, { alg: 'none' }), opts)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkAccessToken(token({}, { alg: 'HS256' }), opts)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkAccessToken(token({ iss: 'https://evil.cloudflareaccess.com' }), opts)).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken(token({ aud: ['c'.repeat(64)] }), opts)).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken(token({ exp: NOW - 120 }), opts)).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken(token({ exp: undefined }), opts)).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken(token({ nbf: NOW + 120 }), opts)).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken(token({ email: '' }), opts)).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken(token({}), { ...opts, audience: '' })).toEqual({ ok: false, reason: 'bad-claims' });
    expect(checkAccessToken('a.b', opts)).toEqual({ ok: false, reason: 'malformed' });
    const [h, , s] = token({}).split('.');
    expect(checkAccessToken(`${h}.${b64({ iss: 'https://acme.cloudflareaccess.com', aud: [AUD], exp: NOW + 600, email: 'you@example.com' })}.${s}`, opts)).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

describe('authorize with cloudflare and tunnel auth', () => {
  const cf = { auth: 'cloudflare' as const, identityHeader: '', allowedUsers: ['me@example.com'], cloudflare: { team: 'acme', audience: AUD } };

  it('lets in the allowed email of a verified token, and never the email header', () => {
    expect(authorize({ 'cf-access-jwt-assertion': token({}) }, cf, { accessKeys: keys, nowS: NOW })).toEqual({ ok: true, user: 'me@example.com' });
    expect(authorize({ 'cf-access-jwt-assertion': token({ email: 'you@example.com' }) }, cf, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'not-allowed' });
    expect(authorize({ 'cf-access-authenticated-user-email': 'me@example.com' }, cf, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'no-identity' });
    expect(authorize({ 'cf-access-jwt-assertion': [token({}), token({})] }, cf, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'no-identity' });
  });

  it('asks for the keys again for an unknown key', () => {
    expect(authorize({ 'cf-access-jwt-assertion': token({}, { kid: 'k9' }) }, cf, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'no-identity', unknownKey: true });
  });

  it('denies everyone until configured and the keys are fetched', () => {
    const t = { 'cf-access-jwt-assertion': token({}) };
    expect(authorize(t, cf, { nowS: NOW })).toEqual({ ok: false, reason: 'not-configured' });
    expect(authorize(t, { ...cf, cloudflare: { team: '', audience: AUD } }, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'not-configured' });
    expect(authorize(t, { ...cf, cloudflare: { team: 'acme', audience: '' } }, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'not-configured' });
    expect(authorize(t, { ...cf, allowedUsers: [] }, { accessKeys: keys, nowS: NOW })).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('tunnel auth leaves the check to the tunnel', () => {
    expect(authorize({}, { auth: 'tunnel', identityHeader: '', allowedUsers: [] })).toEqual({ ok: true });
  });
});
