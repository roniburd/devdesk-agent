import * as vscode from 'vscode';
import { stepAsideMessage, V2_ID, VERSIONS_SEARCH } from './core/edition';
import { log } from './log';

/** Opens the Extensions view on the two DevDesk for Claude Code versions, to enable one and disable the other. */
function showVersions(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.extensions.search', VERSIONS_SEARCH);
}

/**
 * True when v2 is enabled in this window, so v1 must not start (both register the same commands); says so. Otherwise
 * registers DevDesk for Claude Code: Switch Version…, which v2 registers when it runs.
 */
export function stepAsideForV2(ctx: vscode.ExtensionContext): boolean {
  const message = stepAsideMessage(!!vscode.extensions.getExtension(V2_ID));
  if (!message) {
    ctx.subscriptions.push(vscode.commands.registerCommand('devdesk.claude.switchVersion', showVersions));
    return false;
  }
  log.warn(message);
  void vscode.window.showInformationMessage(message, 'Show Extensions').then((pick) => pick && showVersions());
  return true;
}
