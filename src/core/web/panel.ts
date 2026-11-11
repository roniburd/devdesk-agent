import type { WebAccessSettings } from './config';
import type { WebStatus } from './webState';

/** The Web Access view's rows (webAccessView.ts draws them): what runs, where, for whom, and from which version. No `vscode`. */

/** What a row does when clicked. */
export type WebPanelAction = 'start' | 'restart' | 'restartTunnel' | 'copyUrl' | 'copyLocal' | 'openLog' | 'settings';

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
  /** For the row's inline buttons (`viewItem == …`). */
  contextValue?: string;
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
  settings?: Pick<WebAccessSettings, 'auth' | 'allowedUsers' | 'identityHeader'>;
  /** The running daemon's script, when `ps` could tell; compared with `script`. */
  running?: { script: string; version?: string };
  /** This extension's `dist/web.js`. */
  script: string;
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
      { id: 'settings', label: 'Settings', icon: 'gear', action: 'settings' },
    ];
  }
  const s = o.status.state;
  const local = `http://${s.host}:${s.port}/`;
  const rows: WebPanelRow[] = [
    {
      id: 'status',
      label: o.status.kind === 'tunnel-down' ? 'Running, tunnel down' : 'Running',
      description: `${sinceText(s.startedAt, o.now)} · pid ${s.pid}`,
      tooltip: `Started ${new Date(s.startedAt).toLocaleString()}, process ${s.pid}.`,
      icon: o.status.kind === 'tunnel-down' ? 'warning' : 'broadcast',
      color: o.status.kind === 'tunnel-down' ? 'problemsWarningIcon.foreground' : 'testing.iconPassed',
    },
  ];
  // A daemon another version started keeps serving that version's page until it restarts (an update doesn't restart it).
  if (o.running && o.running.script !== o.script) {
    rows.push({
      id: 'outdated',
      label: o.running.version ? `Started by version ${o.running.version}` : 'Started by another version',
      description: 'Restart to update',
      tooltip: `The daemon runs ${o.running.script}, not this extension's ${o.script}: the phone gets that version's page. Click to restart it.`,
      icon: 'warning',
      color: 'problemsWarningIcon.foreground',
      action: 'restart',
    });
  }
  if (s.url) {
    rows.push({ id: 'url', label: 'Phone URL', description: s.url, tooltip: `${s.url}\n\nClick to copy.`, icon: 'device-mobile', action: 'copyUrl', contextValue: 'webUrl' });
  }
  if (s.tunnel !== 'none') {
    const tunnel = {
      up: { label: 'Tunnel up', icon: 'pass', color: 'testing.iconPassed' },
      starting: { label: 'Tunnel starting', icon: 'loading~spin', color: undefined },
      down: { label: 'Tunnel down', icon: 'error', color: 'problemsErrorIcon.foreground' },
    }[s.tunnel];
    rows.push({
      id: 'tunnel',
      label: tunnel.label,
      description: s.tunnel === 'down' ? s.tunnelError : s.tunnelPid ? `pid ${s.tunnelPid}` : undefined,
      tooltip: s.tunnel === 'down' ? `${s.tunnelError ?? 'The tunnel stopped.'}\n\nClick to restart it.` : 'Click to restart the tunnel.',
      icon: tunnel.icon,
      color: tunnel.color,
      action: 'restartTunnel',
      contextValue: 'webTunnel',
    });
  }
  rows.push({ id: 'local', label: 'Loopback URL', description: local, tooltip: `${local}\n\nFor ssh -L. Click to copy.`, icon: 'link', action: 'copyLocal' });
  if (o.settings) {
    const users = o.settings.allowedUsers;
    rows.push(
      o.settings.auth === 'loopback'
        ? {
            id: 'access',
            label: 'Access: no identity check',
            description: 'loopback',
            tooltip: 'devdesk.web.auth is loopback: any process on this host can open the page.',
            icon: 'unlock',
            color: 'problemsWarningIcon.foreground',
            action: 'settings',
          }
        : {
            id: 'access',
            label: users.length ? `Access: ${users.join(', ')}` : 'Access: nobody',
            description: o.settings.identityHeader || 'no identity header',
            tooltip: users.length && o.settings.identityHeader
              ? `Requests whose ${o.settings.identityHeader} header names ${users.join(' or ')}.`
              : 'devdesk.web.identityHeader or devdesk.web.allowedUsers is empty: every request is denied.',
            icon: 'lock',
            ...(users.length && o.settings.identityHeader ? {} : { color: 'problemsWarningIcon.foreground' }),
            action: 'settings',
          },
    );
  }
  rows.push({ id: 'log', label: 'Log', description: 'daemon.log', icon: 'output', action: 'openLog' });
  return rows;
}
