import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { type BaseRef, type DiffMode, diffSides, type FileChange, gitRunner, listChanges, resolveBase } from './core/git';
import { isWithin } from './core/paths';
import { packageForPath } from './core/worktreeSignals';
import type { Feature, PackageRepo } from './core/worktrees';
import { worktreesGitTimeoutMs } from './config';
import { toGitUri } from './gitContent';

/** A changed file of a package, against the Worktrees view's base. */
export interface ChangedFile {
  feature: Feature;
  pkg: PackageRepo;
  base: BaseRef;
  change: FileChange;
}

/** The diff's two sides (a `devdesk-git` document at the base, the file in the working tree) and its title. */
export function diffUris({ pkg, base, change }: ChangedFile): { left: vscode.Uri; right: vscode.Uri; title: string } {
  const sides = diffSides(change, base);
  const empty = toGitUri({ dir: pkg.dir, ref: '', path: change.path });
  const left = sides.left === 'empty' ? empty : toGitUri({ dir: pkg.dir, ...sides.left });
  const right = sides.right === 'empty' ? empty : vscode.Uri.file(join(pkg.dir, change.path));
  return { left, right, title: `${pkg.name}/${change.path} (${base.label} ↔ working tree)` };
}

/** Told of each working-tree file a diff opens (the review notes allow comments on it). */
const opened = new vscode.EventEmitter<{ uri: vscode.Uri; feature: Feature }>();
export const onDidOpenDiff = opened.event;

/** Opens the file's diff; `preserveFocus` leaves the keyboard focus where it is. */
export async function openDiff(file: ChangedFile, preserveFocus = false): Promise<void> {
  const { left, right, title } = diffUris(file);
  if (right.scheme === 'file') opened.fire({ uri: right, feature: file.feature });
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preserveFocus, preview: true });
}

/** Opens every file's diff in one multi-file diff editor. */
export async function openChanges(feature: Feature, files: readonly ChangedFile[]): Promise<void> {
  const resources = files.map((f) => {
    const { left, right } = diffUris(f);
    if (right.scheme === 'file') opened.fire({ uri: right, feature: f.feature });
    return [right.scheme === 'file' ? right : left, left, right] as const;
  });
  await vscode.commands.executeCommand('vscode.changes', `${feature.name}: changes vs ${files[0]?.base.label ?? 'base'}`, resources);
}

/** The changed files of the feature's packages (only the one holding `path`, when given), against the view's base. */
export async function changedFiles(feature: Feature, mode: DiffMode, path?: string): Promise<ChangedFile[]> {
  const run = gitRunner(worktreesGitTimeoutMs());
  const pkgDir = path ? packageForPath(path, feature.packages.map((p) => p.dir)) : undefined;
  const pkgs = path ? feature.packages.filter((p) => p.dir === pkgDir) : feature.packages;
  const lists = await Promise.all(
    pkgs.map(async (pkg) => {
      const base = await resolveBase(run, pkg.dir, mode);
      const changes = await listChanges(run, pkg.dir, base.ref);
      return changes.map((change) => ({ feature, pkg, base, change }));
    }),
  );
  const all = lists.flat();
  if (!path) return all;
  return all.filter((f) => join(f.pkg.dir, f.change.path) === path);
}

/** The file's path as Claude in the worktree names it: relative to the worktree, or as it is outside it. */
export function worktreePath(feature: Feature, file: string): string {
  for (const dir of [feature.dir, ...(feature.realDir ? [feature.realDir] : [])]) if (isWithin(file, dir)) return relative(dir, file) || file;
  return file;
}
