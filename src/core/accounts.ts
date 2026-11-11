import { posix } from 'node:path';
import { shellQuote } from './shell';

/**
 * Claude accounts (setting `devdesk.claude.accounts`): Claude Code profiles, each its own config directory
 * (`CLAUDE_CONFIG_DIR`) with its own login, settings, transcripts and session registry. A session DevDesk starts runs
 * in one account, and keeps it when resumed or forked. With no accounts listed there is one, `default`: Claude's own
 * config directory (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), as before accounts.
 *
 * Pure: config.ts reads the settings and the environment, and resolves every path DevDesk derives from Claude's config
 * directory through `claudeConfigDir(account)`.
 */
export interface ClaudeAccount {
  /** As listed in the setting (unique, case-insensitively), or `default`. */
  name: string;
  /** Claude's config directory for the account: absolute, `~` expanded, without a trailing `/`. */
  configDir: string;
  /**
   * The config directory Claude uses without `CLAUDE_CONFIG_DIR` (`$CLAUDE_CONFIG_DIR` of VS Code, else `~/.claude`):
   * its sessions start without setting it, so Claude keeps its global config where it always has (`~/.claude.json`).
   */
  ambient: boolean;
  /** More environment variables its sessions get (names checked; values as given). */
  env: Record<string, string>;
}

/** The account when none is listed. */
export const DEFAULT_ACCOUNT_NAME = 'default';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Environment DevDesk sets itself: an account's `env` cannot replace it. */
const RESERVED_ENV = new Set(['CLAUDE_CONFIG_DIR', 'DEVDESK_TMUX_SESSION', 'DEVDESK_TMUX_SERVER', 'DEVDESK_TMUX', 'DEVDESK_STATE_DIR']);

/** `p` with a leading `~` expanded and normalized (no trailing `/`); undefined when empty or not absolute after that. */
export function normalizeDir(p: unknown, home: string): string | undefined {
  if (typeof p !== 'string') return undefined;
  const expanded = p.trim().replace(/^~(?=\/|$)/, home);
  if (!expanded.startsWith('/')) return undefined;
  const n = posix.normalize(expanded);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

function parseEnv(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME.test(k) || RESERVED_ENV.has(k)) continue;
    if (typeof v === 'string') env[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v);
  }
  return env;
}

/**
 * The accounts in `devdesk.claude.accounts` (entries without a name or an absolute config directory are skipped, as
 * is a second one with the same name or directory); `[default]` when there are none. `ambientDir` is Claude's own
 * config directory: an account there is `ambient`.
 */
export function parseAccounts(raw: unknown, ambientDir: string, home: string): ClaudeAccount[] {
  const ambient = normalizeDir(ambientDir, home) ?? ambientDir;
  const out: ClaudeAccount[] = [];
  const names = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const configDir = normalizeDir(o.configDir, home);
    if (!name || !configDir || names.has(name.toLowerCase()) || dirs.has(configDir)) continue;
    names.add(name.toLowerCase());
    dirs.add(configDir);
    out.push({ name, configDir, ambient: configDir === ambient, env: parseEnv(o.env) });
  }
  return out.length ? out : [{ name: DEFAULT_ACCOUNT_NAME, configDir: ambient, ambient: true, env: {} }];
}

/** The account named `name` (case-insensitively), else undefined. */
export function accountNamed(accounts: readonly ClaudeAccount[], name: string | undefined): ClaudeAccount | undefined {
  const n = name?.trim().toLowerCase();
  return n ? accounts.find((a) => a.name.toLowerCase() === n) : undefined;
}

/** New sessions' account: the one `defaultName` names (`devdesk.claude.defaultAccount`), else the first listed. */
export function defaultAccount(accounts: readonly ClaudeAccount[], defaultName: string | undefined): ClaudeAccount {
  return accountNamed(accounts, defaultName) ?? accounts[0];
}

/**
 * Every config directory DevDesk reads (transcripts, Claude's session registry, hooks): each account's, and Claude's
 * own (`ambientDir`) too, where sessions started outside DevDesk run. No duplicates; the accounts' first.
 */
export function accountDirs(accounts: readonly ClaudeAccount[], ambientDir: string): string[] {
  return [...new Set([...accounts.map((a) => a.configDir), ambientDir])];
}

/**
 * The config directory a transcript is in: `<dir>/projects/<project>/<session>.jsonl` (or a subagent's, deeper), else
 * undefined. A session's account follows from it, whichever version of DevDesk (or nothing) started it.
 */
export function configDirOfTranscript(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  const m = /^(\/.*?)\/projects\/[^/]+\/[^/]+\.jsonl$/.exec(transcriptPath) ?? /^(\/.*?)\/projects\/[^/]+\/[^/]+\/subagents\/[^/]+\.jsonl$/.exec(transcriptPath);
  return m ? posix.normalize(m[1]) : undefined;
}

/**
 * The account a session with `transcriptPath` runs in: the listed one with its config directory, else an unlisted one
 * named after the directory (`shown`), so resuming it still uses that directory. Undefined without a transcript.
 */
export function accountOfTranscript(
  accounts: readonly ClaudeAccount[],
  transcriptPath: string | undefined,
  ambientDir: string,
  shown: (dir: string) => string = (d) => d,
): ClaudeAccount | undefined {
  const dir = configDirOfTranscript(transcriptPath);
  if (!dir) return undefined;
  return accounts.find((a) => a.configDir === dir) ?? { name: shown(dir), configDir: dir, ambient: dir === ambientDir, env: {} };
}

/**
 * The environment an account's sessions start with: its `env`, and `CLAUDE_CONFIG_DIR` unless it is the ambient one
 * (DevDesk then leaves Claude's own choice alone).
 */
export function accountEnv(account: ClaudeAccount | undefined): Record<string, string> {
  if (!account) return {};
  return account.ambient ? { ...account.env } : { ...account.env, CLAUDE_CONFIG_DIR: account.configDir };
}

/**
 * `command` (a session's shell command line) run with `env` exported first: `export A='x' B='y'; <command>`. Exported
 * for the whole command, so a custom `devdesk.sessions.command` (`claude …; exec $SHELL -l`) and the Program Status
 * relay in front of Claude see it too. `command` as is when `env` is empty.
 */
export function withEnv(command: string, env: Readonly<Record<string, string>>): string {
  const vars = Object.entries(env).filter(([k]) => ENV_NAME.test(k));
  if (!vars.length) return command;
  return `export ${vars.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}; ${command}`;
}

/**
 * The account a launch uses: the one `chosen` names, else the folder's default. Unknown names (an account removed
 * from the setting since a prompt was saved) fall back to the default.
 */
export function pickAccount(accounts: readonly ClaudeAccount[], chosen: string | undefined, defaultName: string | undefined): ClaudeAccount {
  return accountNamed(accounts, chosen) ?? defaultAccount(accounts, defaultName);
}

/** The status that needs the most doing over the accounts' (`missing`, then `outdated`, else `installed`). */
export function worstStatus(statuses: readonly ('installed' | 'outdated' | 'missing')[]): 'installed' | 'outdated' | 'missing' {
  return statuses.includes('missing') ? 'missing' : statuses.includes('outdated') ? 'outdated' : 'installed';
}

/** Claude's global config file for an account: `.claude.json` in its config directory, or `ambientFile` for the ambient one. */
export function accountConfigFile(account: ClaudeAccount, ambientFile: string): string {
  return account.ambient ? ambientFile : posix.join(account.configDir, '.claude.json');
}
