import * as vscode from 'vscode';
import { sessionsTmux, sessionsTmuxConfigFileSetting, sessionsTmuxServer } from './config';
import { joinCommands } from './core/smoothScroll';
import { DEFAULT_SERVER } from './core/tmux';
import { unsetHookCommands } from './core/tmuxConfig';
import { log } from './log';

/**
 * Gives DevDesk's running tmux server what its sanitized config (`sanitizedTmuxConfigFile`) gives a new one: no hooks.
 * A server started before this version, with the user's own tmux config, keeps its hooks otherwise until it restarts.
 * Does nothing when no server runs, when `devdesk.sessions.tmuxConfigFile` names a file (the user's choice), or on
 * tmux's own server (`default`), whose hooks are the user's.
 */
export async function unsetRunningServerHooks(): Promise<void> {
  if (sessionsTmuxConfigFileSetting() || sessionsTmuxServer() === DEFAULT_SERVER) return;
  try {
    await sessionsTmux()(joinCommands(unsetHookCommands()));
  } catch (err) {
    if (!/no server running|error connecting/i.test((err as Error).message)) log.warn(`tmux hooks: ${(err as Error).message}`);
  }
}

export function registerTmuxConfig(): vscode.Disposable[] {
  void unsetRunningServerHooks();
  return [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devdesk.sessions.tmuxConfigFile') || e.affectsConfiguration('devdesk.sessions.tmuxServer')) void unsetRunningServerHooks();
    }),
  ];
}
