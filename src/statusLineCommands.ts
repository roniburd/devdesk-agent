import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { claudeConfigDir, sessionsStateDir } from './config';
import type { HookFileResult } from './core/hooks';
import { installStatusLineInto, readStatusLineStatus, readUserStatusLine, removeStatusLineFrom, type StatusLineStatus } from './core/statusLine';

const shown = (path: string): string => (path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);
const settingsShown = (): string => shown(join(claudeConfigDir(), 'settings.json'));

/** Whether DevDesk's status line (which records Claude's plan limits) is installed, for the configured state directory. */
export function statusLineStatus(): Promise<StatusLineStatus> {
  return readStatusLineStatus(claudeConfigDir(), sessionsStateDir());
}

async function change(verb: 'install' | 'remove', run: () => Promise<HookFileResult>, done: string, unchanged: string): Promise<boolean> {
  try {
    const result = await run();
    void vscode.window.showInformationMessage(result.changed ? `${done}${result.backup ? ` Backup: ${result.backup}` : ''}` : unchanged);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not ${verb} DevDesk's Claude status line: ${(err as Error).message}`);
    return false;
  }
}

/** Asks, then makes DevDesk's script Claude Code's status line, running yours after it; true when it is installed. */
export async function installStatusLineCommand(): Promise<boolean> {
  const user = await readUserStatusLine(claudeConfigDir());
  const script = shown(join(claudeConfigDir(), 'devdesk', 'devdesk_statusline.py'));
  const choice = await vscode.window.showInformationMessage(
    "Show Claude's 5-hour and weekly limits?",
    {
      modal: true,
      detail:
        "Claude Code tells its status line command how much of your plan's 5-hour and weekly limits you've used (Claude.ai Pro and Max subscriptions only). " +
        `DevDesk sets the status line in ${settingsShown()} on this machine to ${script}, which records them in the configured state directory for the board's 📊, then ` +
        (user
          ? `runs your status line (${user.length > 80 ? `${user.slice(0, 77)}…` : user}) with the same input and shows what it prints. Your command is kept in the setting and comes back when you remove DevDesk's.`
          : 'prints the model, the context used and the limits.') +
        ' The settings file is backed up first. Running sessions pick it up on their next status line update.',
    },
    'Install',
  );
  if (choice !== 'Install') return false;
  return change(
    'install',
    () => installStatusLineInto(claudeConfigDir(), new Date(), sessionsStateDir()),
    "DevDesk's Claude status line installed. The limits show after Claude's next reply.",
    "DevDesk's Claude status line was already installed.",
  );
}

/** Asks, then removes DevDesk's status line, giving back the one it ran; true when it is removed. */
export async function removeStatusLineCommand(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    "Remove DevDesk's Claude status line?",
    { modal: true, detail: `Puts back the status line you had in ${settingsShown()} (or none), after a backup. The board's 📊 stops showing plan limits.` },
    'Remove',
  );
  if (choice !== 'Remove') return false;
  return change('remove', () => removeStatusLineFrom(claudeConfigDir(), new Date()), "DevDesk's Claude status line removed.", "DevDesk's Claude status line was not installed.");
}
