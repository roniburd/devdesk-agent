import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boardClaudeConfigFile, sessionsClaudeEnv } from './config';
import { readTextIfExists } from './core/json';
import { needsTrust, repoRootFromGitFile, type TrustPlace } from './core/trust';

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
 * Claude's global config file (`devdesk.board.claudeConfigFile`). A file that is missing means nothing is trusted yet;
 * one that cannot be read or parsed is not guessed at (false).
 */
export async function claudeNeedsTrust(dir: string): Promise<boolean> {
  let json: unknown;
  try {
    const text = await readTextIfExists(boardClaudeConfigFile());
    json = text === undefined ? {} : JSON.parse(text);
  } catch {
    return false;
  }
  return needsTrust(json, await trustPlace(dir), { ...process.env, ...sessionsClaudeEnv() });
}
