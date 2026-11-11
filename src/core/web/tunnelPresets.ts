/**
 * The tunnels web access can run for you (`devdesk.web.tunnel`): for each, the command, how the daemon tells who is
 * visiting, and which URL it prints is the one to open. Every preset keeps the tunnel's own sign-in on: none lets
 * anonymous visitors through. No `vscode`.
 */

export const TUNNEL_PRESETS = ['tailscale', 'devtunnel', 'cloudflare', 'ngrok'] as const;
export type TunnelPreset = (typeof TUNNEL_PRESETS)[number];
/** `auto`: the workspace kind's tunnel, else a custom command if set, else none until Start asks. */
export type TunnelChoice = 'auto' | TunnelPreset | 'custom' | 'none';
export const TUNNEL_CHOICES: readonly TunnelChoice[] = ['auto', ...TUNNEL_PRESETS, 'custom', 'none'];

export const isTunnelPreset = (v: unknown): v is TunnelPreset => (TUNNEL_PRESETS as readonly unknown[]).includes(v);
export const tunnelChoiceOf = (v: unknown): TunnelChoice => ((TUNNEL_CHOICES as readonly unknown[]).includes(v) ? (v as TunnelChoice) : 'auto');

/**
 * How the daemon decides who may use it. `header`: the proxy names the visitor in `identityHeader`, who must be in
 * `allowedUsers`. `loopback`: no check (ssh -L). `tunnel`: the tunnel lets in only its owner and names no one, so the
 * daemon checks nothing more (Dev Tunnels). `cloudflare`: Cloudflare Access's signed token, checked against the team's
 * keys, names an allowed user.
 */
export type DaemonAuth = 'header' | 'loopback' | 'tunnel' | 'cloudflare';

/** The header the ngrok traffic policy names the visitor in (after removing any value the browser sent). */
export const NGROK_USER_HEADER = 'x-devdesk-user';
export const NGROK_OAUTH_PROVIDERS = ['google', 'github', 'microsoft', 'gitlab'] as const;
export type NgrokOAuthProvider = (typeof NGROK_OAUTH_PROVIDERS)[number];
export const ngrokProviderOf = (v: unknown): NgrokOAuthProvider =>
  (NGROK_OAUTH_PROVIDERS as readonly unknown[]).includes(v) ? (v as NgrokOAuthProvider) : 'google';

/** What the daemon runs for a preset. */
export interface TunnelSpec {
  /** With {port}, {user}, {host}, {publicHost} and {ngrokPolicy} (see fillTunnelCommand). */
  command: string;
  auth: DaemonAuth;
  /** Lower-cased; '' for `tunnel` and `cloudflare`. */
  identityHeader: string;
  /** Regex source the URL's host must match ('' any); the configured public host always matches. */
  urlHost: string;
  /** Regex source: once a line matches, the tunnel is up at https://<publicHost>/ (for tunnels that print no URL). */
  readyLine: string;
  /** Regex source for an https link the tunnel prints for you to open (to turn something on), not the URL. */
  actionHost: string;
}

/** Tailscale's CLI: on PATH, or inside the macOS app. */
const TAILSCALE = '"$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"';

/** The spec of `preset`. ngrok's policy file is written by the daemon (ngrokPolicy) to {ngrokPolicy}. */
export function presetSpec(preset: TunnelPreset, o: { publicHost: string }): TunnelSpec {
  switch (preset) {
    case 'tailscale':
      // Foreground: serving stops with the daemon. Serve sets Tailscale-User-Login and strips any the client sent.
      return {
        command: `${TAILSCALE} serve {port}`,
        auth: 'header',
        identityHeader: 'tailscale-user-login',
        urlHost: String.raw`\.ts\.net$`,
        readyLine: '',
        actionHost: String.raw`^login\.tailscale\.com$`,
      };
    case 'devtunnel':
      // A temporary tunnel, private to the signed-in user (no --allow-anonymous), deleted when it stops.
      return {
        command: 'devtunnel host -p {port}',
        auth: 'tunnel',
        identityHeader: '',
        // https://<id>-<port>.<cluster>.devtunnels.ms, not the -inspect one.
        urlHost: String.raw`^[a-z0-9]+-\d+\.[a-z0-9]+\.devtunnels\.ms$`,
        readyLine: '',
        actionHost: '',
      };
    case 'cloudflare':
      // A named tunnel per machine, created and routed to the public host on first run; Access sits in front of it.
      return {
        command:
          'cloudflared tunnel info devdesk-{host} >/dev/null 2>&1 || cloudflared tunnel create devdesk-{host} || exit 1; ' +
          'cloudflared tunnel route dns --overwrite-dns devdesk-{host} {publicHost} || exit 1; ' +
          'exec cloudflared tunnel run --url http://127.0.0.1:{port} devdesk-{host}',
        auth: 'cloudflare',
        identityHeader: '',
        // It prints no URL of its own (only links to its docs): only the public host is one.
        urlHost: '^$',
        readyLine: o.publicHost ? 'Registered tunnel connection' : '',
        actionHost: '',
      };
    case 'ngrok':
      return {
        command: `ngrok http 127.0.0.1:{port} --traffic-policy-file {ngrokPolicy}${o.publicHost ? ' --url {publicHost}' : ''} --log stdout --log-format logfmt`,
        auth: 'header',
        identityHeader: NGROK_USER_HEADER,
        urlHost: String.raw`\.ngrok(-free)?\.(app|dev|io)$`,
        readyLine: '',
        actionHost: '',
      };
  }
}

/** An email ngrok can match: no quotes, backslashes, spaces or control characters (it goes into a CEL string). */
export const isPlainEmail = (s: string) => /^[^\s'"\\@]+@[^\s'"\\@]+\.[^\s'"\\@]+$/.test(s) && !/[\x00-\x1f\x7f]/.test(s);

/**
 * ngrok's traffic policy: sign in with `provider`, deny anyone not in `emails`, then name the visitor in
 * NGROK_USER_HEADER (removing any the browser sent first, as add-headers appends). Emails that are not plain are left
 * out; with none left, everyone is denied.
 */
export function ngrokPolicy(emails: readonly string[], provider: NgrokOAuthProvider): string {
  const list = emails.filter(isPlainEmail).map((e) => `'${e}'`).join(', ');
  return [
    'on_http_request:',
    '  - actions:',
    '      - type: oauth',
    '        config:',
    `          provider: ${provider}`,
    '  - expressions:',
    `      - "!(actions.ngrok.oauth.identity.email in [${list}])"`,
    '    actions:',
    '      - type: deny',
    '        config:',
    '          status_code: 403',
    '  - actions:',
    '      - type: remove-headers',
    '        config:',
    '          headers:',
    `            - ${NGROK_USER_HEADER}`,
    '      - type: add-headers',
    '        config:',
    '          headers:',
    `            ${NGROK_USER_HEADER}: "\${actions.ngrok.oauth.identity.email}"`,
    '',
  ].join('\n');
}

/**
 * A Dev Tunnels command that would let anyone in: `--allow-anonymous` / `-a`, or an anonymous access entry. The
 * daemon refuses `tunnel` auth with one, since it checks no one itself.
 */
export function allowsAnonymous(command: string): boolean {
  return /(^|\s)(--allow-anonymous|-a)(\s|=|$)/.test(command) || /\baccess\s+create\b.*--anonymous/.test(command);
}

/** Cloudflare's team name from what was typed (`team`, `team.cloudflareaccess.com`, or its https URL); '' if invalid. */
export function cloudflareTeamOf(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '').replace(/\.cloudflareaccess\.com$/, '');
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(t) ? t : '';
}

/** A Cloudflare Access application's AUD tag (hex), lower-cased; '' if invalid. */
export function cloudflareAudienceOf(v: unknown): string {
  if (typeof v !== 'string') return '';
  const a = v.trim().toLowerCase();
  return /^[0-9a-f]{32,128}$/.test(a) ? a : '';
}

/** Which URL the tunnel printed: the one to open, a link for you to open first, or neither. */
export function classifyTunnelUrl(url: string, spec: Pick<TunnelSpec, 'urlHost' | 'actionHost'>, publicHost: string): 'url' | 'action' | 'other' {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return 'other';
    host = u.hostname.toLowerCase();
    if (publicHost && u.host.toLowerCase().replace(/:443$/, '') === publicHost.replace(/:443$/, '')) return 'url';
  } catch {
    return 'other';
  }
  if (spec.actionHost && new RegExp(spec.actionHost).test(host)) return 'action';
  if (!spec.urlHost || new RegExp(spec.urlHost).test(host)) return 'url';
  return 'other';
}
