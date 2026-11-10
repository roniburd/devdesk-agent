import * as vscode from 'vscode';
import { editionNotice, type EditionNotice, PROBE_VIEW, SWITCH_HINT, V1_ID, VERSIONS_SEARCH } from './core/edition';
import { log } from './log';

/** Opens the Extensions view on the two DevDesk Claude versions, to enable one and disable the other. */
function showVersions(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.extensions.search', VERSIONS_SEARCH);
}

const reloadWindow = () => vscode.commands.executeCommand('workbench.action.reloadWindow');

/** Switch Version…: the Extensions view on both versions, and a reminder that switching takes a window reload. */
async function switchVersion(): Promise<void> {
  await showVersions();
  if ((await vscode.window.showInformationMessage(SWITCH_HINT, 'Reload Window')) === 'Reload Window') await reloadWindow();
}

let notice: EditionNotice | undefined;

/** What v2 told the user when it started (for the e2e tests). */
export function startNotice(): EditionNotice | undefined {
  return notice;
}

/**
 * True when v1 runs in this window too, so v2 must not start (both register the same commands and views): says so,
 * and v1 registers DevDesk Claude: Switch Version…. Otherwise the v2 marks: a `DevDesk Claude v2` status bar item,
 * Switch Version…, and a notice when an older v1 is enabled too or v2's views are missing (see `editionNotice`).
 */
export async function registerEdition(ctx: vscode.ExtensionContext): Promise<boolean> {
  const v1 = vscode.extensions.getExtension(V1_ID);
  const viewsRegistered = (await vscode.commands.getCommands(true)).includes(`${PROBE_VIEW}.focus`);
  notice = editionNotice(v1 && ((v1.packageJSON.version as string | undefined) ?? '0.0.0'), viewsRegistered);
  if (notice) {
    const { message, action } = notice;
    log.warn(message);
    void vscode.window.showWarningMessage(message, action).then((pick) => {
      if (pick === 'Show Extensions') return showVersions();
      if (pick === 'Reload Window') return reloadWindow();
    });
    if (notice.kind === 'stepAside') return true;
  }
  const item = vscode.window.createStatusBarItem('devdesk.claude.version', vscode.StatusBarAlignment.Left, 49);
  item.name = 'DevDesk Claude Version';
  item.text = '$(beaker) DevDesk Claude v2';
  item.tooltip = `DevDesk Claude v2 (${ctx.extension.packageJSON.version as string}). Click to switch versions.`;
  item.command = 'devdesk.claude.switchVersion';
  item.show();
  ctx.subscriptions.push(item, vscode.commands.registerCommand('devdesk.claude.switchVersion', switchVersion));
  return false;
}
