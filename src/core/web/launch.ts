import { EXIT_BAD_CONFIG, EXIT_PORT_IN_USE, type WebStatus } from './webState';

/** What the extension decides about the web access daemon: Start's failures, the status bar item, its menu. No `vscode`. */

/** True when a process's command line runs the daemon (`… web.js …`): a stale pid another process took is never signalled. */
export function isDaemonCommand(command: string): boolean {
  return /(^|[\s/])web\.js(\s|$)/.test(command);
}

/** The daemon log's last non-empty line, without the timestamp the daemon puts first. */
export function lastLogLine(log: string): string {
  const line = log.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '');
}

/**
 * Why Start failed: the daemon's exit `code` (undefined when it never wrote `web.json` in time), with `settings` when the
 * message offers the Settings button.
 */
export function launchFailure(o: { code: number | null | undefined; port: number; log: string }): { message: string; settings: boolean } {
  if (o.code === EXIT_PORT_IN_USE) return { message: `Web access: port ${o.port} is in use. Change devdesk.web.port.`, settings: true };
  const line = lastLogLine(o.log);
  if (o.code === undefined) return { message: line ? `Web access did not start within 5 s: ${line}` : 'Web access did not start within 5 s.', settings: false };
  if (line) return { message: `Web access did not start: ${line}`, settings: o.code === EXIT_BAD_CONFIG };
  return { message: `Web access did not start (exit code ${o.code}).`, settings: false };
}

/** The status bar item's text; undefined hides it (web access is off). */
export function statusBarText(status: WebStatus): string | undefined {
  if (status.kind === 'off') return undefined;
  return status.kind === 'tunnel-down' ? '$(warning) Web: tunnel down' : '$(broadcast) Web: on';
}

export type WebMenuId = 'start' | 'copy' | 'open' | 'qr' | 'copyLocal' | 'restart' | 'stop' | 'settings';
export interface WebMenuChoice {
  id: WebMenuId;
  label: string;
  description?: string;
}

/** The status bar item's menu for `status`; `qr` says whether the URL fits a QR code. */
export function webMenuChoices(status: WebStatus, qr: boolean): WebMenuChoice[] {
  const settings: WebMenuChoice = { id: 'settings', label: '$(gear) Settings' };
  if (status.kind === 'off') return [{ id: 'start', label: '$(play) Start Web Access' }, settings];
  const s = status.state;
  const local = `http://${s.host}:${s.port}/`;
  const out: WebMenuChoice[] = [];
  if (s.url) {
    out.push({ id: 'copy', label: '$(copy) Copy URL', description: s.url }, { id: 'open', label: '$(link-external) Open URL', description: s.url });
    if (qr) out.push({ id: 'qr', label: '$(device-mobile) Show QR Code' });
  }
  out.push({ id: 'copyLocal', label: '$(copy) Copy Loopback URL', description: local });
  if (s.tunnel !== 'none') {
    out.push({ id: 'restart', label: '$(debug-restart) Restart Tunnel', ...(s.tunnel === 'down' && s.tunnelError ? { description: s.tunnelError } : {}) });
  }
  out.push({ id: 'stop', label: '$(debug-stop) Stop Web Access' }, settings);
  return out;
}
