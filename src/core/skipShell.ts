/**
 * The `terminal.integrated.commandsToSkipShell` user setting to write so DevDesk's `command` (bound to ← in its Claude
 * terminals) is in it as this window wants, or undefined to leave it as it is. The setting is one for every window
 * while `devdesk.sessions.leftArrowOpensSidebar` can differ between folders, so windows must not take turns
 * flipping it:
 * - a window that wants the entry adds it whenever it is missing (also after another window removed it);
 * - only the user turning the setting off (`turnedOff`, a change in this window) removes it. A window where it is off
 *   otherwise leaves the entry alone: its ← keybinding's `when` clause already checks the setting, so the entry does
 *   nothing there.
 */
export function skipShellUpdate(current: readonly string[], command: string, want: boolean, turnedOff: boolean): string[] | undefined {
  const has = current.includes(command);
  if (want) return has ? undefined : [...current, command];
  return turnedOff && has ? current.filter((c) => c !== command) : undefined;
}
