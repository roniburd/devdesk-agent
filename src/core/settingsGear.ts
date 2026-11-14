/**
 * The command and argument a settings gear runs. In a remote window (`remoteName` set) it opens the Remote tab:
 * the User tab there hides `machine`-scoped settings (tool paths, tunnel settings), so a gear opening it would
 * show only part of a feature's settings. `openRemoteSettings` ignores a plain string, so the query goes in an object.
 */
export function settingsGearCommand(remoteName: string | undefined, query: string): [command: string, args: { query: string }] {
  return [remoteName ? 'workbench.action.openRemoteSettings' : 'workbench.action.openSettings', { query }];
}
