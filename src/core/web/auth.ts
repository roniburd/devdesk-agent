import type { DaemonConfig } from './config';

/**
 * Who may use web access, and which requests reach it at all. The daemon listens on 127.0.0.1 only; a proxy in front
 * authenticates visitors and names them in a header (`identityHeader`). Everything fails closed: header auth with no
 * header or no allowed users configured denies every request.
 */

/** node's lower-cased IncomingHttpHeaders. */
export type Headers = Readonly<Record<string, string | string[] | undefined>>;
export type AuthDecision = { ok: true; user?: string } | { ok: false; reason: 'not-configured' | 'no-identity' | 'not-allowed' };

/**
 * loopback: ok. header: not-configured when identityHeader or allowedUsers is empty; no-identity when the header is
 * missing, empty or repeated (array); not-allowed unless the value === one of allowedUsers (no trimming, no case folding).
 */
export function authorize(headers: Headers, c: Pick<DaemonConfig, 'auth' | 'identityHeader' | 'allowedUsers'>): AuthDecision {
  if (c.auth === 'loopback') return { ok: true };
  if (!c.identityHeader || !c.allowedUsers.length) return { ok: false, reason: 'not-configured' };
  const value = headers[c.identityHeader.toLowerCase()];
  if (typeof value !== 'string' || !value) return { ok: false, reason: 'no-identity' };
  return c.allowedUsers.some((u) => u === value) ? { ok: true, user: value } : { ok: false, reason: 'not-allowed' };
}

/**
 * The public host the Host and Origin checks accept: none in loopback mode (only `127.0.0.1:<port>` and
 * `localhost:<port>` then pass, as `ssh -L` gives), so nothing that comes in through a tunnel skips the identity check.
 */
export function answeredPublicHost(c: Pick<DaemonConfig, 'auth'>, publicHost: string): string {
  return c.auth === 'loopback' ? '' : publicHost;
}

/** A host[:port] as compared: lower-cased, `:443` dropped (an https URL's default port). */
const normalHost = (h: string) => h.trim().toLowerCase().replace(/:443$/, '');

const loopbackHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];

const isLoopbackHost = (host: string, port: number) => loopbackHosts(port).includes(normalHost(host));

/** Host is `127.0.0.1:<port>`, `localhost:<port>`, or publicHost (case-insensitive; publicHost with or without `:443`). */
export function hostAllowed(host: string | undefined, port: number, publicHost: string): boolean {
  if (!host) return false;
  const h = normalHost(host);
  if (!h) return false;
  if (loopbackHosts(port).includes(h)) return true;
  return !!publicHost && h === normalHost(publicHost);
}

const single = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * For POST: Origin passes, and Content-Type is application/json (parameters allowed). Origin passes when it is an
 * http(s) origin whose host is allowed and either equals Host, or Host is loopback (a proxy that rewrites Host) and
 * Origin is the public host.
 */
export function mutationCheck(h: Headers, port: number, publicHost: string): { ok: true } | { ok: false; status: 403 | 415; message: string } {
  const origin = single(h.origin);
  const host = single(h.host);
  const denied = { ok: false as const, status: 403 as const, message: 'This request did not come from the DevDesk page.' };
  if (!origin || !host) return denied;
  let originHost: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return denied;
    // An Origin header is scheme://host[:port], nothing more.
    if (url.origin !== origin.toLowerCase()) return denied;
    originHost = url.host;
  } catch {
    return denied;
  }
  if (!hostAllowed(originHost, port, publicHost) || !hostAllowed(host, port, publicHost)) return denied;
  const same = normalHost(originHost) === normalHost(host);
  const viaProxy = isLoopbackHost(host, port) && !!publicHost && normalHost(originHost) === normalHost(publicHost);
  if (!same && !viaProxy) return denied;
  const type = single(h['content-type'])?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { ok: false, status: 415, message: 'Send JSON (Content-Type: application/json).' };
  return { ok: true };
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

const DENIED_TEXT: Readonly<Record<'not-configured' | 'no-identity' | 'not-allowed' | 'host', string>> = {
  'not-configured':
    'Web access is not set up to let anyone in. Set devdesk.web.identityHeader (the header your proxy names the visitor in) and devdesk.web.allowedUsers (who may use it), or set devdesk.web.auth to loopback when only an SSH port forward reaches this host.',
  'no-identity':
    'This request did not come through the identity proxy set up for web access (devdesk.web.identityHeader). Open DevDesk through the proxy URL.',
  'not-allowed': 'You are not in devdesk.web.allowedUsers.',
  host: 'This address is not one web access answers on. Open it through 127.0.0.1, or set devdesk.web.publicHost to the address your proxy uses.',
};

/** The 403 page: static text naming the settings to configure (never the allowed users or the expected header value). */
export function deniedPage(reason: (AuthDecision & { ok: false }) | { reason: 'host' }): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>DevDesk: access denied</title></head>',
    `<body><h1>Access denied</h1><p>${DENIED_TEXT[reason.reason]}</p></body></html>`,
    '',
  ].join('\n');
}
