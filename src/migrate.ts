import * as vscode from 'vscode';

/**
 * Copies a setting from the key it had in DevDesk Agents to its new key, once: for each of user, workspace and
 * workspace folder settings where the old key has a value and the new one has none. The old value is left in place.
 */
export async function migrateSetting(oldKey: string, newKey: string): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const from = config.inspect(oldKey);
  const to = config.inspect(newKey);
  if (!from) return;
  const targets: [unknown, unknown, vscode.ConfigurationTarget][] = [
    [from.globalValue, to?.globalValue, vscode.ConfigurationTarget.Global],
    [from.workspaceValue, to?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [from.workspaceFolderValue, to?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
  ];
  for (const [value, current, target] of targets) {
    if (value === undefined || current !== undefined) continue;
    try {
      await config.update(newKey, value, target);
    } catch {
      // No folder open for a workspace target, or the new key is not registered: nothing to migrate into.
    }
  }
}
