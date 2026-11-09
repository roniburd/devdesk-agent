import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A repository's refs read from its files, without running git. Undefined values: not found, or not readable this way. */
export interface Refs {
  /** The repository's (or linked worktree's) own git directory, where HEAD and the index are. */
  gitDir: string;
  /** The commit HEAD is at. */
  head: string | undefined;
  /** The commit `name` (`origin/mainline`, `main`, `origin/HEAD`) names, resolved as `git rev-parse` does for a ref name. */
  resolve(name: string): Promise<string | undefined>;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `<repo>/.git` as a directory, or the `gitdir:` a linked worktree's `.git` file points to, and its common directory. */
async function gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string } | undefined> {
  const dotGit = join(repo, '.git');
  try {
    if ((await stat(dotGit)).isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'));
    if (!m) return undefined;
    const gitDir = resolve(repo, m[1].trim());
    const common = await readFile(join(gitDir, 'commondir'), 'utf8').then(
      (c) => resolve(gitDir, c.trim()),
      () => gitDir,
    );
    return { gitDir, commonDir: common };
  } catch {
    return undefined;
  }
}

/**
 * Reads `repo`'s HEAD and lets refs be resolved from loose ref files and `packed-refs`. Undefined when `repo` is not a
 * git repository that can be read this way (for example one using reftable): callers then ask git.
 */
export async function readRefs(repo: string): Promise<Refs | undefined> {
  const dirs = await gitDirs(repo);
  if (!dirs) return undefined;
  let packed: Promise<Map<string, string>> | undefined;
  const packedRefs = () =>
    (packed ??= readFile(join(dirs.commonDir, 'packed-refs'), 'utf8').then(
      (text) => {
        const map = new Map<string, string>();
        for (const line of text.split('\n')) {
          const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
          if (m) map.set(m[2], m[1]);
        }
        return map;
      },
      () => new Map<string, string>(),
    ));

  /** The commit a full ref (`HEAD`, `refs/heads/x`) points to, following symbolic refs. */
  const readRef = async (ref: string, depth = 0): Promise<string | undefined> => {
    if (depth > 5) return undefined;
    // HEAD (and the other pseudo-refs) belong to the worktree; branches and remotes are shared.
    const base = ref.startsWith('refs/') ? dirs.commonDir : dirs.gitDir;
    let content: string | undefined;
    try {
      content = (await readFile(join(base, ref), 'utf8')).trim();
    } catch {
      content = undefined;
    }
    if (content === undefined) return ref.startsWith('refs/') ? (await packedRefs()).get(ref) : undefined;
    if (content.startsWith('ref:')) return readRef(content.slice(4).trim(), depth + 1);
    return SHA.test(content) ? content : undefined;
  };

  const head = await readRef('HEAD');
  return {
    gitDir: dirs.gitDir,
    head,
    // The order `git rev-parse <name>` tries (gitrevisions(7)).
    resolve: async (name) => {
      for (const ref of [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
        const sha = await readRef(ref);
        if (sha) return sha;
      }
      return undefined;
    },
  };
}

/**
 * What changes when git state that the Worktrees view shows changes, read without running git: HEAD's commit (a
 * commit, checkout, rebase), the index file's time and size (`git add`, `git rm`, a commit), and the commit of the
 * mainline `upstream` (a fetch or pull). Edits to files that git has not seen yet do not change it. Undefined when the
 * repository can't be read this way.
 */
export async function gitFingerprint(repo: string, upstream?: string): Promise<string | undefined> {
  const refs = await readRefs(repo);
  if (!refs) return undefined;
  const [index, mainline] = await Promise.all([
    stat(join(refs.gitDir, 'index')).then(
      (s) => `${s.mtimeMs}:${s.size}`,
      () => '',
    ),
    upstream ? refs.resolve(upstream) : Promise.resolve(undefined),
  ]);
  return `${refs.head ?? ''}|${index}|${mainline ?? ''}`;
}

/**
 * A gitFingerprint read with no `upstream` (not known before the first load), completed with the mainline commit that
 * load found: what the next gitFingerprint with that upstream returns when nothing changed meanwhile.
 */
export function withMainline(fingerprint: string, mainlineSha: string): string {
  return fingerprint.endsWith('|') ? fingerprint + mainlineSha : fingerprint;
}
