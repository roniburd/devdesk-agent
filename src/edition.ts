import * as vscode from 'vscode';
import { bothEnabledWarning, V1_ID, VERSIONS_SEARCH } from './core/edition';
import { log } from './log';

/** Opens the Extensions view on the two DevDesk Claude versions, to enable one and disable the other. */
function showVersions(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.extensions.search', VERSIONS_SEARCH);
}

/**
 * The v2 marks: a `DevDesk Claude v2` status bar item, DevDesk Claude: Switch Version…, and a warning when v1 is enabled in
 * the same window (both contribute the same views and commands, so the one VS Code registered second loses them).
 */
export function registerEdition(ctx: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem('devdesk.claude.version', vscode.StatusBarAlignment.Left, 49);
  item.name = 'DevDesk Claude Version';
  item.text = '$(beaker) DevDesk Claude v2';
  item.tooltip = `DevDesk Claude v2 (${ctx.extension.packageJSON.version as string}). Click to switch versions.`;
  item.command = 'devdesk.claude.switchVersion';
  item.show();
  ctx.subscriptions.push(item, vscode.commands.registerCommand('devdesk.claude.switchVersion', showVersions));

  const warning = bothEnabledWarning(!!vscode.extensions.getExtension(V1_ID));
  if (warning) {
    log.warn(warning);
    void vscode.window.showWarningMessage(warning, 'Show Extensions').then((pick) => pick && showVersions());
  }
}
