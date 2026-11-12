import { watch } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { type HookFileResult, type HooksStatus, installHooksInto, parseClaudeVersion, readHooksInstalled, readHooksStatus, removeHooksFrom } from './core/hooks';
import { join } from 'node:path';
import { claudeAccounts, claudeConfigDir, claudeInvocation, sessionsStateDir, shownPath } from './config';
import { type ClaudeAccount, worstStatus } from './core/accounts';
import { runCommand } from './core/shellRun';

/**
 * The config directories that need DevDesk's hooks: each Claude account's (`devdesk.claude.accounts`), so every
 * session reports its status whichever account it runs in. Claude's own directory when no account is listed.
 */
export const hookDirs = (): string[] => [...new Set(claudeAccounts().map((a) => a.configDir))];

/** Claude Code's settings files, where the hooks go (one per account), as shown in messages. */
export const hooksSettingsShown = (dirs = hookDirs()): string => dirs.map((d) => shownPath(join(d, 'settings.json'))).join(', ');

/** `claude --version` (as new sessions run Claude) per invocation, asked once per window unless `fresh`. */
const versions = new Map<string, Promise<string | undefined>>();

/**
 * The version of the Claude Code new sessions run, or undefined when it cannot be told: it picks the hook events that
 * Claude Code knows (`hookEvents`), since one it does not know makes it reject the whole settings file.
 */
export function claudeCodeVersion(fresh = false): Promise<string | undefined> {
  const claude = claudeInvocation();
  let version = fresh ? undefined : versions.get(claude);
  if (!version) {
    version = runCommand(process.env.SHELL || '/bin/sh', ['-lc', `${claude} --version`], { cwd: homedir(), timeoutMs: 15_000 }).then((r) =>
      r.ok ? parseClaudeVersion(r.output) : undefined,
    );
    versions.set(claude, version);
  }
  return version;
}

/** True when every DevDesk hook runs the current script with the configured state directory, in `account`'s settings (default: the default account's). */
export async function hooksInstalled(account?: ClaudeAccount): Promise<boolean> {
  return readHooksInstalled(claudeConfigDir(account), sessionsStateDir(), await claudeCodeVersion());
}

/**
 * Calls `onChange` (debounced) when one of Claude Code's `settings.json` (one per account) may have changed: installed
 * or removed from another window, by another tool, or rewritten by Claude Code. Watches the directories, as a write may
 * replace the file.
 */
export function watchHooksSettings(onChange: () => void): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const start = () =>
    hookDirs().flatMap((dir) => {
      try {
        const watcher = watch(dir, (_event, name) => {
          if (name && String(name) !== 'settings.json') return;
          clearTimeout(timer);
          timer = setTimeout(onChange, 250);
        });
        watcher.on('error', () => watcher.close());
        return [watcher];
      } catch {
        // No Claude config directory yet: installing creates it, and that window refreshes itself.
        return [];
      }
    });
  let watchers = start();
  // Other accounts: other settings files to watch, and their hooks to read.
  const accounts = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('devdesk.claude.accounts')) return;
    for (const w of watchers) w.close();
    watchers = start();
    onChange();
  });
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    accounts.dispose();
    for (const w of watchers) w.close();
  });
}

/** Whether the DevDesk hooks are installed, with the configured state directory, in every account's settings (the one needing the most). */
export async function hooksStatus(): Promise<HooksStatus> {
  return worstStatus(await hookStatuses().then((s) => s.map((x) => x.status)));
}

/**
 * The names of the Claude accounts whose settings lack DevDesk's hooks while another account has them (someone who uses
 * the hooks added an account); none with a single account.
 */
export async function accountsWithoutHooks(): Promise<string[]> {
  const accounts = claudeAccounts();
  if (accounts.length < 2) return [];
  const statuses = await hookStatuses();
  if (!statuses.some((s) => s.status !== 'missing')) return [];
  const missing = new Set(statuses.filter((s) => s.status === 'missing').map((s) => s.dir));
  return accounts.filter((a) => missing.has(a.configDir)).map((a) => a.name);
}

/** Each account's config directory and its hooks' status. */
async function hookStatuses(): Promise<{ dir: string; status: HooksStatus }[]> {
  const version = await claudeCodeVersion();
  return Promise.all(hookDirs().map(async (dir) => ({ dir, status: await readHooksStatus(dir, sessionsStateDir(), version).catch((): HooksStatus => 'missing') })));
}

/** Runs a confirmed change to the hooks in each of `dirs` and says how it went (`done` when it changed something); true unless one failed. */
async function changeHooks(verb: 'install' | 'remove', dirs: readonly string[], change: (dir: string) => Promise<HookFileResult>, done: string, unchanged: string): Promise<boolean> {
  const backups: string[] = [];
  let changed = false;
  for (const dir of dirs) {
    try {
      const result = await change(dir);
      changed ||= result.changed;
      if (result.backup) backups.push(result.backup);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not ${verb} Claude status hooks in ${shownPath(join(dir, 'settings.json'))}: ${(err as Error).message}`);
      return false;
    }
  }
  void vscode.window.showInformationMessage(changed ? `${done}${backups.length ? ` Backup: ${backups.join(', ')}` : ''}` : unchanged);
  return true;
}

/**
 * Asks, then installs the DevDesk hooks in Claude Code's `settings.json` of each account that lacks them (or has old
 * ones); true when they are installed.
 */
export async function installHooksCommand(): Promise<boolean> {
  const version = await claudeCodeVersion(true);
  const statuses = await hookStatuses();
  const needed = statuses.filter((s) => s.status !== 'installed');
  // Already everywhere: install again in each (it says nothing changed).
  const dirs = (needed.length ? needed : statuses).map((s) => s.dir);
  const outdated = needed.length > 0 && needed.every((s) => s.status === 'outdated');
  const settings = hooksSettingsShown(dirs);
  const choice = await vscode.window.showInformationMessage(
    outdated ? 'Update Claude status hooks?' : 'Install Claude status hooks?',
    {
      modal: true,
      detail:
        (outdated
          ? `This version of DevDesk needs its hooks in ${settings} updated so every session shows its status.`
          : `DevDesk adds hooks to ${settings} so the Claude view can show what each session is doing: working, waiting for you, or done.`) +
        (statuses.length > 1 ? ' (one settings file per Claude account, devdesk.claude.accounts)' : '') +
        '\n\nYour other settings stay as they are, and the file is backed up first. ' +
        'New sessions show their status right away; restart running ones to see theirs.',
    },
    outdated ? 'Update' : 'Install',
  );
  if (choice !== 'Update' && choice !== 'Install') return false;
  return changeHooks(
    'install',
    dirs,
    (dir) => installHooksInto(dir, new Date(), sessionsStateDir(), version),
    'Claude status hooks installed.',
    'Claude status hooks were already installed.',
  );
}

/** Asks, then removes the DevDesk hooks from every account's settings; true when they are removed. */
export async function removeHooksCommand(): Promise<boolean> {
  const dirs = hookDirs();
  const choice = await vscode.window.showWarningMessage(
    'Remove Claude status hooks?',
    { modal: true, detail: `Removes only the DevDesk hook entries from ${hooksSettingsShown(dirs)} (after a backup). Other hooks are kept.` },
    'Remove',
  );
  if (choice !== 'Remove') return false;
  return changeHooks('remove', dirs, (dir) => removeHooksFrom(dir, new Date()), 'Claude status hooks removed.', 'No DevDesk hooks were installed.');
}
