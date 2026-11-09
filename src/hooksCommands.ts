import { watch } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { type HookFileResult, type HooksStatus, installHooksInto, readHooksInstalled, readHooksStatus, removeHooksFrom } from './core/hooks';
import { join } from 'node:path';
import { claudeConfigDir, sessionsStateDir } from './config';

/** `path` with the home directory shown as `~`, for messages. */
const shown = (path: string): string => (path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** Claude Code's settings file, where the hooks go (in `$CLAUDE_CONFIG_DIR` when set), as shown in messages. */
export const hooksSettingsShown = (): string => shown(join(claudeConfigDir(), 'settings.json'));

/** True when every DevDesk hook runs the current script with the configured state directory. */
export function hooksInstalled(): Promise<boolean> {
  return readHooksInstalled(claudeConfigDir(), sessionsStateDir());
}

/**
 * Calls `onChange` (debounced) when Claude Code's `settings.json` may have changed: installed or removed from another
 * window, by another tool, or rewritten by Claude Code. Watches the directory, as a write may replace the file.
 */
export function watchHooksSettings(onChange: () => void): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(claudeConfigDir(), (_event, name) => {
      if (name && String(name) !== 'settings.json') return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    });
    watcher.on('error', () => watcher.close());
    return new vscode.Disposable(() => {
      clearTimeout(timer);
      watcher.close();
    });
  } catch {
    // No Claude config directory yet: installing creates it, and that window refreshes itself.
    return new vscode.Disposable(() => undefined);
  }
}

/** Whether the DevDesk hooks are installed, and with the configured state directory. */
export function hooksStatus(): Promise<HooksStatus> {
  return readHooksStatus(claudeConfigDir(), sessionsStateDir());
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
  const choice = await vscode.window.showInformationMessage(
    'Install Claude status hooks?',
    {
      modal: true,
      detail:
        `DevDesk adds hooks to ${hooksSettingsShown()} on this machine for SessionStart, UserPromptSubmit, PreToolUse, ` +
        `PostToolUse, Notification, Stop, StopFailure and SessionEnd. Each runs ${shown(join(claudeConfigDir(), 'devdesk', 'devdesk_hook.py'))}, which writes a small status file ` +
        'to the configured state directory and always exits successfully, even if the script is missing. Older DevDesk ' +
        'hook entries are updated in place; your other hooks are kept, and the current settings file is backed up first. ' +
        'Claude sessions started from now on report their status; restart running sessions to include them.',
    },
    'Install',
  );
  if (choice !== 'Install') return false;
  return changeHooks(
    'install',
    () => installHooksInto(claudeConfigDir(), new Date(), sessionsStateDir()),
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
