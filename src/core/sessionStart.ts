import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fitsTmuxCommandLine, scriptedCommand } from './tmux';

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
