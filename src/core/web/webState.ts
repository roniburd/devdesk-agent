import { join } from 'node:path';
import { WEB_ACCESS } from '../edition';
import { isFiniteNumber, parseObject } from '../json';
import type { SessionCard } from '../sessions';
import { unreadCards } from '../sessionsView';

/**
 * `web.json`: what the running daemon writes about itself (pid, port, tunnel), for the extension's status bar item and
 * Stop. It lives in `<stateDir>/web-v2/` (`webDir`), with `config.json` and `daemon.log`, out of the hook records in `<stateDir>`.
 */

export type TunnelStatus = 'none' | 'starting' | 'up' | 'down';

export interface WebState {
  version: 1;
  pid: number;
  host: '127.0.0.1';
  port: number;
  startedAt: number;
  configPath: string;
  /** none: no tunnel command. */
  tunnel: TunnelStatus;
  /** The tunnel's https URL once printed. */
  url?: string;
  /** Last stderr line (or "no URL within 60 s") when down. */
  tunnelError?: string;
  tunnelPid?: number;
}

/** The daemon's folder in the sessions state directory (`web-v2`: v1's daemon has `web`, see `WEB_ACCESS`). */
export const webDir = (stateDir: string) => join(stateDir, WEB_ACCESS.dirName);
export const webStatePath = (webDir: string) => join(webDir, 'web.json');
export const webConfigPath = (webDir: string) => join(webDir, 'config.json');
export const webLogPath = (webDir: string) => join(webDir, 'daemon.log');
/** What the Claude view has read (`[session id, cardSignature]`), written by the extension for the daemon's order. */
export const webSeenPath = (webDir: string) => join(webDir, 'seen.json');

export function webSeenJson(seen: ReadonlyMap<string, string>): string {
  return `${JSON.stringify({ version: 1, seen: [...seen] })}\n`;
}

/** The seen marks in seen.json, or undefined when it is missing or not seen.json. */
export function parseWebSeen(text: string): Map<string, string> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = (raw as { seen?: unknown } | null)?.seen;
  if (!Array.isArray(list)) return undefined;
  const pairs = list.filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string');
  return new Map(pairs);
}

/** The unread sessions, as the Claude view counts them; with no seen marks, every session (one never seen is unread). */
export function webUnread(seen: ReadonlyMap<string, string> | undefined, cards: readonly SessionCard[]): Set<string> {
  return seen ? unreadCards(seen, cards) : new Set(cards.map((c) => c.id));
}

export const EXIT_BAD_CONFIG = 2;
export const EXIT_PORT_IN_USE = 3;

const TUNNEL: ReadonlySet<string> = new Set<TunnelStatus>(['none', 'starting', 'up', 'down']);
const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

export function parseWebState(text: string): WebState | undefined {
  const r = parseObject(text);
  if (!r || r.version !== 1 || r.host !== '127.0.0.1') return undefined;
  if (!isPid(r.pid) || !Number.isInteger(r.port) || !isFiniteNumber(r.startedAt) || typeof r.configPath !== 'string') return undefined;
  if (typeof r.tunnel !== 'string' || !TUNNEL.has(r.tunnel)) return undefined;
  if (r.url !== undefined && typeof r.url !== 'string') return undefined;
  if (r.tunnelError !== undefined && typeof r.tunnelError !== 'string') return undefined;
  if (r.tunnelPid !== undefined && !isPid(r.tunnelPid)) return undefined;
  const state: WebState = {
    version: 1,
    pid: r.pid,
    host: '127.0.0.1',
    port: r.port as number,
    startedAt: r.startedAt,
    configPath: r.configPath,
    tunnel: r.tunnel as TunnelStatus,
  };
  if (r.url !== undefined) state.url = r.url;
  if (r.tunnelError !== undefined) state.tunnelError = r.tunnelError;
  if (r.tunnelPid !== undefined) state.tunnelPid = r.tunnelPid;
  return state;
}

export type WebStatus = { kind: 'off' } | { kind: 'on' | 'tunnel-down'; state: WebState };

/** off when no state or its pid is dead (stale); tunnel-down when tunnel === 'down'; else on. */
export function webStatus(state: WebState | undefined, alive: (pid: number) => boolean): WebStatus {
  if (!state || !alive(state.pid)) return { kind: 'off' };
  return { kind: state.tunnel === 'down' ? 'tunnel-down' : 'on', state };
}
