import { join } from 'node:path';
import { isFiniteNumber } from '../json';
import { type LaunchMode, parseModes } from '../modes';
import { shellQuote } from '../shell';
import { isServerName } from '../tmux';
import { isSessionView, type SessionView } from './types';
import { allowsAnonymous, cloudflareAudienceOf, cloudflareTeamOf, type DaemonAuth, isTunnelPreset, TUNNEL_PRESETS, type NgrokOAuthProvider, ngrokProviderOf, presetSpec, type TunnelPreset, tunnelChoiceOf } from './tunnelPresets';

/**
 * Web access settings: `devdesk.web.*` as VS Code gives them, resolved into what the daemon runs with, and the config
 * file and command-line flags the daemon (`dist/web.js`) reads. There is no setting or flag for the listen address: the
 * daemon binds 127.0.0.1 only.
 */

export const DEFAULT_WEB_PORT = 7690;
const DEFAULT_POLL_MS = 2000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 60_000;

/** What the provider (a package workspace kind) says to use when the tunnel command is left empty. */
export interface WebProviderDefaults {
  tunnelCommand: string;
  identityHeader: string;
  /** The URL its tunnel gets, with {user} and {name} (the tunnel's name), for the Web Access view's preview. */
  tunnelUrl?: string;
}

/** devdesk.web.* as read from VS Code, untrimmed. */
export interface WebSettings {
  port: unknown;
  auth: unknown;
  identityHeader: unknown;
  allowedUsers: unknown;
  publicHost: unknown;
  tunnelCommand: unknown;
  pollMs: unknown;
  /** devdesk.web.tunnelName */
  tunnelName?: unknown;
  /** devdesk.web.tunnel; in a DaemonConfig, the preset that ran ('' none). */
  tunnel?: unknown;
  /** devdesk.web.cloudflare.team / .audience; in a DaemonConfig, `cloudflare`. */
  cloudflareTeam?: unknown;
  cloudflareAudience?: unknown;
  cloudflare?: unknown;
  /** devdesk.web.ngrok.oauthProvider */
  ngrokProvider?: unknown;
  /** devdesk.web.sessionView */
  sessionView?: unknown;
}

export interface WebAccessSettings {
  /** Integer 1024..65535, else DEFAULT_WEB_PORT. */
  port: number;
  /** Only the exact string 'loopback' gives loopback; a preset gives its own (presetSpec). */
  auth: DaemonAuth;
  /** The preset whose command runs; '' for the provider's, a custom command, or none. */
  tunnel: TunnelPreset | '';
  /** Lower-cased; the preset's with one; '' -> the provider's when its tunnel is used, else '' (deny all). */
  identityHeader: string;
  /** Non-empty strings, kept exactly (no trim, no case folding); [] -> [user] with the provider's tunnel, else []. */
  allowedUsers: string[];
  /** Lower-cased host[:port]; '' -> taken from the tunnel URL at runtime. */
  publicHost: string;
  /** Trimmed; '' -> the provider's tunnelCommand when `provider` is given, else ''. */
  tunnelCommand: string;
  /** 500..60000, default 2000. */
  pollMs: number;
  /** What fills {host} (tunnelLabel()); '' -> this machine's short host name. */
  tunnelName: string;
  /** The preset's URL rules (TunnelSpec); '' with none. */
  tunnelUrlHost: string;
  tunnelReadyLine: string;
  tunnelActionHost: string;
  /** For `cloudflare` auth: the team name and the application's AUD tag ('' when invalid: every request is denied). */
  cloudflare: { team: string; audience: string };
  ngrokProvider: NgrokOAuthProvider;
  /** What the page shows for a session unless the browser chose otherwise; 'transcript' for anything else. */
  sessionView: SessionView;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
/** An HTTP header name (RFC 9110 token), lower-cased as node gives them; '' for anything else. */
const headerName = (v: unknown) => {
  const h = str(v).toLowerCase();
  return /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(h) ? h : '';
};
const validPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535;
const pollOf = (v: unknown) => (isFiniteNumber(v) ? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(v))) : DEFAULT_POLL_MS);
const usersOf = (v: unknown) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string' && u !== '') : []);

/**
 * `provider`: the provider's defaults, only when the window's root is one of its workspaces. `user`: $USER.
 *
 * Which tunnel runs (`devdesk.web.tunnel`): a preset runs its own command, header and auth (the identity header and
 * tunnel command settings do not apply to it); `custom` runs the tunnel command; `none` runs nothing; `auto` runs the
 * tunnel command when set, else the provider's tunnel, else none (Start then asks which to use). The provider's header
 * and user stand in only when its own tunnel runs: with a custom tunnel command and no header or users configured,
 * every request is denied. Loopback auth (no identity check, for `ssh -L`) runs no preset or provider tunnel; a tunnel
 * command or public host set with it is refused by parseDaemonConfig.
 */
export function resolveWebSettings(s: WebSettings, ctx: { provider?: WebProviderDefaults; user: string }): WebAccessSettings {
  const custom = str(s.tunnelCommand);
  const loopback = s.auth === 'loopback';
  const choice = tunnelChoiceOf(s.tunnel);
  const publicHost = str(s.publicHost).toLowerCase();
  const users = usersOf(s.allowedUsers);
  const cf = (isObject(s.cloudflare) ? s.cloudflare : {}) as { team?: unknown; audience?: unknown };
  const base = {
    port: validPort(s.port) ? s.port : DEFAULT_WEB_PORT,
    publicHost,
    pollMs: pollOf(s.pollMs),
    tunnelName: tunnelLabel(str(s.tunnelName)),
    cloudflare: { team: cloudflareTeamOf(s.cloudflareTeam ?? cf.team), audience: cloudflareAudienceOf(s.cloudflareAudience ?? cf.audience) },
    ngrokProvider: ngrokProviderOf(s.ngrokProvider),
    sessionView: isSessionView(s.sessionView) ? s.sessionView : 'transcript',
    tunnelUrlHost: '',
    tunnelReadyLine: '',
    tunnelActionHost: '',
  };
  if (!loopback && isTunnelPreset(choice)) {
    const spec = presetSpec(choice, { publicHost });
    return {
      ...base,
      auth: spec.auth,
      tunnel: choice,
      identityHeader: spec.identityHeader,
      allowedUsers: spec.auth === 'tunnel' ? [] : users,
      tunnelCommand: spec.command,
      tunnelUrlHost: spec.urlHost,
      tunnelReadyLine: spec.readyLine,
      tunnelActionHost: spec.actionHost,
    };
  }
  const tunnelCommand = choice === 'none' ? '' : custom;
  const providerTunnel = choice === 'auto' && !custom && !loopback && ctx.provider ? ctx.provider : undefined;
  const identityHeader = headerName(s.identityHeader) || (providerTunnel ? headerName(providerTunnel.identityHeader) : '');
  return {
    ...base,
    auth: loopback ? 'loopback' : 'header',
    tunnel: '',
    identityHeader,
    allowedUsers: users.length ? users : providerTunnel && ctx.user ? [ctx.user] : [],
    tunnelCommand: tunnelCommand || (providerTunnel?.tunnelCommand.trim() ?? ''),
  };
}

/** Start should ask which tunnel to use: `auto`, header auth, no tunnel command, and no provider tunnel for this root. */
export function needsTunnelChoice(s: Pick<WebSettings, 'tunnel' | 'auth' | 'tunnelCommand'>, hasProvider: boolean): boolean {
  return tunnelChoiceOf(s.tunnel) === 'auto' && s.auth !== 'loopback' && !str(s.tunnelCommand) && !hasProvider;
}

/** The file the extension writes (`<stateDir>/web/config.json`, mode 0600) and `node dist/web.js --config <file>` reads. */
export interface DaemonConfig extends WebAccessSettings {
  version: 1;
  /** Fills {user}. */
  user: string;
  /** Hook records (sessionsStateDir()). */
  stateDir: string;
  /** <stateDir>/web */
  webDir: string;
  /** workspaceRoot() of the window that ran Start; kept on setting changes. */
  root?: string;
  /** root and its realpath (as SessionsModel.scopeDirs). */
  scopeDirs: string[];
  /** devdesk.sessions.scope */
  scope: 'workspace' | 'all';
  /** devdesk.sessions.show === 'all' */
  showAll: boolean;
  /** featureDiscovery() */
  discovery: { claudeWorktrees: boolean };
  /** claudeSessionsDir() */
  claudeSessionsDir: string;
  /** sessionsStuckMs() */
  stuckMs: number;
  /** sessionsIdleMs(): a done session not updated this long sorts as idle, as in the Claude view. */
  idleMs: number;
  /** insightsEnabled() */
  insights: boolean;
  tmux: {
    /** sessionsTmuxPath() */
    bin: string;
    /** Only for `server`. */
    configFile?: string;
    /** sessionsTmuxServer() */
    server: string;
    /** sessionsTmuxOptions() */
    options: [string, string][];
    /** sessionsClaudeEnv() (+ DEVDESK_TMUX when bin !== 'tmux') */
    env: Record<string, string>;
  };
  /**
   * modeArgs: sessionsDefaultMode().args. For the page's prompt box: modes (sessionsModes(), absent: only the default
   * mode) with defaultMode its name, models (boardModels(): replaces the CLI's list when not empty), configDir
   * (claudeConfigDir(): the skills and commands `/` offers).
   */
  claude: {
    command?: string;
    path?: string;
    args?: string;
    modeArgs: string;
    modes?: LaunchMode[];
    defaultMode?: string;
    models?: string[];
    configDir?: string;
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const optionalString = (v: unknown) => v === undefined || typeof v === 'string';

/** The first problem with a parsed config.json, or undefined when it has every field with the right type. */
function configProblem(r: Record<string, unknown>): string | undefined {
  if (r.version !== 1) return 'version must be 1';
  for (const k of ['user', 'identityHeader', 'publicHost', 'tunnelCommand'] as const) if (typeof r[k] !== 'string') return `${k} must be a string`;
  for (const k of ['stateDir', 'webDir', 'claudeSessionsDir'] as const) if (typeof r[k] !== 'string' || !r[k]) return `${k} must be a non-empty string`;
  if (!validPort(r.port)) return 'port must be an integer from 1024 to 65535';
  if (!['header', 'loopback', 'tunnel', 'cloudflare'].includes(r.auth as string)) return "auth must be 'header', 'loopback', 'tunnel' or 'cloudflare'";
  if (r.tunnel !== undefined && r.tunnel !== '' && !isTunnelPreset(r.tunnel)) return 'tunnel must be a tunnel preset or empty';
  // Dev Tunnels names no one: the daemon trusts that only its owner gets through, so the tunnel must not let anyone in.
  if (r.auth === 'tunnel' && (r.tunnel !== 'devtunnel' || allowsAnonymous(str(r.tunnelCommand)))) {
    return "auth 'tunnel' runs only with the devtunnel preset, without anonymous access";
  }
  if (!optionalString(r.tunnelName)) return 'tunnelName must be a string';
  for (const k of ['tunnelUrlHost', 'tunnelReadyLine', 'tunnelActionHost'] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'string') return `${k} must be a string`;
    try {
      new RegExp(r[k] as string);
    } catch {
      return `${k} must be a regular expression`;
    }
  }
  if (r.cloudflare !== undefined && (!isObject(r.cloudflare) || typeof r.cloudflare.team !== 'string' || typeof r.cloudflare.audience !== 'string')) {
    return 'cloudflare must have a team and an audience';
  }
  // Loopback has no identity check: whatever a tunnel or proxy lets through would drive Claude unchecked.
  for (const k of ['tunnelCommand', 'publicHost'] as const) {
    if (r.auth === 'loopback' && str(r[k])) {
      return `devdesk.web.auth 'loopback' (no identity check, for ssh -L) cannot run with devdesk.web.${k} set: clear devdesk.web.${k}, or use auth 'header' behind an identity proxy`;
    }
  }
  if (!isStringArray(r.allowedUsers)) return 'allowedUsers must be an array of strings';
  if (!isFiniteNumber(r.pollMs)) return 'pollMs must be a number';
  if (!optionalString(r.root)) return 'root must be a string';
  if (!isStringArray(r.scopeDirs)) return 'scopeDirs must be an array of strings';
  if (r.scope !== 'workspace' && r.scope !== 'all') return "scope must be 'workspace' or 'all'";
  if (typeof r.showAll !== 'boolean') return 'showAll must be a boolean';
  if (!isObject(r.discovery) || typeof r.discovery.claudeWorktrees !== 'boolean') return 'discovery.claudeWorktrees must be a boolean';
  if (!isFiniteNumber(r.stuckMs) || r.stuckMs <= 0) return 'stuckMs must be a positive number';
  if (r.idleMs !== undefined && (!isFiniteNumber(r.idleMs) || r.idleMs <= 0)) return 'idleMs must be a positive number';
  if (typeof r.insights !== 'boolean') return 'insights must be a boolean';
  const t = r.tmux;
  if (!isObject(t)) return 'tmux must be an object';
  if (typeof t.bin !== 'string' || !t.bin) return 'tmux.bin must be a non-empty string';
  if (!optionalString(t.configFile)) return 'tmux.configFile must be a string';
  if (!isServerName(t.server)) return 'tmux.server must be a tmux server name';
  if (!Array.isArray(t.options) || !t.options.every((o) => Array.isArray(o) && o.length === 2 && o.every((x) => typeof x === 'string'))) {
    return 'tmux.options must be [name, value] string pairs';
  }
  if (!isObject(t.env) || !Object.values(t.env).every((v) => typeof v === 'string')) return 'tmux.env must map names to strings';
  const c = r.claude;
  if (!isObject(c)) return 'claude must be an object';
  if (!optionalString(c.command) || !optionalString(c.path) || !optionalString(c.args)) return 'claude.command, path and args must be strings';
  if (typeof c.modeArgs !== 'string') return 'claude.modeArgs must be a string';
  if (c.modes !== undefined && (!Array.isArray(c.modes) || parseModes(c.modes).length !== c.modes.length)) return 'claude.modes must be launch modes';
  if (!optionalString(c.defaultMode) || !optionalString(c.configDir)) return 'claude.defaultMode and configDir must be strings';
  if (c.models !== undefined && (!Array.isArray(c.models) || !c.models.every((m) => typeof m === 'string'))) return 'claude.models must be strings';
  return undefined;
}

/** Validates a parsed config.json; any missing/invalid field is an error (the daemon exits 2). Re-applies the clamps above. */
export function parseDaemonConfig(raw: unknown): { config: DaemonConfig } | { error: string } {
  if (!isObject(raw)) return { error: 'the config is not a JSON object' };
  const problem = configProblem(raw);
  if (problem) return { error: `bad config: ${problem}` };
  const r = raw as unknown as DaemonConfig;
  const settings = resolveWebSettings(r, { user: r.user });
  const tmux = r.tmux;
  const claude = r.claude;
  const config: DaemonConfig = {
    version: 1,
    ...settings,
    user: r.user,
    stateDir: r.stateDir,
    webDir: r.webDir,
    ...(r.root !== undefined ? { root: r.root } : {}),
    scopeDirs: [...r.scopeDirs],
    scope: r.scope,
    showAll: r.showAll,
    discovery: { claudeWorktrees: r.discovery.claudeWorktrees },
    claudeSessionsDir: r.claudeSessionsDir,
    stuckMs: r.stuckMs,
    idleMs: r.idleMs ?? DEFAULT_IDLE_MS,
    insights: r.insights,
    tmux: {
      bin: tmux.bin,
      ...(tmux.configFile !== undefined ? { configFile: tmux.configFile } : {}),
      server: tmux.server,
      options: tmux.options.map(([k, v]) => [k, v] as [string, string]),
      env: { ...tmux.env },
    },
    claude: {
      ...(claude.command !== undefined ? { command: claude.command } : {}),
      ...(claude.path !== undefined ? { path: claude.path } : {}),
      ...(claude.args !== undefined ? { args: claude.args } : {}),
      modeArgs: claude.modeArgs,
      ...(claude.modes !== undefined ? { modes: parseModes(claude.modes) } : {}),
      ...(claude.defaultMode !== undefined ? { defaultMode: claude.defaultMode } : {}),
      ...(claude.models !== undefined ? { models: [...(claude.models as string[])] } : {}),
      ...(claude.configDir !== undefined ? { configDir: claude.configDir } : {}),
    },
  };
  return { config };
}

/** `devdesk.sessions.idleMinutes`' default (30). */
export const DEFAULT_IDLE_MS = 30 * 60_000;

/** What a manual run (no --config) uses. */
export function defaultDaemonConfig(home: string, user: string): DaemonConfig {
  const stateDir = join(home, '.claude', 'devdesk', 'state');
  return {
    version: 1,
    port: DEFAULT_WEB_PORT,
    auth: 'header',
    identityHeader: '',
    allowedUsers: [],
    publicHost: '',
    tunnelCommand: '',
    pollMs: DEFAULT_POLL_MS,
    tunnelName: '',
    tunnel: '',
    tunnelUrlHost: '',
    tunnelReadyLine: '',
    tunnelActionHost: '',
    cloudflare: { team: '', audience: '' },
    ngrokProvider: 'google',
    sessionView: 'transcript',
    user,
    stateDir,
    webDir: join(stateDir, 'web'),
    scopeDirs: [],
    scope: 'all',
    showAll: false,
    discovery: { claudeWorktrees: false },
    claudeSessionsDir: join(home, '.claude', 'sessions'),
    stuckMs: 10 * 60_000,
    idleMs: DEFAULT_IDLE_MS,
    insights: true,
    tmux: { bin: 'tmux', server: 'devdesk', options: [], env: {} },
    claude: { modeArgs: '' },
  };
}

type Flag = (value: string, o: Partial<DaemonConfig>) => string | undefined;

const FLAGS: Readonly<Record<string, Flag>> = {
  '--port': (v, o) => {
    const n = Number(v);
    if (!/^\d+$/.test(v) || !validPort(n)) return '--port needs an integer from 1024 to 65535';
    o.port = n;
    return undefined;
  },
  '--auth': (v, o) => {
    if (v !== 'header' && v !== 'loopback') return "--auth must be 'header' or 'loopback'";
    o.auth = v;
    return undefined;
  },
  '--identity-header': (v, o) => void (o.identityHeader = v),
  '--allow-user': (v, o) => void (o.allowedUsers = [...(o.allowedUsers ?? []), v]),
  '--public-host': (v, o) => void (o.publicHost = v),
  '--tunnel-command': (v, o) => void (o.tunnelCommand = v),
  '--tunnel-name': (v, o) => {
    if (tunnelNameProblem(v)) return `--tunnel-name: ${tunnelNameProblem(v)}`;
    o.tunnelName = tunnelLabel(v);
    return undefined;
  },
  '--tunnel': (v, o) => {
    if (v !== '' && !isTunnelPreset(v)) return `--tunnel must be one of ${TUNNEL_PRESETS.join(', ')}`;
    o.tunnel = v as TunnelPreset | '';
    return undefined;
  },
  '--state-dir': (v, o) => {
    o.stateDir = v;
    o.webDir = join(v, 'web');
    return undefined;
  },
  '--root': (v, o) => {
    o.root = v;
    o.scopeDirs = [v];
    return undefined;
  },
  '--poll-ms': (v, o) => {
    const n = Number(v);
    if (!/^\d+$/.test(v)) return '--poll-ms needs a number of milliseconds';
    o.pollMs = n;
    return undefined;
  },
};

/**
 * Manual runs: `node dist/web.js [--config <file>] [--port N] [--auth header|loopback] [--identity-header H]
 * [--allow-user U]... [--public-host H] [--tunnel-command C] [--tunnel PRESET] [--state-dir D] [--root D] [--poll-ms N]`.
 * Flags override the file. Without --config: state dir ~/.claude/devdesk/state, tmux server `devdesk`, scope `all`,
 * no tunnel. Unknown flags are an error. There is no --host / --bind flag.
 */
export function parseDaemonArgs(argv: readonly string[]): { configPath?: string; overrides: Partial<DaemonConfig> } | { error: string } {
  const overrides: Partial<DaemonConfig> = {};
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) return { error: `unexpected argument: ${arg}` };
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (name === '--host' || name === '--bind') return { error: `${name}: the daemon listens on 127.0.0.1 only; reach it through a proxy` };
    const flag = name === '--config' ? undefined : FLAGS[name];
    if (name !== '--config' && !flag) return { error: `unknown flag: ${name}` };
    let value: string;
    if (eq >= 0) value = arg.slice(eq + 1);
    else {
      if (i + 1 >= argv.length) return { error: `${name} needs a value` };
      value = argv[++i];
    }
    if (!flag) configPath = value;
    else {
      const problem = flag(value, overrides);
      if (problem) return { error: problem };
    }
  }
  return configPath !== undefined ? { configPath, overrides } : { overrides };
}

/** The longest name {host} gets. */
export const TUNNEL_NAME_MAX = 24;

/** `name` as {host} takes it: lower case, letters, digits and dashes (others become dashes), at most 24 characters; '' when nothing is left. */
export function tunnelLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, TUNNEL_NAME_MAX)
    .replace(/-+$/, '');
}

/** What is wrong with a typed `devdesk.web.tunnelName` (trimmed; '' is fine: the host name), or undefined. */
export function tunnelNameProblem(typed: string): string | undefined {
  const t = typed.trim();
  if (!t) return undefined;
  if (!/^[A-Za-z0-9-]+$/.test(t)) return 'use only letters, digits and dashes';
  if (t.length > TUNNEL_NAME_MAX) return `use at most ${TUNNEL_NAME_MAX} characters`;
  if (!tunnelLabel(t)) return 'use at least one letter or digit';
  return undefined;
}

/**
 * This machine in a tunnel name: the host name's first label, lower case, in letters, digits and dashes, without
 * anything up to and including the user's name, which the tunnel URL already has (`box-roni-2a-d1` -> `2a-d1`), at most
 * 24 characters; `host` when nothing is left. Each machine then gets a tunnel of its own instead of taking over another's.
 */
export function shortHostName(hostname: string, user: string): string {
  const u = user.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  let h = (hostname.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const at = u ? `-${h}-`.indexOf(`-${u}-`) : -1;
  if (at >= 0) h = h.slice(at + u.length + 1);
  return tunnelLabel(h) || 'host';
}

/** What fills {host}: `devdesk.web.tunnelName` (tunnelLabel()) when set, else shortHostName(). */
export function tunnelHostLabel(v: { tunnelName?: string; host: string; user: string }): string {
  return tunnelLabel(v.tunnelName ?? '') || shortHostName(v.host, v.user);
}

/** The tunnel's name in `command`: the word that has {host} (`devdesk-v1-{host}`), filled in; undefined without one. */
export function tunnelNameIn(command: string, label: string): string | undefined {
  const word = /[^\s'"]*\{host\}[^\s'"]*/.exec(command)?.[0];
  return word?.replace(/\{host\}/g, label);
}

/** What the tunnel is called with a tunnel name: {host} (`label`), the tunnel's name, and its URL when the workspace kind says it. */
export interface TunnelPreview {
  label: string;
  /** The label is `devdesk.web.tunnelName`, not the host name. */
  fromSetting: boolean;
  name: string;
  url?: string;
}

/** The tunnel `command` runs, named with `tunnelName` (else the host name); undefined when the command has no {host}. */
export function tunnelPreview(o: { command: string; tunnelName?: string; host: string; user: string; urlTemplate?: string }): TunnelPreview | undefined {
  const label = tunnelHostLabel(o);
  const name = tunnelNameIn(o.command, label);
  if (!name) return undefined;
  const url = o.urlTemplate?.replace(/\{user\}/g, o.user.toLowerCase()).replace(/\{name\}/g, name);
  return { label, fromSetting: !!tunnelLabel(o.tunnelName ?? ''), name, ...(url ? { url } : {}) };
}

/**
 * {port}, {user}, {host}, {publicHost} and {ngrokPolicy} replaced: the port as digits, the host as tunnelHostLabel(), the
 * others shellQuote()d (an unset publicHost or ngrokPolicy as ''); other text untouched.
 */
export function fillTunnelCommand(command: string, v: { port: number; user: string; host: string; tunnelName?: string; publicHost?: string; ngrokPolicy?: string }): string {
  return command.replace(/\{(port|user|host|publicHost|ngrokPolicy)\}/g, (_, k: string) => {
    if (k === 'port') return String(Math.trunc(v.port));
    if (k === 'host') return tunnelHostLabel(v);
    return shellQuote(k === 'user' ? v.user : k === 'publicHost' ? (v.publicHost ?? '') : (v.ngrokPolicy ?? ''));
  });
}
