import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withEnv } from './accounts';
import { joinArgs } from './modes';
import { claudeShellCommand, fitsTmuxCommandLine, scriptedCommand } from './tmux';

/**
 * `command` as tmux is given it to start a session: as is, or, when too long for tmux's command line (a long prompt),
 * written to a script in a private temporary directory under `tmpDir` (`devdesk-claude-start-*`, the script 0600) that
 * the session's shell runs and removes.
 */
export function tmuxStartCommand(command: string, tmpDir: string): string {
  if (fitsTmuxCommandLine(command)) return command;
  const dir = mkdtempSync(join(tmpDir, 'devdesk-claude-start-'));
  const file = join(dir, 'start.sh');
  const scripted = scriptedCommand(command, dir, file);
  writeFileSync(file, scripted.script, { mode: 0o600 });
  return scripted.command;
}

/**
 * How a new session runs Claude: `devdesk.sessions.command` (a full shell command) or the binary (`path`) and
 * `devdesk.sessions.claudeArgs`, behind the Program Status relay (`wrapper`) when on, with the launch mode's arguments,
 * in the Claude account's environment (`env`, from `accountEnv`).
 */
export interface ClaudeLaunch {
  command?: string;
  path?: string;
  args?: string;
  wrapper?: string;
  /** The launch mode's arguments (`sessionsDefaultMode().args`). */
  modeArgs: string;
  env: Record<string, string>;
}

/**
 * The shell command that starts Claude as `launch` says, with `extraArgs` (a resume, a prompt) after the mode's. The
 * account's environment travels in the command, so a respawned pane (a resume) has it too.
 */
export function claudeLaunchCommand(launch: ClaudeLaunch, extraArgs = ''): string {
  const { command, path, args, wrapper } = launch;
  return withEnv(claudeShellCommand({ command, path, args, wrapper }, joinArgs(launch.modeArgs, extraArgs)), launch.env);
}
