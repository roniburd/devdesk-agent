import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { workspaceProvider } from './workspaceProvider';

export interface PackageRepo {
  name: string;
  dir: string;
}

export interface Feature {
  name: string;
  dir: string;
  isMain: boolean;
  packages: PackageRepo[];
  /** `dir` with symlinks resolved, when that differs: Claude reports its cwd that way (`/private/var/…` on macOS). */
  realDir?: string;
}

/** The worktree's directory, and its symlink-resolved one when that differs. */
export const featureDirs = (f: Feature): string[] => (f.realDir ? [f.dir, f.realDir] : [f.dir]);

/** True when `a` and `b` describe the same worktree with the same packages, so its row can stay as it is. */
export function sameFeature(a: Feature, b: Feature): boolean {
  return (
    a.name === b.name &&
    a.dir === b.dir &&
    a.isMain === b.isMain &&
    a.realDir === b.realDir &&
    a.packages.length === b.packages.length &&
    a.packages.every((p, i) => p.name === b.packages[i].name && p.dir === b.packages[i].dir)
  );
}

async function withRealDir(feature: Feature): Promise<Feature> {
  try {
    const real = await realpath(feature.dir);
    return real === feature.dir ? feature : { ...feature, realDir: real };
  } catch {
    return feature;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Directories under `<featureDir>/src` that are git repositories or worktrees. */
async function discoverPackages(featureDir: string): Promise<PackageRepo[]> {
  const src = join(featureDir, 'src');
  const packages: PackageRepo[] = [];
  for (const name of await subdirectories(src)) {
    const dir = join(src, name);
    if (await exists(join(dir, '.git'))) packages.push({ name, dir });
  }
  return packages;
}

/** Claude Code worktrees (`claude --worktree`) of the workspace's packages: `<package>/.claude/worktrees/<name>`, git worktrees of that package. */
async function claudeWorktrees(packages: readonly PackageRepo[]): Promise<Feature[]> {
  const lists = await Promise.all(
    packages.map(async (pkg) => {
      const base = join(pkg.dir, '.claude', 'worktrees');
      const names = await subdirectories(base);
      const repos = await Promise.all(names.map((name) => exists(join(base, name, '.git'))));
      return names
        .filter((_, i) => repos[i])
        .map((name): Feature => ({ name, dir: join(base, name), isMain: false, packages: [{ name: pkg.name, dir: join(base, name) }] }));
    }),
  );
  return lists.flat();
}

/**
 * True when `root` is a plain folder: neither a package workspace nor inside a git repository. Sessions run in it as
 * main, but it has no worktrees and none can be made in it.
 */
export function isPlainFolder(root: string): boolean {
  return !isPackageWorkspace(root) && gitRootFor(root) === undefined;
}

/** True when `root` is a plain git repository (its main worktree) rather than a package workspace. */
export function isGitWorkspace(root: string): boolean {
  return !isPackageWorkspace(root) && isGitMainWorktree(root);
}

/**
 * A plain git repository's features (`gitFeatures`), else the workspace root as feature `main`, then each
 * package workspace worktree under `<root>/worktrees/` (other directories there are skipped), then, with `claudeWorktrees`, the
 * packages' Claude Code worktrees.
 */
export async function discoverFeatures(root: string, opts: { claudeWorktrees?: boolean } = {}): Promise<Feature[]> {
  if (isGitWorkspace(root)) return Promise.all(gitFeatures(root).map(withRealDir));
  const main: Feature = { name: 'main', dir: root, isMain: true, packages: await discoverPackages(root) };
  const names = (await subdirectories(join(root, 'worktrees'))).filter((name) => isPackageWorkspace(join(root, 'worktrees', name)));
  const features = await Promise.all(
    names.map(async (name): Promise<Feature> => {
      const dir = join(root, 'worktrees', name);
      return { name, dir, isMain: false, packages: await discoverPackages(dir) };
    }),
  );
  const claude = opts.claudeWorktrees ? await claudeWorktrees(main.packages) : [];
  return Promise.all([main, ...features, ...claude].map(withRealDir));
}

/** True when `dir` is a git repository's main worktree (its `.git` is a directory, not a linked worktree's file). */
function isGitMainWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A git repository as features: the repository itself as `main`, then each linked worktree (`git worktree add`, Claude
 * Code's `.claude/worktrees/<name>`, anywhere on disk) that still exists, named after its directory. Each feature's one
 * package is the repository (or worktree) itself. Reads `.git/worktrees/<id>/gitdir`, so no git process runs.
 */
function gitFeatures(root: string): Feature[] {
  const repo = basename(root);
  const main: Feature = { name: 'main', dir: root, isMain: true, packages: [{ name: repo, dir: root }] };
  const admin = join(root, '.git', 'worktrees');
  let ids: string[];
  try {
    ids = readdirSync(admin).sort();
  } catch {
    ids = [];
  }
  const linked: Feature[] = [];
  for (const id of ids) {
    let gitFile: string;
    try {
      gitFile = readFileSync(join(admin, id, 'gitdir'), 'utf8').trim();
    } catch {
      continue;
    }
    const dir = dirname(gitFile);
    if (!gitFile || !existsSync(gitFile)) continue;
    linked.push({ name: basename(dir), dir, isMain: false, packages: [{ name: repo, dir }] });
  }
  return [main, ...linked.sort((a, b) => a.name.localeCompare(b.name))];
}

/** What a linked worktree's `.git` file says: its own git directory and, when that is `<main>/.git/worktrees/<id>`, `<main>`. */
export interface GitdirFile {
  gitDir: string;
  /** The main worktree's root; undefined when the git directory is not one of a repository's worktrees (a submodule). */
  repo: string | undefined;
}

/** Parses the `gitdir: <path>` line of the `.git` file in `dir` (a relative path is from `dir`); undefined when there is none. */
export function parseGitdirFile(content: string, dir: string): GitdirFile | undefined {
  const m = /^gitdir:\s*(.+)$/m.exec(content);
  if (!m) return undefined;
  const gitDir = resolve(dir, m[1].trim());
  const main = /^(.+)\/\.git\/worktrees\/[^/]+$/.exec(gitDir);
  return { gitDir, repo: main?.[1] };
}

/** A directory holding a `.git`: `top` is that directory, `repo` the main worktree's root (`top` unless a linked worktree). */
export interface GitPlace {
  top: string;
  repo: string;
}

/** The git place `dir` is the top of, or undefined when `dir` has no readable `.git`. Does not look above `dir`. */
export function gitPlace(dir: string): GitPlace | undefined {
  const dotGit = join(dir, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return { top: dir, repo: dir };
    // A linked worktree: `.git` is a file with `gitdir: <main>/.git/worktrees/<id>`.
    return { top: dir, repo: parseGitdirFile(readFileSync(dotGit, 'utf8'), dir)?.repo ?? dir };
  } catch {
    return undefined; // no .git here
  }
}

/** The git place of the worktree containing `folder`: `gitPlace` of `folder` or the nearest directory above it that has one. */
export function findGitPlace(folder: string): GitPlace | undefined {
  return findUp(folder, gitPlace);
}

/**
 * The main worktree of the git repository containing `folder` (from a linked worktree, its main repository), else
 * undefined.
 */
export function gitRootFor(folder: string): string | undefined {
  return findGitPlace(folder)?.repo;
}

/** The first `found(dir)` that is not undefined, for `folder` and then each directory above it. */
function findUp<T>(folder: string, found: (dir: string) => T | undefined): T | undefined {
  for (let dir = folder.replace(/\/+$/, '') || '/'; ; dir = dirname(dir)) {
    const result = found(dir);
    if (result !== undefined) return result;
    if (dirname(dir) === dir) return undefined;
  }
}

/** True when `dir` is a package workspace (see `workspaceKind.ts`) or one of its worktrees; never without a provider. */
export function isPackageWorkspace(dir: string): boolean {
  return workspaceProvider?.isWorkspace(dir) ?? false;
}

/** `<root>/worktrees/<feature>` → `<root>` when `<root>` is a package workspace; anything else unchanged. */
export function normalizeRoot(path: string): string {
  const m = /^(.*)\/worktrees\/[^/]+\/?$/.exec(path);
  return m && isPackageWorkspace(m[1]) ? m[1] : path;
}

/**
 * The workspace root for a folder anywhere inside a package workspace (the root, a feature
 * worktree, a package, or a directory inside one), else undefined.
 */
export function workspaceRootFor(folder: string): string | undefined {
  return findUp(folder, (dir) => (isPackageWorkspace(dir) ? normalizeRoot(dir) : undefined));
}
