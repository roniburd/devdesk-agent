import { basename } from 'node:path';
import * as vscode from 'vscode';
import { type ReviewNote, reviewPrompt } from './core/reviewNotes';
import type { SessionCard } from './core/sessions';
import { runningSessions, sendBlocker, sessionTitle } from './core/sessionSend';
import { promptArg } from './core/shell';
import { sessionName } from './core/tmux';
import type { Feature } from './core/worktrees';
import { BoardSessions } from './board/boardSessions';
import { sessionsClaudeCommand } from './config';
import { log, registerTimedCommand } from './log';
import type { SessionsModel } from './sessionsModel';
import { startNumbered } from './sessionsCommands';
import type { SessionsTree } from './sessionsTree';
import { onDidOpenDiff, worktreePath } from './worktreeDiffs';

/** `workspaceState` key of the notes not sent yet, so they outlive a window reload. */
const NOTES_KEY = 'devdesk.reviewNotes';

/** A note thread as saved: the file, its worktree, its lines (0-based, as VS Code ranges count) and its comments. */
interface SavedThread {
  uri: string;
  featureDir: string;
  start: number;
  end: number;
  texts: string[];
}

class Note implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  author = { name: 'You' };
  contextValue = 'devdesk.reviewNote';
  constructor(
    public body: string,
    readonly thread: vscode.CommentThread,
  ) {}
}

/**
 * Notes the user leaves on lines of a Worktrees view diff (VS Code's comments, on the working-tree side), sent to the
 * worktree's Claude session as one prompt (`Send Notes to Claude`), then cleared.
 */
export class ReviewComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('devdesk.review', 'Notes for Claude');
  /** Files a diff opened, and the worktree each is in, by URI: only they take notes. */
  private readonly targets = new Map<string, string>();
  private readonly threads = new Map<vscode.CommentThread, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly boardSessions: BoardSessions;

  constructor(
    private readonly state: vscode.Memento,
    private readonly sessions: SessionsModel,
    private readonly tree: SessionsTree,
  ) {
    this.boardSessions = new BoardSessions(sessions, tree);
    this.controller.options = { prompt: 'Note for Claude', placeHolder: 'What should Claude change here?' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (this.targets.has(doc.uri.toString()) ? [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)] : []),
    };
    this.subscriptions.push(
      this.controller,
      onDidOpenDiff(({ uri, feature }) => this.targets.set(uri.toString(), feature.dir)),
      registerTimedCommand('devdesk.review.addNote', (reply: vscode.CommentReply) => this.add(reply)),
      registerTimedCommand('devdesk.review.deleteNote', (note: Note) => this.deleteNote(note)),
      registerTimedCommand('devdesk.review.deleteThread', (thread: vscode.CommentThread) => this.deleteThread(thread)),
      registerTimedCommand('devdesk.review.sendThread', (thread: vscode.CommentThread) => this.send(this.threads.get(thread))),
      registerTimedCommand('devdesk.review.send', (node?: { feature?: Feature }) => this.send(node?.feature?.dir)),
      registerTimedCommand('devdesk.review.clear', (node?: { feature?: Feature }) => this.clear(node?.feature?.dir)),
    );
    this.restore();
  }

  /** Notes not sent yet, by worktree directory (the Worktrees view and the tests). */
  counts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [thread, dir] of this.threads) counts.set(dir, (counts.get(dir) ?? 0) + thread.comments.length);
    return counts;
  }

  /** Adds a note on `range` of `uri` in the worktree at `featureDir` (the tests; the user adds them in the diff). */
  addAt(uri: vscode.Uri, featureDir: string, range: vscode.Range, text: string): void {
    this.targets.set(uri.toString(), featureDir);
    const thread = this.controller.createCommentThread(uri, range, []);
    this.threads.set(thread, featureDir);
    this.append(thread, text);
  }

  private add(reply: vscode.CommentReply): void {
    const dir = this.threads.get(reply.thread) ?? this.targets.get(reply.thread.uri.toString());
    if (!dir || !reply.text.trim()) return;
    this.threads.set(reply.thread, dir);
    this.append(reply.thread, reply.text);
  }

  private append(thread: vscode.CommentThread, text: string): void {
    thread.comments = [...thread.comments, new Note(text, thread)];
    thread.label = 'Note for Claude';
    thread.contextValue = 'devdesk.reviewThread';
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    void this.save();
  }

  private deleteNote(note: Note): void {
    const thread = note.thread;
    thread.comments = thread.comments.filter((c) => c !== note);
    if (!thread.comments.length) this.deleteThread(thread);
    else void this.save();
  }

  private deleteThread(thread: vscode.CommentThread): void {
    this.threads.delete(thread);
    thread.dispose();
    void this.save();
  }

  private clear(dir: string | undefined): void {
    for (const [thread, d] of [...this.threads]) if (!dir || d === dir) this.deleteThread(thread);
  }

  private notesOf(dir: string, feature: Feature): { notes: ReviewNote[]; threads: vscode.CommentThread[] } {
    const threads = [...this.threads].filter(([, d]) => d === dir).map(([t]) => t);
    const notes = threads.flatMap((t) => {
      const range = t.range ?? new vscode.Range(0, 0, 0, 0);
      const text = t.comments.map((c) => (typeof c.body === 'string' ? c.body : c.body.value)).join('\n');
      return [{ path: worktreePath(feature, t.uri.fsPath), line: range.start.line + 1, endLine: range.end.line + 1, text }];
    });
    return { notes, threads };
  }

  /**
   * Sends the worktree's notes (picked when not given) to a session of it waiting at an empty prompt, as one prompt,
   * and clears them; with none waiting, starts a new session with them as its first prompt (after asking, when a
   * session there is busy). Returns where they went, or undefined.
   */
  async send(dir: string | undefined): Promise<string | undefined> {
    const counts = this.counts();
    if (!dir) {
      const dirs = [...counts.keys()];
      if (!dirs.length) {
        void vscode.window.showInformationMessage('No notes for Claude: add them on the lines of a diff in the Worktrees view.');
        return undefined;
      }
      dir =
        dirs.length === 1
          ? dirs[0]
          : (await vscode.window.showQuickPick(
              dirs.map((d) => ({ label: basename(d), description: `${counts.get(d)} notes · ${d}`, dir: d })),
              { title: 'Send the notes of which worktree to Claude?' },
            ))?.dir;
      if (!dir) return undefined;
    }
    const features = await this.sessions.loadFeatures();
    const feature = features.find((f) => f.dir === dir) ?? { name: basename(dir), dir, isMain: false, packages: [] };
    const { notes, threads } = this.notesOf(dir, feature);
    if (!notes.length) {
      void vscode.window.showInformationMessage(`No notes for Claude in ${feature.name}.`);
      return undefined;
    }
    const what = notes.length === 1 ? '1 note' : `${notes.length} notes`;
    return this.sendPrompt(feature, reviewPrompt(notes), what, (to) => this.sent(feature, threads, what, to));
  }

  /**
   * Sends `prompt` (`what` names it in messages: `2 notes`) to a session of `feature` waiting at an empty prompt (picked
   * when several are), typed in; with none waiting, starts a new session with it as its first prompt (after asking,
   * when a session there is busy). `onSent` is told where it went. Returns that, or undefined (not sent, or not yet).
   * Review notes and the checks to fix (`checks.ts`) both go this way.
   */
  async sendPrompt(feature: Feature, prompt: string, what: string, onSent?: (to: string) => void): Promise<string | undefined> {
    const running = runningSessions(await this.sessions.fresh()).filter((c) => c.featureDir === feature.dir);
    const idle: SessionCard[] = [];
    for (const card of running) {
      const screen = await this.boardSessions.promptScreen(card).catch(() => undefined);
      if (screen && !screen.exited && !sendBlocker(card, '', screen)) idle.push(card);
    }
    if (idle.length) {
      const picked = idle.length === 1 ? idle[0] : await this.boardSessions.pick({ title: `Send ${what} to`, cards: idle });
      if (!picked || typeof picked === 'string') return undefined;
      await this.boardSessions.typeInto(picked, prompt, { multiline: true });
      const sentTo = sessionTitle(picked);
      void vscode.window.showInformationMessage(`Sent ${what} to "${sentTo}".`, 'Open session').then((a) => a && this.boardSessions.open(picked));
      log.info(`sent ${what} on ${feature.name} to ${sentTo}`);
      onSent?.(sentTo);
      return sentTo;
    }
    if (running.length) {
      // Its sessions are busy: nothing is sent, and a new session takes it only when asked (the command returns now).
      void vscode.window
        .showInformationMessage(`No Claude session in ${feature.name} is at an empty prompt: send the ${what} when one is, or start a new session with them.`, 'Start session')
        .then((a) => a && this.startWith(feature, prompt, what, onSent));
      return undefined;
    }
    return this.startWith(feature, prompt, what, onSent);
  }

  /** Starts a session in the worktree with `prompt` as its first prompt. */
  private async startWith(feature: Feature, prompt: string, what: string, onSent?: (to: string) => void): Promise<string> {
    const session = await startNumbered(this.sessions, this.tree, sessionName(feature), feature.dir, sessionsClaudeCommand(promptArg(prompt)));
    log.info(`sent ${what} on ${feature.name} to a new session ${session}`);
    onSent?.(session);
    return session;
  }

  /** The notes went: they are cleared. */
  private sent(feature: Feature, threads: vscode.CommentThread[], what: string, to: string): void {
    log.debug(`clearing the ${what} sent on ${feature.name} to ${to}`);
    for (const t of threads) if (this.threads.has(t)) this.deleteThread(t);
  }

  private restore(): void {
    for (const s of this.state.get<SavedThread[]>(NOTES_KEY, [])) {
      try {
        const uri = vscode.Uri.parse(s.uri);
        this.targets.set(uri.toString(), s.featureDir);
        const thread = this.controller.createCommentThread(uri, new vscode.Range(s.start, 0, s.end, 0), []);
        this.threads.set(thread, s.featureDir);
        thread.comments = s.texts.map((t) => new Note(t, thread));
        thread.label = 'Note for Claude';
        thread.contextValue = 'devdesk.reviewThread';
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      } catch (err) {
        log.warn(`cannot restore a note for Claude: ${(err as Error).message}`);
      }
    }
  }

  private save(): Thenable<void> {
    const saved: SavedThread[] = [...this.threads].map(([t, featureDir]) => ({
      uri: t.uri.toString(),
      featureDir,
      start: t.range?.start.line ?? 0,
      end: t.range?.end.line ?? 0,
      texts: t.comments.map((c) => (typeof c.body === 'string' ? c.body : c.body.value)),
    }));
    return this.state.update(NOTES_KEY, saved);
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }
}
