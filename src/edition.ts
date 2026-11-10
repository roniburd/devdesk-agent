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
 * The v2 marks: a `DevDesk Claude v2` status bar item, DevDesk Claude: Switch Version…, and a notice when v1 is
 * enabled in the same window or v2's views are missing (see `editionNotice`).
 */
export async function registerEdition(ctx: vscode.ExtensionContext): Promise<void> {
  const item = vscode.window.createStatusBarItem('devdesk.claude.version', vscode.StatusBarAlignment.Left, 49);
  item.name = 'DevDesk Claude Version';
  item.text = '$(beaker) DevDesk Claude v2';
  item.tooltip = `DevDesk Claude v2 (${ctx.extension.packageJSON.version as string}). Click to switch versions.`;
  item.command = 'devdesk.claude.switchVersion';
  item.show();
  ctx.subscriptions.push(item, vscode.commands.registerCommand('devdesk.claude.switchVersion', switchVersion));

  const viewsRegistered = (await vscode.commands.getCommands(true)).includes(`${PROBE_VIEW}.focus`);
  notice = editionNotice(!!vscode.extensions.getExtension(V1_ID), viewsRegistered);
  if (!notice) return;
  const { message, action } = notice;
  log.warn(message);
  void vscode.window.showWarningMessage(message, action).then((pick) => {
    if (pick === 'Show Extensions') return showVersions();
    if (pick === 'Reload Window') return reloadWindow();
  });
}
