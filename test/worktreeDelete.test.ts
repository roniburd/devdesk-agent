import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deletePlan, deleteWorktree } from '../src/core/worktreeDelete';
import { discoverFeatures } from '../src/core/worktrees';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();

let base: string | undefined;
afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  base = undefined;
});

async function repo(): Promise<string> {
  base = realpathSync(await mkdtemp(join(tmpdir(), 'devdesk-del-')));
  const dir = join(base, 'repo');
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'README.md'), 'hi\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'worktree', 'add', '-q', '-b', 'worktree-fix', join(dir, '.claude', 'worktrees', 'fix'));
  return dir;
}

describe('deletePlan', () => {
  it('never deletes the workspace itself', async () => {
    const dir = await repo();
    const [main] = await discoverFeatures(dir);
    expect(deletePlan(dir, main)).toBeUndefined();
  });

  it("removes a git repository's linked worktree from the repository", async () => {
    const dir = await repo();
    const fix = (await discoverFeatures(dir)).find((f) => f.name === 'fix');
    expect(fix && deletePlan(dir, fix)).toEqual({ kind: 'git', repo: dir, dir: join(dir, '.claude', 'worktrees', 'fix') });
  });

});

describe('deleteWorktree', () => {
  it('refuses a git worktree with uncommitted changes unless forced, and keeps its branch', async () => {
    const dir = await repo();
    const fix = join(dir, '.claude', 'worktrees', 'fix');
    await writeFile(join(fix, 'wip.txt'), 'wip\n');
    const plan = { kind: 'git', repo: dir, dir: fix } as const;
    const refused = await deleteWorktree(plan, { force: false });
    expect(refused.ok).toBe(false);
    expect(existsSync(fix)).toBe(true);
    expect((await deleteWorktree(plan, { force: true })).ok).toBe(true);
    expect(existsSync(fix)).toBe(false);
    expect(git(dir, 'branch', '--list', 'worktree-fix')).toContain('worktree-fix');
  });

  it('runs the workspace delete command in the workspace root with the worktree, its folder and the force flag', async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'devdesk-del-')));
    const plan = { kind: 'workspace', root: base, name: 'feat', dir: join(base, 'worktrees', 'feat') } as const;
    const command = 'echo "$PWD|$DEVDESK_WORKTREE|$DEVDESK_WORKTREE_DIR|$DEVDESK_FORCE"';
    expect((await deleteWorktree(plan, { force: false, command })).output.trim()).toBe(`${base}|feat|${plan.dir}|`);
    expect((await deleteWorktree(plan, { force: true, command })).output.trim()).toBe(`${base}|feat|${plan.dir}|--force`);
    expect((await deleteWorktree(plan, { force: false, command: 'exit 86' })).ok).toBe(false);
  });
});
