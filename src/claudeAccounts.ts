import * as vscode from 'vscode';
import { claudeAccountOf, claudeAccounts, claudeDefaultAccount, openSettings, shownPath } from './config';
import type { ClaudeAccount } from './core/accounts';

/**
 * The Claude account (`devdesk.claude.accounts`) a session runs in, from its transcript, so a resume or a fork keeps
 * it; the default account when there is none yet.
 */
export function sessionAccount(card: { transcriptPath?: string | null }): ClaudeAccount {
  return claudeAccountOf(card.transcriptPath ?? undefined) ?? claudeDefaultAccount();
}

type AccountItem = vscode.QuickPickItem & { account?: ClaudeAccount; settings?: true };

/**
 * The account a new session starts in: the only one without asking, else the one picked (the default first);
 * undefined when cancelled.
 */
export async function pickClaudeAccount(title: string): Promise<ClaudeAccount | undefined> {
  const accounts = claudeAccounts();
  const fallback = claudeDefaultAccount();
  if (accounts.length < 2) return fallback;
  const ordered = [fallback, ...accounts.filter((a) => a !== fallback && a.name !== fallback.name)];
  const items: AccountItem[] = ordered.map((account) => ({
    label: account.name,
    description: `${account === fallback ? '(default) ' : ''}${shownPath(account.configDir)}`,
    account,
  }));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(gear) Configure accounts…', settings: true });
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Which Claude account should the session use?', matchOnDescription: true });
  if (pick?.settings) {
    await openSettings('devdesk.claude');
    return undefined;
  }
  return pick?.account;
}
