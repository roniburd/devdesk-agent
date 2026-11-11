import { cloudflareAudienceOf, cloudflareTeamOf, isPlainEmail, type NgrokOAuthProvider, type TunnelChoice, type TunnelPreset } from './tunnelPresets';

/**
 * What "Choose Web Access Tunnel" (and the first Start with no tunnel) shows and checks for each preset: the tool to
 * look for, where to get it, how to sign in, how to read who you are, and the settings it writes. No `vscode`.
 */

export interface PresetInfo {
  label: string;
  /** Who can reach web access through it. */
  detail: string;
  /** The program to look for on PATH. */
  tool: string;
  installUrl: string;
  /** The command that signs in (run in a terminal). */
  signIn: string;
}

export const PRESET_INFO: Readonly<Record<TunnelPreset, PresetInfo>> = {
  tailscale: {
    label: 'Tailscale',
    detail: 'Only your devices on your tailnet, and only your login. No public URL.',
    tool: 'tailscale',
    installUrl: 'https://tailscale.com/download',
    signIn: 'tailscale up',
  },
  devtunnel: {
    label: 'Microsoft Dev Tunnels',
    detail: 'Only your GitHub or Microsoft account can open it. New URL each start.',
    tool: 'devtunnel',
    installUrl: 'https://learn.microsoft.com/azure/developer/dev-tunnels/get-started',
    signIn: 'devtunnel user login -g',
  },
  cloudflare: {
    label: 'Cloudflare Tunnel',
    detail: 'On your own domain, behind a Cloudflare Access policy. Needs a domain on Cloudflare.',
    tool: 'cloudflared',
    installUrl: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    signIn: 'cloudflared tunnel login',
  },
  ngrok: {
    label: 'ngrok',
    detail: 'A public URL behind ngrok sign-in that lets in only your email.',
    tool: 'ngrok',
    installUrl: 'https://ngrok.com/download',
    signIn: 'ngrok config add-authtoken <your authtoken>',
  },
};

export const CLOUDFLARE_ACCESS_GUIDE = 'https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/';
export const NGROK_AUTHTOKEN_URL = 'https://dashboard.ngrok.com/get-started/your-authtoken';
export const TAILSCALE_MAC_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** The order the picker lists them in: Tailscale first (recommended). */
export const PICKER_ORDER: readonly TunnelPreset[] = ['tailscale', 'devtunnel', 'cloudflare', 'ngrok'];

/** Your Tailscale login from `tailscale status --json`, or why there is none. */
export function tailscaleLogin(json: string): { login: string } | { problem: string } {
  let r: { BackendState?: unknown; Self?: { UserID?: unknown }; User?: Record<string, { LoginName?: unknown }> };
  try {
    r = JSON.parse(json);
  } catch {
    return { problem: 'Tailscale did not say who you are.' };
  }
  if (r.BackendState !== 'Running') {
    return { problem: `Tailscale is not connected${typeof r.BackendState === 'string' ? ` (${r.BackendState})` : ''}. Sign in and connect, then try again.` };
  }
  const login = r.User?.[String(r.Self?.UserID)]?.LoginName;
  return typeof login === 'string' && login ? { login } : { problem: 'Tailscale did not say who you are (is this a tagged device?).' };
}

/** Who `devtunnel user show` says is signed in, or undefined when no one. */
export function devtunnelUser(text: string): string | undefined {
  const m = /Logged in as (\S+?)\.?(?:\s|$)/.exec(text);
  return m ? m[1] : undefined;
}

/** True when an ngrok config file has an authtoken. */
export function ngrokHasAuthtoken(yaml: string): boolean {
  return /^\s*authtoken:\s*["']?[A-Za-z0-9_]{10,}/m.test(yaml);
}

/** The ngrok config file `ngrok config check` names ("Valid configuration file at <path>"). */
export function ngrokConfigPath(text: string): string | undefined {
  return /configuration file at (\S+)/.exec(text)?.[1];
}

/** A host name for publicHost (`host` or `host:port`, letters, digits, dots and dashes), lower-cased; '' if not. */
export function hostNameOf(v: string): string {
  const h = v.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/.test(h) ? h : '';
}

/** The validation message for an input box (undefined: fine). */
export const check = {
  email: (v: string) => (isPlainEmail(v.trim()) ? undefined : 'An email address, like you@example.com.'),
  host: (v: string) => (hostNameOf(v) ? undefined : 'A host name, like devdesk.example.com.'),
  team: (v: string) => (cloudflareTeamOf(v) ? undefined : 'Your team name: the <team> in <team>.cloudflareaccess.com.'),
  audience: (v: string) => (cloudflareAudienceOf(v) ? undefined : 'The AUD tag: a long hex string from the Access application.'),
};

/** What the setup gathered for a preset. */
export type SetupAnswers =
  | { tunnel: 'tailscale'; login: string }
  | { tunnel: 'devtunnel' }
  | { tunnel: 'cloudflare'; email: string; host: string; team: string; audience: string }
  | { tunnel: 'ngrok'; email: string; provider: NgrokOAuthProvider }
  | { tunnel: 'custom' | 'none' };

/** The `devdesk.web.*` settings (keys without the prefix) to write for `a`; undefined values are reset. */
export function setupSettings(a: SetupAnswers): Record<string, unknown> {
  const tunnel: TunnelChoice = a.tunnel;
  switch (a.tunnel) {
    case 'tailscale':
      return { tunnel, allowedUsers: [a.login] };
    case 'devtunnel':
      return { tunnel };
    case 'cloudflare':
      return {
        tunnel,
        allowedUsers: [a.email.trim()],
        publicHost: hostNameOf(a.host),
        'cloudflare.team': cloudflareTeamOf(a.team),
        'cloudflare.audience': cloudflareAudienceOf(a.audience),
      };
    case 'ngrok':
      return { tunnel, allowedUsers: [a.email.trim()], 'ngrok.oauthProvider': a.provider };
    default:
      return { tunnel };
  }
}

/** A hint for a tunnel that went down, from its last error line; undefined when none applies. */
export function tunnelHint(tunnel: TunnelPreset | '', error: string): string | undefined {
  const e = error.toLowerCase();
  if (tunnel === 'tailscale') {
    if (/access denied|permission|operator/.test(e)) return 'On Linux, let your user run Tailscale Serve once with: sudo tailscale set --operator=$USER';
    if (/not found/.test(e)) return 'Install Tailscale, or run Choose Web Access Tunnel again.';
    if (/https|serve is not enabled|feature/.test(e)) return 'Turn on HTTPS certificates (and Serve) for your tailnet in the Tailscale admin console.';
  }
  if (tunnel === 'devtunnel' && /login|sign in|unauthorized/.test(e)) return `Sign in with: ${PRESET_INFO.devtunnel.signIn}`;
  if (tunnel === 'cloudflare' && /cert\.pem|origin certificate|login/.test(e)) return `Sign in with: ${PRESET_INFO.cloudflare.signIn}`;
  if (tunnel === 'ngrok' && /authtoken|err_ngrok_4018|authentication failed/.test(e)) return `Add your authtoken (${NGROK_AUTHTOKEN_URL}): ngrok config add-authtoken <token>`;
  if (/not found/.test(e) && tunnel) return `Install ${PRESET_INFO[tunnel].label} (${PRESET_INFO[tunnel].installUrl}), or run Choose Web Access Tunnel again.`;
  return undefined;
}
