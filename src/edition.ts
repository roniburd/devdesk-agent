import * as vscode from 'vscode';
import { BETA_ID, editionNotice, type EditionNotice, PROBE_VIEW, SWITCH_HINT, V1_ID, VERSIONS_SEARCH } from './core/edition';
import { log } from './log';

/** Opens the Extensions view on the DevDesk for Claude Code versions, to enable one and disable the others. */
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
 * Registers DevDesk for Claude Code: Switch Version…, and says when another version is enabled in this window too or
 * v2's views are missing (see `editionNotice`). v2 always runs: v1 and the v2 prototypes step aside for it. Returns
 * false (v2 starts); kept a boolean so activation reads the same as v1's, which can step aside.
 */
export async function registerEdition(ctx: vscode.ExtensionContext): Promise<boolean> {
  const viewsRegistered = (await vscode.commands.getCommands(true)).includes(`${PROBE_VIEW}.focus`);
  notice = editionNotice({ v1: !!vscode.extensions.getExtension(V1_ID), beta: !!vscode.extensions.getExtension(BETA_ID) }, viewsRegistered);
  if (notice) {
    const { message, action } = notice;
    log.warn(message);
    void vscode.window.showWarningMessage(message, action).then((pick) => {
      if (pick === 'Show Extensions') return showVersions();
      if (pick === 'Reload Window') return reloadWindow();
    });
  }
  ctx.subscriptions.push(vscode.commands.registerCommand('devdesk.claude.switchVersion', switchVersion));
  return false;
}
