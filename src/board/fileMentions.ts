import { isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';
import type { CommandRow } from '../core/commandMenu';
import { fileMention } from '../core/composer';

/** Not offered after `@`: dependencies and build output, and the worktrees inside main (each is its own copy). */
const FILE_EXCLUDE = '{**/{node_modules,.git,build,dist,out,.venv,__pycache__}/**,worktrees/**,.claude/worktrees/**}';
/** Files fetched before sorting by path length, so the shortest matches are among the ones shown. */
const FILE_CANDIDATES = 500;

/** The box's `@` completions: files under the session's directory; a newer query cancels the search in progress. */
export class FileMentions {
  private search: vscode.CancellationTokenSource | undefined;

  /** Up to `max` files under `base` matching `query` (any case), shortest paths first. */
  async complete(base: string, query: string, max: number): Promise<CommandRow[]> {
    // Glob syntax in what was typed would change the pattern: keep path characters only.
    // Globs match case-sensitively; Claude Code's own @ completion does not: each letter matches either case.
    const q = query.replace(/[^\w./-]/g, '').replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
    const pattern = q.includes('/') ? `${q}*` : `**/*${q}*`;
    this.search?.cancel();
    const search = (this.search = new vscode.CancellationTokenSource());
    try {
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(base), pattern), FILE_EXCLUDE, FILE_CANDIDATES, search.token);
      return files
        .map((f) => relative(base, f.fsPath))
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .slice(0, max)
        .map((rel) => {
          const slash = rel.lastIndexOf('/');
          return { label: rel.slice(slash + 1), insert: fileMention(rel), detail: slash > 0 ? rel.slice(0, slash) : '' };
        });
    } finally {
      search.dispose();
      if (this.search === search) this.search = undefined;
    }
  }
}

/** Asks for files to attach; their `@` mentions, relative to `base` when inside it. */
export async function attachFiles(base: string | undefined): Promise<string> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Attach',
    title: 'Attach Files to the Prompt',
    ...(base ? { defaultUri: vscode.Uri.file(base) } : {}),
  });
  return (picked ?? [])
    .map((u) => {
      const rel = base ? relative(base, u.fsPath) : '';
      const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : u.fsPath;
      return fileMention(path);
    })
    .join('');
}
