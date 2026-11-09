import * as vscode from 'vscode';
import { execGit, showFile } from './core/git';

export const SCHEME = 'devdesk-git';

export interface GitSide {
  dir: string;
  ref: string;
  path: string;
}

/** Read-only document showing `path` at `ref` in repository `dir` (empty `ref` = empty document). */
export function toGitUri(side: GitSide): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${side.path}`, query: JSON.stringify(side) });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const side = JSON.parse(uri.query) as GitSide;
    return showFile(execGit, side.dir, side.ref, side.path);
  }
}
