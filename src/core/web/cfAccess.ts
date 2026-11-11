import { createPublicKey, type JsonWebKey, type KeyObject, verify } from 'node:crypto';

/**
 * Cloudflare Access's signed token (`Cf-Access-Jwt-Assertion`), checked as Cloudflare documents: RS256, signed by one
 * of the team's keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, picked by `kid`), issued by
 * `https://<team>.cloudflareaccess.com`, for the application's AUD tag, and not expired. The email it names is who is
 * visiting. The email header Cloudflare also sends is never trusted: without an Access policy in front of the tunnel,
 * anyone could set it.
 */

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const accessIssuer = (team: string) => `https://${team}.cloudflareaccess.com`;
export const accessCertsUrl = (team: string) => `${accessIssuer(team)}/cdn-cgi/access/certs`;

/** Clock difference allowed on exp and nbf, in seconds. */
const LEEWAY_S = 60;

export type AccessKeys = ReadonlyMap<string, KeyObject>;

/** The RSA keys of a certs response (`{ keys: [JWK…] }`), by kid; keys that are not RSA signing keys are skipped. */
export function parseAccessCerts(raw: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (raw as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list as Record<string, unknown>[]) {
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey, format: 'jwk' }));
    } catch {
      // not a usable key
    }
  }
  return keys;
}

const b64json = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

export type AccessCheck = { ok: true; email: string } | { ok: false; reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'bad-claims' };

/** Checks `token` against `keys` for `team` and `audience` at `nowS` (seconds). `unknown-key`: refresh the keys. */
export function checkAccessToken(token: string, o: { keys: AccessKeys; team: string; audience: string; nowS: number }): AccessCheck {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const header = b64json(parts[0]) as { alg?: unknown; kid?: unknown } | undefined;
  const claims = b64json(parts[1]) as Record<string, unknown> | undefined;
  if (!header || !claims || typeof claims !== 'object' || header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };
  const key = o.keys.get(header.kid);
  if (!key) return { ok: false, reason: 'unknown-key' };
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) return { ok: false, reason: 'bad-signature' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const exp = claims.exp;
  const nbf = claims.nbf;
  if (
    claims.iss !== accessIssuer(o.team) ||
    !o.audience ||
    !aud.includes(o.audience) ||
    typeof exp !== 'number' ||
    exp + LEEWAY_S < o.nowS ||
    (nbf !== undefined && (typeof nbf !== 'number' || nbf - LEEWAY_S > o.nowS)) ||
    typeof claims.email !== 'string' ||
    !claims.email
  ) {
    return { ok: false, reason: 'bad-claims' };
  }
  return { ok: true, email: claims.email };
}
