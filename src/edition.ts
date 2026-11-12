import * as vscode from 'vscode';
import { STEP_ASIDE_MESSAGE, V2_ID, VERSIONS_SEARCH } from './core/edition';
import { log } from './log';

/** Opens the Extensions view on the two DevDesk for Claude Code versions, to enable one and disable the other. */
function showVersions(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.extensions.search', VERSIONS_SEARCH);
}

/**
 * True when v2 is enabled in this window too, so v1 must not start (both register the same commands and views): says
 * so, and v2 registers DevDesk for Claude Code: Switch Version…. Otherwise registers Switch Version… and returns false.
 */
export function registerEdition(ctx: vscode.ExtensionContext): boolean {
  if (vscode.extensions.getExtension(V2_ID)) {
    log.warn(STEP_ASIDE_MESSAGE);
    void vscode.window.showWarningMessage(STEP_ASIDE_MESSAGE, 'Show Extensions').then((pick) => pick && showVersions());
    return true;
  }
  ctx.subscriptions.push(vscode.commands.registerCommand('devdesk.claude.switchVersion', showVersions));
  return false;
}
