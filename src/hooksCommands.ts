import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { type HookFileResult, type HooksStatus, hookEvents, installHooksInto, parseClaudeVersion, readHooksInstalled, readHooksStatus, removeHooksFrom } from './core/hooks';
import { join } from 'node:path';
import { claudeConfigDir, claudeInvocation, sessionsStateDir } from './config';
import { runCommand } from './core/shellRun';

/** `path` with the home directory shown as `~`, for messages. */
const shown = (path: string): string => (path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** Claude Code's settings file, where the hooks go (in `$CLAUDE_CONFIG_DIR` when set), as shown in messages. */
export const hooksSettingsShown = (): string => shown(join(claudeConfigDir(), 'settings.json'));

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

/** True when every DevDesk hook runs the current script with the configured state directory. */
export async function hooksInstalled(): Promise<boolean> {
  return readHooksInstalled(claudeConfigDir(), sessionsStateDir(), await claudeCodeVersion());
}

/** Whether the DevDesk hooks are installed, and with the configured state directory. */
export async function hooksStatus(): Promise<HooksStatus> {
  return readHooksStatus(claudeConfigDir(), sessionsStateDir(), await claudeCodeVersion());
}

/** Runs a confirmed change to the hooks and says how it went (`done` when it changed something); true unless it failed. */
async function changeHooks(verb: 'install' | 'remove', change: () => Promise<HookFileResult>, done: string, unchanged: string): Promise<boolean> {
  try {
    const result = await change();
    void vscode.window.showInformationMessage(result.changed ? `${done}${result.backup ? ` Backup: ${result.backup}` : ''}` : unchanged);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not ${verb} Claude status hooks: ${(err as Error).message}`);
    return false;
  }
}

/** Asks, then installs the DevDesk hooks in Claude Code's `settings.json`; true when they are installed. */
export async function installHooksCommand(): Promise<boolean> {
  const version = await claudeCodeVersion(true);
  const events = hookEvents(version);
  const choice = await vscode.window.showInformationMessage(
    'Install Claude status hooks?',
    {
      modal: true,
      detail:
        `DevDesk adds hooks to ${hooksSettingsShown()} on this machine for ${events.slice(0, -1).join(', ')} and ${events[events.length - 1]}. Each runs ${shown(join(claudeConfigDir(), 'devdesk', 'devdesk_hook.py'))}, which writes a small status file ` +
        'to the configured state directory and always exits successfully, even if the script is missing. Older DevDesk ' +
        'hook entries are updated in place; your other hooks are kept, and the current settings file is backed up first. ' +
        'Claude sessions started from now on report their status; restart running sessions to include them.',
    },
    'Install',
  );
  if (choice !== 'Install') return false;
  return changeHooks(
    'install',
    () => installHooksInto(claudeConfigDir(), new Date(), sessionsStateDir(), version),
    'Claude status hooks installed.',
    'Claude status hooks were already installed.',
  );
}

/** Asks, then removes the DevDesk hooks; true when they are removed. */
export async function removeHooksCommand(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'Remove Claude status hooks?',
    { modal: true, detail: `Removes only the DevDesk hook entries from ${hooksSettingsShown()} (after a backup). Other hooks are kept.` },
    'Remove',
  );
  if (choice !== 'Remove') return false;
  return changeHooks('remove', () => removeHooksFrom(claudeConfigDir(), new Date()), 'Claude status hooks removed.', 'No DevDesk hooks were installed.');
}
