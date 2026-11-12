import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import { configDirOfTranscript } from './core/accounts';
import { fileList, ForkCopier, forkCut, forkName, forkResumeArgs, type RewindFile, rewindPlan, rewindWrites, worktreeFiles } from './core/forkTurn';
import { execGit } from './core/git';
import type { SessionCard } from './core/sessions';
import { cardView } from './core/sessionsView';
import { truncate } from './core/text';
import { isSessionId } from './core/tmux';
import { promptOf, type Turn, turnPaths } from './core/turnChanges';
import { sessionAccount } from './claudeAccounts';
import { sessionsClaudeCommand, sessionsDefaultMode, sessionsLaunchArgs, workspaceRoot } from './config';
import { log } from './log';
import { type PickButton, pickOne } from './pick';
import type { SessionsModel } from './sessionsModel';
import { forkSessionBase, type SessionRowSelector, startNumbered } from './sessionsCommands';
import { CHANGES_BUTTON, diskReader, openTurnChanges, pickTurn, promptLabel, sessionTurns, type TurnContentProvider } from './turnChanges';
import { newWorktreeKind, newWorktreeSession, noWorktreesReason, type WorktreeTaskStore } from './worktreeSessions';

/** What Fork from a Turn does with the files: see `CHOICES`. */
export type ForkChoice = 'keep' | 'rewind' | 'worktree';

export interface ForkDeps {
  model: SessionsModel;
  tree: SessionRowSelector;
  store: WorktreeTaskStore;
  turnContent: TurnContentProvider;
}

/** What a fork from a turn started, for the e2e tests. */
export interface ForkStarted {
  choice: ForkChoice;
  /** The new session's id, and the copy of the conversation it resumes. */
  sessionId: string;
  transcript: string;
  /** The turn the fork ends after, counted from the session's first. */
  turn: number;
  /** Files rewound (written or deleted), and files left as they are (changed since Claude wrote them, or unknown). */
  rewound: string[];
  kept: string[];
  /** The new worktree (`worktree` only). */
  worktree?: string;
}

/** Answers the rewind's confirmation in the e2e tests (they cannot answer a modal dialog); unset, the dialog shows. */
export const forkTestHooks: { confirm?: (message: string) => boolean } = {};

const REWIND_BUTTON = 'Rewind Files and Fork';

/** The card's title as Fork from a Turn names it. */
const titleOf = (card: SessionCard) => truncate(cardView(card, Date.now()).title, 60);

/**
 * Fork from a Turn: asks which turn (unless `index` is given), then what to do with the files, then starts a new Claude
 * session whose conversation ends after that turn, in the original session's Claude account and on its model, named
 * "forked from <title> at turn N". The original session and its transcript are left as they are (unless the files
 * are rewound, which the user confirms first).
 */
export async function forkFromTurn(deps: ForkDeps, card: SessionCard, known?: Turn[], index?: number, choiceArg?: ForkChoice): Promise<ForkStarted | undefined> {
  if (!isSessionId(card.sessionId) || !card.cwd || !card.transcriptPath) {
    void vscode.window.showInformationMessage('This session has no Claude status record or transcript yet, so it cannot be forked from a turn.');
    return undefined;
  }
  const turns = known ?? (await sessionTurns(card));
  if (!turns) return undefined;
  if (!turns.length) {
    void vscode.window.showInformationMessage('This session has no turns in its transcript yet.');
    return undefined;
  }
  let at = index;
  while (at === undefined) {
    const pick = await pickTurn(turns, { title: 'Fork from a Turn', placeHolder: 'Fork after which turn? The newest is first', button: CHANGES_BUTTON });
    if (!pick) return undefined;
    if (pick.button === CHANGES_BUTTON.id) await openTurnChanges(deps.turnContent, card, turns, pick.index);
    else at = pick.index;
  }
  const cut = forkCut(turns, at);
  if (!cut) {
    void vscode.window.showWarningMessage('The transcript does not say where the next turn starts (its prompt has no uuid), so DevDesk cannot fork from this turn.');
    return undefined;
  }
  const choice = choiceArg ?? (await pickChoice(card, turns[at], cut.last));
  if (!choice) return undefined;
  const ctx = { deps, card: card as SessionCard & { sessionId: string; cwd: string; transcriptPath: string }, turns, index: at, cut: cut.cut };
  if (choice === 'worktree') return forkIntoWorktree(ctx);
  let rewound: string[] = [];
  let kept: string[] = [];
  if (choice === 'rewind') {
    const done = await rewindInPlace(ctx);
    if (!done) return undefined;
    ({ rewound, kept } = done);
  }
  const copy = await copyConversation(ctx.card, ctx.cut);
  if (!copy) return undefined;
  const mode = sessionsDefaultMode();
  const args = forkResumeArgs(copy.sessionId, forkName(titleOf(card), copy.turn), copy.model, sessionsLaunchArgs(mode));
  await startNumbered(deps.model, deps.tree, await forkSessionBase(card.cwd), card.cwd, sessionsClaudeCommand(args, mode, sessionAccount(card)));
  return { choice, sessionId: copy.sessionId, transcript: copy.path, turn: copy.turn, rewound, kept };
}

type ChoiceItem = vscode.QuickPickItem & { choice: ForkChoice; buttons?: PickButton[] };

/** Asks what to do with the files: keep them, rewind them, or fork into a new worktree. */
async function pickChoice(card: SessionCard, turn: Turn, last: boolean): Promise<ForkChoice | undefined> {
  const root = workspaceRoot();
  const place = card.cwd ? basename(card.cwd) : 'the session’s folder';
  const items: ChoiceItem[] = [
    {
      choice: 'keep',
      label: '$(file) Keep Current Files',
      description: 'the files stay as they are now',
      detail: last
        ? 'The new session continues the whole conversation.'
        : 'Claude remembers the code as it was after that turn, not as it is now.',
    },
  ];
  if (!last)
    items.push({
      choice: 'rewind',
      label: '$(discard) Rewind Files Too',
      description: `put back what Claude changed after that turn, in ${place}`,
      detail: 'The original session works on these files too. You see the list first.',
    });
  if (root && !noWorktreesReason(root) && newWorktreeKind(root) === 'claude')
    items.push({
      choice: 'worktree',
      label: '$(git-branch) In a New Worktree',
      description: last ? 'a new worktree with the files as they are now' : 'a new worktree with the files as they were after that turn',
      detail: `Made from the HEAD of ${place}; the original session and its files stay as they are.`,
    });
  const picked = await pickOne(items, { title: `Fork from “${truncate(promptLabel(turn), 50)}”`, placeHolder: 'What should happen to the files?' });
  return picked?.item.choice;
}

interface ForkContext {
  deps: ForkDeps;
  card: SessionCard & { sessionId: string; cwd: string; transcriptPath: string };
  turns: Turn[];
  index: number;
  cut: string | undefined;
}

/** The files Claude changed in the turns read, with their text now, and the rewind plan to the chosen turn. */
async function planFor(ctx: ForkContext): Promise<{ plan: RewindFile[]; disk: (path: string) => string | undefined }> {
  const disk = await diskReader([...new Set(ctx.turns.flatMap((t) => turnPaths(t)))]);
  return { plan: rewindPlan(ctx.turns, ctx.index, disk), disk };
}

/** How a file is named in messages: relative to the session's folder when inside it. */
function shown(cwd: string, path: string): string {
  return isAbsolute(path) && path.startsWith(`${cwd}/`) ? relative(cwd, path) : path;
}

/** Rewind Files Too: shows what will change, asks, and writes. Undefined when cancelled. */
async function rewindInPlace(ctx: ForkContext): Promise<{ rewound: string[]; kept: string[] } | undefined> {
  const { plan } = await planFor(ctx);
  const writes = rewindWrites(plan);
  const kept = plan.filter((f) => f.action === 'changed' || f.action === 'unknown').map((f) => f.path);
  const name = (p: string) => shown(ctx.card.cwd, p);
  const keptLine = kept.length ? ` Left as they are (changed since Claude wrote them, or the transcript cannot tell): ${fileList(kept, name)}.` : '';
  if (!writes.length) {
    void vscode.window.showInformationMessage(`No file needs rewinding: they are as they were after that turn, or were changed since.${keptLine} Forking with the files as they are.`);
    return { rewound: [], kept };
  }
  const restore = writes.filter((f) => f.action === 'restore').map((f) => f.path);
  const remove = writes.filter((f) => f.action === 'delete').map((f) => f.path);
  const message =
    `Rewind ${writes.length === 1 ? '1 file' : `${writes.length} files`} in ${ctx.card.cwd} to how ${writes.length === 1 ? 'it was' : 'they were'} after that turn? ` +
    'The original session works on these files too, and sees the change.' +
    (restore.length ? ` Put back: ${fileList(restore, name)}.` : '') +
    (remove.length ? ` Delete (Claude created them later): ${fileList(remove, name)}.` : '') +
    keptLine;
  const ok = forkTestHooks.confirm ? forkTestHooks.confirm(message) : (await vscode.window.showWarningMessage(message, { modal: true }, REWIND_BUTTON)) === REWIND_BUTTON;
  if (!ok) return undefined;
  const rewound: string[] = [];
  for (const f of writes) {
    // Checked again: the file may have changed while the dialog was open.
    const now = await readFile(f.path, 'utf8').catch(() => undefined);
    if (now !== f.expected) {
      kept.push(f.path);
      continue;
    }
    try {
      if (f.action === 'delete') await unlink(f.path);
      else await writeFile(f.path, f.content!);
      rewound.push(f.path);
    } catch (err) {
      log.warn(`fork: cannot rewind ${f.path}: ${(err as Error).message}`);
      kept.push(f.path);
    }
  }
  log.info(`fork: rewound ${rewound.length} files in ${ctx.card.cwd}${kept.length ? `, left ${kept.length}` : ''}`);
  if (rewound.length < writes.length) void vscode.window.showWarningMessage(`Rewound ${rewound.length} of ${writes.length} files; the others changed meanwhile or could not be written (see the DevDesk log).`);
  return { rewound, kept };
}

/** In a New Worktree: a worktree from the session's HEAD, with Claude's files as they were after the turn, and the fork in it. */
async function forkIntoWorktree(ctx: ForkContext): Promise<ForkStarted | undefined> {
  const { card } = ctx;
  let top: string;
  let head: string;
  let repo: string;
  try {
    top = (await execGit(['rev-parse', '--show-toplevel'], card.cwd)).trim();
    head = (await execGit(['rev-parse', 'HEAD'], card.cwd)).trim();
    repo = dirname((await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], card.cwd)).trim());
  } catch (err) {
    void vscode.window.showErrorMessage(`Cannot fork into a new worktree: ${card.cwd} is not in a git repository with a commit (${(err as Error).message.split('\n')[0]}).`);
    return undefined;
  }
  const { plan, disk } = await planFor(ctx);
  const files = worktreeFiles(ctx.turns, plan, top, disk);
  const title = titleOf(card);
  let started: ForkStarted | undefined;
  const ok = await newWorktreeSession(ctx.deps.model, ctx.deps.tree, ctx.deps.store, `Fork of “${title}”`, {
    name: `fork ${title}`,
    account: sessionAccount(card),
    base: head,
    packageDir: repo,
    resume: async (dir) => {
      for (const f of files) {
        const target = join(dir, f.rel);
        if (f.content === null) await rm(target, { force: true });
        else {
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.content);
        }
      }
      const copy = await copyConversation(card, ctx.cut);
      if (!copy) return undefined;
      const kept = plan.filter((f) => f.action === 'changed' || f.action === 'unknown').map((f) => f.path);
      started = { choice: 'worktree', sessionId: copy.sessionId, transcript: copy.path, turn: copy.turn, rewound: files.filter((f) => f.rewound).map((f) => join(dir, f.rel)), kept, worktree: dir };
      if (kept.length) void vscode.window.showInformationMessage(`The new worktree has these files as they are now, not as they were after that turn (changed since Claude wrote them, or the transcript cannot tell): ${fileList(kept, (p) => shown(card.cwd, p))}.`);
      return forkResumeArgs(copy.sessionId, forkName(title, copy.turn), copy.model, sessionsLaunchArgs());
    },
  });
  return ok ? started : undefined;
}

/**
 * Writes the conversation up to `cut` (the next turn's prompt; the whole of it without one) as a new session beside the
 * original's transcript, and copies the original's file checkpoints for it. Undefined (after saying why) when it fails.
 */
async function copyConversation(card: { sessionId: string; transcriptPath: string }, cut: string | undefined): Promise<{ sessionId: string; path: string; turn: number; model?: string } | undefined> {
  const sessionId = randomUUID();
  const path = join(dirname(card.transcriptPath), `${sessionId}.jsonl`);
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const copied: string[] = [];
  const copier = new ForkCopier(card.sessionId, sessionId, cut, (l) => copied.push(l), (o) => promptOf(o) !== undefined);
  const flush = async () => {
    for (const l of copied.splice(0)) if (!out.write(`${l}\n`)) await once(out, 'drain');
  };
  try {
    const input = createReadStream(card.transcriptPath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const l of lines) {
      const more = copier.line(l);
      await flush();
      if (!more) break;
    }
    lines.close();
    input.destroy();
    copier.end();
    await flush();
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await rm(path, { force: true });
    void vscode.window.showErrorMessage(`Cannot copy the conversation to fork it: ${(err as Error).message}`);
    return undefined;
  }
  if (cut !== undefined && !copier.found) {
    await rm(path, { force: true });
    void vscode.window.showWarningMessage('That turn is no longer in the session’s transcript (was it compacted or rewound?), so DevDesk cannot fork from it.');
    return undefined;
  }
  // Claude Code's checkpoints of the files (`/rewind` in the fork restores from them), under the new session's id.
  const config = configDirOfTranscript(card.transcriptPath);
  const history = config && join(config, 'file-history', card.sessionId);
  if (history && existsSync(history)) await cp(history, join(config, 'file-history', sessionId), { recursive: true }).catch((err) => log.warn(`fork: cannot copy ${history}: ${(err as Error).message}`));
  log.info(`fork: copied ${copier.lines} lines (${copier.turns} turns) of ${card.transcriptPath} to ${path}`);
  return { sessionId, path, turn: copier.turns, model: copier.model };
}
