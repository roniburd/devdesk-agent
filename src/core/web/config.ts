import { join } from 'node:path';
import { isFiniteNumber } from '../json';
import { shellQuote } from '../shell';
import { isServerName } from '../tmux';

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
}

export interface WebAccessSettings {
  /** Integer 1024..65535, else DEFAULT_WEB_PORT. */
  port: number;
  /** Only the exact string 'loopback' gives loopback. */
  auth: 'header' | 'loopback';
  /** Lower-cased; '' -> the provider's when its tunnel is used, else '' (deny all). */
  identityHeader: string;
  /** Non-empty strings, kept exactly (no trim, no case folding); [] -> [user] with the provider's tunnel, else []. */
  allowedUsers: string[];
  /** Lower-cased host[:port]; '' -> taken from the tunnel URL at runtime. */
  publicHost: string;
  /** Trimmed; '' -> the provider's tunnelCommand when `provider` is given, else ''. */
  tunnelCommand: string;
  /** 500..60000, default 2000. */
  pollMs: number;
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
 * `provider`: the provider's defaults, only when the window's root is one of its workspaces. `user`: $USER. The
 * provider's header and user stand in only when its own tunnel runs (the tunnel command is left empty): with a custom
 * tunnel command and no header or users configured, every request is denied. Loopback auth (no identity check, for
 * `ssh -L`) never gets the provider's tunnel; a tunnel command or public host set with it is refused by
 * parseDaemonConfig.
 */
export function resolveWebSettings(s: WebSettings, ctx: { provider?: WebProviderDefaults; user: string }): WebAccessSettings {
  const tunnelCommand = str(s.tunnelCommand);
  const loopback = s.auth === 'loopback';
  const providerTunnel = !tunnelCommand && !loopback && ctx.provider ? ctx.provider : undefined;
  const identityHeader = headerName(s.identityHeader) || (providerTunnel ? headerName(providerTunnel.identityHeader) : '');
  const users = usersOf(s.allowedUsers);
  return {
    port: validPort(s.port) ? s.port : DEFAULT_WEB_PORT,
    auth: loopback ? 'loopback' : 'header',
    identityHeader,
    allowedUsers: users.length ? users : providerTunnel && ctx.user ? [ctx.user] : [],
    publicHost: str(s.publicHost).toLowerCase(),
    tunnelCommand: tunnelCommand || (providerTunnel?.tunnelCommand.trim() ?? ''),
    pollMs: pollOf(s.pollMs),
  };
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
  /** modeArgs: sessionsDefaultMode().args */
  claude: { command?: string; path?: string; args?: string; modeArgs: string };
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
  if (r.auth !== 'header' && r.auth !== 'loopback') return "auth must be 'header' or 'loopback'";
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
 * [--allow-user U]... [--public-host H] [--tunnel-command C] [--state-dir D] [--root D] [--poll-ms N]`.
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
  h = h.replace(/-+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '');
  return h || 'host';
}

/** {port}, {user} and {host} replaced: the port as digits, the user shellQuote()d, the host as shortHostName(); other text untouched. */
export function fillTunnelCommand(command: string, v: { port: number; user: string; host: string }): string {
  return command.replace(/\{(port|user|host)\}/g, (_, k: string) =>
    k === 'port' ? String(Math.trunc(v.port)) : k === 'user' ? shellQuote(v.user) : shortHostName(v.host, v.user),
  );
}
