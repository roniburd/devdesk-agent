import * as vscode from 'vscode';
import { VERSIONS_SEARCH } from './core/edition';

/** Opens the Extensions view on the two DevDesk for Claude Code versions, to enable one and disable the other. */
function showVersions(): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.extensions.search', VERSIONS_SEARCH);
}

/**
 * Registers DevDesk for Claude Code: Switch Version…. v1 runs even when v2 is enabled in this window too: v2 steps aside for it
 * (and says so), so the two never register the same commands.
 */
export function registerEdition(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('devdesk.claude.switchVersion', showVersions));
}
