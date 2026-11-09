import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';
import type { SessionCard } from './core/sessions';
import { timeAgo } from './core/sessionsView';
import { truncate } from './core/text';
import { type Turn, type TurnFile, turnFiles, turnPaths } from './core/turnChanges';
import { readRecentTurns } from './core/turnChangesRead';
import { sessionsTurnChangesLimits } from './config';
import { log } from './log';

/** Documents holding a file's text before or after a turn, as Show Changes by Turn computed it. */
export const TURN_SCHEME = 'devdesk-turn';

/** Snapshots kept for the documents of the diffs opened last; older diffs show a note instead. */
const KEPT_SNAPSHOTS = 10;
/** Files larger than this are not read from disk to rebuild a turn's changes. */
const MAX_DISK_FILE = 32 * 1024 * 1024;

export class TurnContentProvider implements vscode.TextDocumentContentProvider {
  private readonly snapshots = new Map<number, TurnFile[]>();
  private next = 1;

  /** Keeps a turn's files; returns the key their documents name. */
  add(files: TurnFile[]): number {
    const key = this.next++;
    this.snapshots.set(key, files);
    for (const old of this.snapshots.keys()) if (this.snapshots.size > KEPT_SNAPSHOTS) this.snapshots.delete(old);
    return key;
  }

  uri(key: number, index: number, side: 'before' | 'after'): vscode.Uri {
    const file = this.snapshots.get(key)?.[index];
    return vscode.Uri.from({ scheme: TURN_SCHEME, path: file?.path ?? '/unknown', query: `${key}/${index}/${side}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [key, index, side] = uri.query.split('/');
    const file = this.snapshots.get(Number(key))?.[Number(index)];
    if (!file) return '(This diff is no longer kept. Show the turn’s changes again.)';
    return side === 'before' ? file.before : file.after;
  }
}

/** What a turn-changes command opened, for the e2e tests. */
export interface TurnChangesShown {
  prompt: string;
  files: { path: string; source: TurnFile['source']; before: string; after: string; note?: string }[];
}

async function diskReader(paths: readonly string[]): Promise<(path: string) => string | undefined> {
  const texts = new Map<string, string>();
  await Promise.all(
    paths.map(async (p) => {
      if (!isAbsolute(p)) return;
      try {
        if ((await stat(p)).size > MAX_DISK_FILE) return;
        texts.set(p, await readFile(p, 'utf8'));
      } catch {
        // Gone or unreadable: the turn's own record of the file is all there is.
      }
    }),
  );
  return (p) => texts.get(p);
}

/** The session's recent turns, oldest first; undefined (after saying why) when they cannot be read. */
async function sessionTurns(card: SessionCard): Promise<Turn[] | undefined> {
  if (!card.transcriptPath) {
    void vscode.window.showInformationMessage('DevDesk does not know where this session’s transcript is yet, so it cannot show what Claude changed.');
    return undefined;
  }
  const started = Date.now();
  const turns = await readRecentTurns(card.transcriptPath, sessionsTurnChangesLimits());
  log.debug(`turn changes: read ${turns?.length ?? 0} turns of ${card.transcriptPath} in ${Date.now() - started}ms`);
  if (!turns) void vscode.window.showWarningMessage(`Cannot read this session’s transcript: ${card.transcriptPath}`);
  return turns;
}

const promptLabel = (turn: Turn) => (turn.prompt ? truncate(turn.prompt, 80) : '(a turn that started earlier)');
const fileCount = (n: number) => (n === 0 ? 'no file changes' : n === 1 ? '1 file' : `${n} files`);

/** Opens what Claude changed in the session's last turn; when it changed nothing, offers the turn picker. */
export async function showLastTurnChanges(provider: TurnContentProvider, card: SessionCard): Promise<TurnChangesShown | undefined> {
  const turns = await sessionTurns(card);
  if (!turns) return undefined;
  const last = turns.length - 1;
  if (last < 0 || turnPaths(turns[last]).length === 0) {
    const pick = await vscode.window.showInformationMessage(
      last < 0 ? 'This session has no turns in its transcript yet.' : 'Claude’s last turn in this session changed no files.',
      'Pick a Turn…',
    );
    return pick ? showTurnChanges(provider, card, turns) : undefined;
  }
  return openTurn(provider, card, turns, last);
}

type TurnItem = vscode.QuickPickItem & { index: number };

/** Asks which recent turn (newest first, the last one preselected), then opens what Claude changed in it. */
export async function showTurnChanges(provider: TurnContentProvider, card: SessionCard, known?: Turn[]): Promise<TurnChangesShown | undefined> {
  const turns = known ?? (await sessionTurns(card));
  if (!turns) return undefined;
  if (!turns.length) {
    void vscode.window.showInformationMessage('This session has no turns in its transcript yet.');
    return undefined;
  }
  const now = Date.now();
  const items: TurnItem[] = turns
    .map((turn, index) => {
      const paths = turnPaths(turn);
      const shown = paths.slice(0, 5).map((p) => basename(p));
      return {
        index,
        label: promptLabel(turn),
        description: [fileCount(paths.length), timeAgo(turn.at, now), turn.partial ? 'partly read' : ''].filter(Boolean).join(' · '),
        detail: shown.length ? shown.join(', ') + (paths.length > shown.length ? `, +${paths.length - shown.length} more` : '') : undefined,
      };
    })
    .reverse();
  const pick = await vscode.window.showQuickPick(items, { title: 'Show Changes by Turn', placeHolder: 'Which turn? The newest is first', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return undefined;
  if (turnPaths(turns[pick.index]).length === 0) {
    void vscode.window.showInformationMessage('Claude changed no files in that turn.');
    return undefined;
  }
  return openTurn(provider, card, turns, pick.index);
}

async function openTurn(provider: TurnContentProvider, card: SessionCard, turns: Turn[], index: number): Promise<TurnChangesShown> {
  const turn = turns[index];
  const paths = [...new Set(turns.slice(index).flatMap((t) => turnPaths(t)))];
  const files = turnFiles(turns, index, await diskReader(paths));
  const key = provider.add(files);
  const title = `Changes in turn: ${truncate(turn.prompt || 'earlier turn', 50)}`;
  const label = (path: string) => (card.cwd && isAbsolute(path) && path.startsWith(`${card.cwd}/`) ? relative(card.cwd, path) : path);
  if (files.length === 1) {
    const f = files[0];
    const note = f.note ? ` (${f.note})` : '';
    await vscode.commands.executeCommand('vscode.diff', provider.uri(key, 0, 'before'), provider.uri(key, 0, 'after'), `${label(f.path)}: ${title}${note}`, { preview: true });
  } else {
    const resources = files.map((f, i) => [vscode.Uri.file(f.path), provider.uri(key, i, 'before'), provider.uri(key, i, 'after')] as const);
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }
  const approximate = files.filter((f) => f.source !== 'transcript');
  if (approximate.length) {
    const lines = approximate.map((f) => `${basename(f.path)}: ${f.note}`);
    void vscode.window.showInformationMessage(
      `${approximate.length === 1 ? 'One file is' : `${approximate.length} files are`} shown approximately. ${truncate(lines.join('; '), 300)}`,
    );
  }
  if (turn.partial) void vscode.window.showInformationMessage('Only part of this turn was read (it started before the part of the transcript DevDesk reads, or a line was too long), so it may miss changes.');
  return { prompt: turn.prompt, files: files.map((f) => ({ path: f.path, source: f.source, before: f.before, after: f.after, note: f.note })) };
}
