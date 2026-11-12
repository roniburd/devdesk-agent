import type { TunnelPreview, WebAccessSettings } from './config';
import type { WebStatus } from './webState';

/** The Web Access view's rows (webAccessView.ts draws them): what runs, where, for whom, and from which version. No `vscode`. */

/** What a row does when clicked. */
export type WebPanelAction = 'start' | 'restart' | 'restartTunnel' | 'tunnelName' | 'copyUrl' | 'copyLocal' | 'openLog' | 'settings';

export interface WebPanelRow {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id. */
  icon: string;
  /** A theme color id for the icon. */
  color?: string;
  action?: WebPanelAction;
  /** For the row's inline buttons (`viewItem =~ /\\b…\\b/`): space-separated words; `copyable` when `copy` is set. */
  contextValue?: string;
  /** What the row's Copy button copies (a URL, pid, path, error…). */
  copy?: string;
}

/** Sets `copy` and adds `copyable` to the row's contextValue, so it gets a Copy button on hover. */
function copyable(row: WebPanelRow, copy: string | undefined): WebPanelRow {
  if (!copy) return row;
  return { ...row, copy, contextValue: [row.contextValue, 'copyable'].filter(Boolean).join(' ') };
}

/** The daemon's script and the extension version it came from, from its command line (`…/roniburd.devdesk-claude-1.6.0/dist/web.js --config …`). */
export function daemonScript(command: string): { script: string; version?: string } | undefined {
  const m = /(\S*\bweb\.js)(\s|$)/.exec(command);
  if (!m) return undefined;
  const version = /devdesk-claude(?:-beta)?-(\d[^/]*)\/dist\/web\.js$/.exec(m[1])?.[1];
  return version ? { script: m[1], version } : { script: m[1] };
}

export interface WebPanelInput {
  status: WebStatus;
  /** The running daemon's settings (its config file), when readable. */
  settings?: Pick<WebAccessSettings, 'auth' | 'allowedUsers' | 'identityHeader'> & Partial<Pick<WebAccessSettings, 'tunnel' | 'cloudflare'>>;
  /** The running daemon's script, when `ps` could tell; compared with `script`. */
  running?: { script: string; version?: string };
  /** This extension's `dist/web.js`. */
  script: string;
  /** The daemon's log file, for the Log row's Copy button. */
  logPath?: string;
  /** The tunnel the current settings name (webTunnelPreview()), when its command has {host}. */
  tunnelName?: TunnelPreview;
  now: number;
}

/** "5 min", "3 h", "2 days": how long ago `t` was. */
export function sinceText(t: number, now: number): string {
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function webPanelRows(o: WebPanelInput): WebPanelRow[] {
  if (o.status.kind === 'off') {
    return [
      {
        id: 'status',
        label: 'Off',
        description: 'Start it to use Claude from your phone',
        tooltip: 'Web access is off. Start it from the ▷ button, or click here.',
        icon: 'circle-slash',
        action: 'start',
      },
      ...(o.tunnelName ? [tunnelNameRow(o.tunnelName)] : []),
      { id: 'settings', label: 'Settings', icon: 'gear', action: 'settings' },
    ];
  }
  const s = o.status.state;
  const local = `http://${s.host}:${s.port}/`;
  const rows: WebPanelRow[] = [
    copyable({
      id: 'status',
      label: o.status.kind === 'tunnel-down' ? 'Running, tunnel down' : 'Running',
      description: `${sinceText(s.startedAt, o.now)} · pid ${s.pid}`,
      tooltip: `Started ${new Date(s.startedAt).toLocaleString()}, process ${s.pid}.`,
      icon: o.status.kind === 'tunnel-down' ? 'warning' : 'broadcast',
      color: o.status.kind === 'tunnel-down' ? 'problemsWarningIcon.foreground' : 'testing.iconPassed',
    }, String(s.pid)),
  ];
  // A daemon another version started keeps serving that version's page until it restarts (an update doesn't restart it).
  if (o.running && o.running.script !== o.script) {
    rows.push(copyable({
      id: 'outdated',
      label: o.running.version ? `Started by version ${o.running.version}` : 'Started by another version',
      description: 'Restart to update',
      tooltip: `The daemon runs ${o.running.script}, not this extension's ${o.script}: the phone gets that version's page. Click to restart it.`,
      icon: 'warning',
      color: 'problemsWarningIcon.foreground',
      action: 'restart',
    }, o.running.script));
  }
  if (s.url) {
    rows.push(copyable({ id: 'url', label: 'Phone URL', description: s.url, tooltip: `${s.url}\n\nClick to copy.`, icon: 'device-mobile', action: 'copyUrl', contextValue: 'webUrl' }, s.url));
  }
  if (s.tunnel !== 'none') {
    const tunnel = {
      up: { label: 'Tunnel up', icon: 'pass', color: 'testing.iconPassed' },
      starting: { label: 'Tunnel starting', icon: 'loading~spin', color: undefined },
      down: { label: 'Tunnel down', icon: 'error', color: 'problemsErrorIcon.foreground' },
    }[s.tunnel];
    rows.push(copyable({
      id: 'tunnel',
      label: tunnel.label,
      description: s.tunnel === 'down' ? s.tunnelError : s.tunnelPid ? `pid ${s.tunnelPid}` : undefined,
      tooltip: s.tunnel === 'down' ? `${s.tunnelError ?? 'The tunnel stopped.'}\n\nClick to restart it.` : 'Click to restart the tunnel.',
      icon: tunnel.icon,
      color: tunnel.color,
      action: 'restartTunnel',
      contextValue: 'webTunnel',
    }, s.tunnel === 'down' ? s.tunnelError : s.tunnelPid ? String(s.tunnelPid) : undefined));
  }
  if (o.tunnelName) rows.push(tunnelNameRow(o.tunnelName));
  rows.push(copyable({ id: 'local', label: 'Loopback URL', description: local, tooltip: `${local}\n\nFor ssh -L. Click to copy.`, icon: 'link', action: 'copyLocal' }, local));
  if (o.settings) {
    const access = accessRow(o.settings);
    rows.push(copyable(access, o.settings.auth === 'header' || o.settings.auth === 'cloudflare' ? o.settings.allowedUsers.join(', ') : undefined));
  }
  rows.push(copyable({ id: 'log', label: 'Log', description: 'daemon.log', tooltip: o.logPath ? `${o.logPath}\n\nClick to open.` : undefined, icon: 'output', action: 'openLog' }, o.logPath));
  return rows;
}

/** The tunnel's name (and URL), from `devdesk.web.tunnelName` or the host name; click to change it. */
function tunnelNameRow(t: TunnelPreview): WebPanelRow {
  const from = t.fromSetting ? `devdesk.web.tunnelName (${t.label})` : `this machine's host name (${t.label}); set devdesk.web.tunnelName to choose another`;
  return {
    id: 'tunnelName',
    label: 'Tunnel name',
    description: t.name,
    tooltip: `${t.name}${t.url ? `\n${t.url}` : ''}\n\nThis machine's part comes from ${from}. Click to change it.`,
    icon: 'tag',
    action: 'tunnelName',
    contextValue: 'webTunnelName',
  };
}

/** Who may use web access, as the running daemon checks it. */
function accessRow(c: NonNullable<WebPanelInput['settings']>): WebPanelRow {
  const users = c.allowedUsers;
  const warn = { color: 'problemsWarningIcon.foreground' };
  if (c.auth === 'loopback') {
    return {
      id: 'access',
      label: 'Access: no identity check',
      description: 'loopback',
      tooltip: 'devdesk.web.auth is loopback: any process on this host can open the page.',
      icon: 'unlock',
      ...warn,
      action: 'settings',
    };
  }
  if (c.auth === 'tunnel') {
    return {
      id: 'access',
      label: 'Access: the tunnel owner',
      description: 'Dev Tunnels',
      tooltip: 'Dev Tunnels lets in only the account that started it, and names no one: any process on this host can also open the page.',
      icon: 'unlock',
      ...warn,
      action: 'settings',
    };
  }
  if (c.auth === 'cloudflare') {
    const ready = users.length && c.cloudflare?.team && c.cloudflare.audience;
    return {
      id: 'access',
      label: users.length ? `Access: ${users.join(', ')}` : 'Access: nobody',
      description: 'Cloudflare Access',
      tooltip: ready
        ? `Requests with a Cloudflare Access token from ${c.cloudflare!.team}.cloudflareaccess.com naming ${users.join(' or ')}.`
        : 'devdesk.web.allowedUsers, devdesk.web.cloudflare.team or devdesk.web.cloudflare.audience is empty: every request is denied.',
      icon: 'lock',
      ...(ready ? {} : warn),
      action: 'settings',
    };
  }
  const ok = users.length && c.identityHeader;
  return {
    id: 'access',
    label: users.length ? `Access: ${users.join(', ')}` : 'Access: nobody',
    description: c.tunnel === 'tailscale' ? 'Tailscale' : c.tunnel === 'ngrok' ? 'ngrok sign-in' : c.identityHeader || 'no identity header',
    tooltip: ok
      ? `Requests whose ${c.identityHeader} header names ${users.join(' or ')}.`
      : 'devdesk.web.allowedUsers (or, for your own proxy, devdesk.web.identityHeader) is empty: every request is denied. Run Choose Web Access Tunnel to set it up.',
    icon: 'lock',
    ...(ok ? {} : warn),
    action: 'settings',
  };
}
