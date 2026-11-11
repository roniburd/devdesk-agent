import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeConfigFile, sessionsClaudeEnv, worktreesAutoTrust } from './config';
import { accountEnv, type ClaudeAccount } from './core/accounts';
import { updateClaudeConfig } from './core/claudeConfigUpdate';
import { readTextIfExists } from './core/json';
import { needsTrust, repoRootFromGitFile, type TrustPlace, trustWorktree } from './core/trust';
import { log } from './log';

/** Where `dir` is for the CLI's trust check: its real path, its git root, and the main repository's root. */
async function trustPlace(dir: string): Promise<TrustPlace> {
  const real = await realpath(dir).catch(() => dir);
  for (let at = real; ; ) {
    const git = join(at, '.git');
    const stat = await lstat(git).catch(() => undefined);
    if (stat?.isDirectory()) return { dir: real, gitRoot: at, repoRoot: at };
    if (stat?.isFile()) {
      const content = await readFile(git, 'utf8').catch(() => '');
      return { dir: real, gitRoot: at, repoRoot: repoRootFromGitFile(content, at) ?? at };
    }
    const up = dirname(at);
    if (up === at) return { dir: real };
    at = up;
  }
}

/**
 * True when a session Claude starts in `dir` will first ask whether to trust the folder: read (never written) from
 * the global config file of the Claude account it runs in (`claudeConfigFile(account)`, default: the default account's;
 * `devdesk.board.claudeConfigFile` for Claude's own). A file that is missing means nothing is trusted yet; one that
 * cannot be read or parsed is not guessed at (false).
 */
export async function claudeNeedsTrust(dir: string, account?: ClaudeAccount): Promise<boolean> {
  let json: unknown;
  try {
    const text = await readTextIfExists(claudeConfigFile(account));
    json = text === undefined ? {} : JSON.parse(text);
  } catch {
    return false;
  }
  return needsTrust(json, await trustPlace(dir), { ...process.env, ...sessionsClaudeEnv(), ...accountEnv(account) });
}

/**
 * `devdesk.worktrees.autoTrust`: accepts Claude's trust dialog for `folders` (a worktree DevDesk just made, and the git
 * packages in it), as `trustWorktree` allows: only when Claude trusts `parent` (the workspace root) already, and only
 * for folders inside it. Written to the config file of the Claude account the session starts in
 * (`claudeConfigFile(account)`; default: the default account's) alongside Claude's own writes
 * (`updateClaudeConfig`). Never throws: when it cannot, Claude asks as before. True when a folder was trusted.
 */
export async function autoTrustWorktree(parent: string, folders: readonly string[], account?: ClaudeAccount): Promise<boolean> {
  if (!worktreesAutoTrust() || !folders.length) return false;
  const file = claudeConfigFile(account);
  const env = { ...process.env, ...sessionsClaudeEnv(), ...accountEnv(account) };
  try {
    const trust = { parent: await trustPlace(parent), folders: await Promise.all(folders.map(trustPlace)), home: await realpath(homedir()).catch(() => homedir()) };
    let trusted: string[] = [];
    const result = await updateClaudeConfig(file, (json) => {
      const next = trustWorktree(json, trust, env);
      trusted = next?.trusted ?? [];
      return next?.json;
    });
    if (result === 'written') log.info(`trusted ${trusted.join(', ')} for Claude (devdesk.worktrees.autoTrust), in ${file}`);
    else if (result !== 'unchanged' && result !== 'missing') log.warn(`could not trust ${folders.join(', ')} for Claude in ${file}: ${result}`);
    return result === 'written';
  } catch (err) {
    log.warn(`could not trust ${folders.join(', ')} for Claude in ${file}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * True when `claude --worktree` in `repo` would refuse to start (Claude has not trusted the repository) while DevDesk
 * may trust a worktree it makes there itself (`autoTrustWorktree`: Claude trusts the workspace root `root`), in the
 * Claude account the session starts in.
 */
export async function trustsWorktreeOnly(root: string, repo: string, account?: ClaudeAccount): Promise<boolean> {
  return worktreesAutoTrust() && (await claudeNeedsTrust(repo, account)) && !(await claudeNeedsTrust(root, account));
}
