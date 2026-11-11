import { randomBytes } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { writeFileAtomic } from './core/atomicWrite';
import {
  CLI_SCRIPT,
  cliPaths,
  cliWrapper,
  type CliRequest,
  isOurSkill,
  isRequestId,
  noteFileName,
  notesDirIn,
  noteText,
  parseCliRequest,
  SKILL_NAME,
  skillText,
  type WindowRecord,
  windowPanes,
} from './core/devdeskCli';
import type { DiffMode } from './core/git';
import { featureForCwd, processAlive } from './core/sessions';
import { featureDirs } from './core/worktrees';
import { ambientClaudeConfigDir, claudeAccounts, cliEnabled, sessionsStateDir, workspaceRoot } from './config';
import { log, registerTimedCommand } from './log';
import type { SessionsModel } from './sessionsModel';
import { changedFiles, openChanges, openDiff } from './worktreeDiffs';

/** What the window answers the command: printed by it (`ok` false: on stderr, exit status 1). */
export interface CliAnswer {
  ok: boolean;
  message: string;
}

/** Requests over this size are refused unread. */
const MAX_REQUEST_BYTES = 64 * 1024;
/** How often the request directory is listed too, in case a file-system event is missed. */
const POLL_MS = 2000;

const ownedByMe = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();

async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Writes `text` to `path` unless it holds it already (mode 0755); true when it wrote. */
async function writeIfChanged(path: string, text: string, mode: number): Promise<boolean> {
  const current = await readFile(path, 'utf8').catch(() => undefined);
  if (current === text) return false;
  await writeFileAtomic(path, text, true, mode);
  await chmod(path, mode);
  return true;
}

/**
 * This window's end of the `devdesk` command (see `core/devdeskCli.ts`): the command and its script in Claude's
 * config directory, this window's record (its folders, its sessions' panes, when it was in front), and the requests
 * addressed to it. Runs while `devdesk.cli.enabled` is on.
 */
export class CliBridge implements vscode.Disposable {
  private readonly id = randomBytes(8).toString('hex');
  private readonly token = randomBytes(24).toString('hex');
  private focusedAt = vscode.window.state.focused ? Date.now() : 0;
  private watcher: FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private paths: ReturnType<typeof cliPaths> | undefined;
  private written = '';
  private readonly taking = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Requests handled so far (the e2e tests wait on it). */
  handled = 0;
  /** Takes `devdesk worker` requests (set once it exists). */
  workers: { handle(req: CliRequest): Promise<CliAnswer> } | undefined;
  /** Takes `devdesk ticket` requests (set once it exists). */
  tickets: { handleCli(req: CliRequest): Promise<CliAnswer> } | undefined;

  constructor(
    private readonly sessions: SessionsModel,
    private readonly mode: () => DiffMode,
  ) {
    this.subscriptions.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (!s.focused) return;
        this.focusedAt = Date.now();
        void this.writeRecord();
      }),
      sessions.onDidChange(() => void this.writeRecord()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.writeRecord()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devdesk.cli')) void this.update();
      }),
    );
    void this.update();
  }

  private updating: Promise<void> = Promise.resolve();

  /** Starts or stops taking requests, as `devdesk.cli.enabled` says (one change at a time). */
  private update(): Promise<void> {
    this.updating = this.updating.then(() =>
      cliEnabled() ? this.start().catch((err: Error) => log.warn(`devdesk command: cannot start: ${err.message}`)) : this.stop(),
    );
    return this.updating;
  }

  /** The `devdesk` command's path. */
  get command(): string {
    return cliPaths(ambientClaudeConfigDir()).command;
  }

  private async start(): Promise<void> {
    if (this.paths) return;
    const paths = cliPaths(ambientClaudeConfigDir());
    await mkdir(dirname(paths.script), { recursive: true });
    const wroteScript = await writeIfChanged(paths.script, CLI_SCRIPT, 0o755);
    const wroteCommand = await writeIfChanged(paths.command, cliWrapper('python3'), 0o755);
    if (wroteScript || wroteCommand) log.info(`wrote the devdesk command: ${paths.command}`);
    for (const dir of [paths.ipc, paths.windows, dirname(paths.requests(this.id)), paths.requests(this.id), paths.responses]) await privateDir(dir);
    await this.pruneWindows(paths);
    this.paths = paths;
    this.written = '';
    await this.writeRecord();
    try {
      this.watcher = watch(paths.requests(this.id), () => void this.takeAll());
      this.watcher.on('error', () => undefined);
    } catch (err) {
      log.warn(`devdesk command: cannot watch ${paths.requests(this.id)}: ${(err as Error).message}`);
    }
    this.poll = setInterval(() => void this.takeAll(), POLL_MS);
    void this.takeAll();
  }

  private async stop(): Promise<void> {
    const paths = this.paths;
    this.paths = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    if (!paths) return;
    await rm(join(paths.windows, `${this.id}.json`), { force: true }).catch(() => undefined);
    await rm(paths.requests(this.id), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Removes the records (and request directories) of windows whose extension host has exited. */
  private async pruneWindows(paths: ReturnType<typeof cliPaths>): Promise<void> {
    for (const name of await readdir(paths.windows).catch(() => [] as string[])) {
      const m = /^([0-9a-f]{16})\.json$/.exec(name);
      if (!m) continue;
      const pid = Number((await readFile(join(paths.windows, name), 'utf8').catch(() => '')).match(/"pid":\s*(\d+)/)?.[1]);
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) continue;
      await rm(join(paths.windows, name), { force: true }).catch(() => undefined);
      await rm(paths.requests(m[1]), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** This window's record, rewritten when what it says changed. */
  private async writeRecord(): Promise<void> {
    const paths = this.paths;
    if (!paths) return;
    const root = workspaceRoot();
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const roots = [...new Set([...(root ? [root] : []), ...folders, ...this.sessions.featureList.flatMap(featureDirs)])].sort();
    const record: WindowRecord = { id: this.id, pid: process.pid, token: this.token, roots, panes: windowPanes(this.sessions.current), focusedAt: this.focusedAt };
    const text = JSON.stringify(record);
    if (text === this.written) return;
    this.written = text;
    try {
      await writeFileAtomic(join(paths.windows, `${this.id}.json`), text, true, 0o600);
    } catch (err) {
      log.warn(`devdesk command: cannot write this window's record: ${(err as Error).message}`);
    }
  }

  private async takeAll(): Promise<void> {
    const paths = this.paths;
    if (!paths) return;
    const dir = paths.requests(this.id);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const id = /^([A-Za-z0-9_-]+)\.json$/.exec(name)?.[1];
      if (!id || !isRequestId(id) || this.taking.has(id)) continue;
      this.taking.add(id);
      void this.take(paths, join(dir, name), id).finally(() => this.taking.delete(id));
    }
  }

  /** Takes the request (renaming it, so it is handled once), does it and answers. */
  private async take(paths: ReturnType<typeof cliPaths>, file: string, id: string): Promise<void> {
    const taken = `${file}.taken`;
    try {
      await rename(file, taken);
    } catch {
      return;
    }
    let answer: CliAnswer;
    try {
      const st = await lstat(taken);
      if (!st.isFile() || !ownedByMe(st.uid) || st.size > MAX_REQUEST_BYTES) answer = { ok: false, message: 'request refused' };
      else {
        const req = parseCliRequest(await readFile(taken, 'utf8'), this.token);
        answer = 'error' in req ? { ok: false, message: req.error } : await this.handle(req);
      }
    } catch (err) {
      answer = { ok: false, message: (err as Error).message };
    } finally {
      await unlink(taken).catch(() => undefined);
    }
    this.handled++;
    log.info(`devdesk command: ${answer.ok ? '' : 'refused: '}${answer.message}`);
    await writeFileAtomic(join(paths.responses, `${id}.json`), JSON.stringify(answer), true, 0o600).catch((err: Error) =>
      log.warn(`devdesk command: cannot answer: ${err.message}`),
    );
  }

  /** Does what the request asks. */
  async handle(req: CliRequest): Promise<CliAnswer> {
    switch (req.action) {
      case 'open':
        return openFile(req);
      case 'diff':
        return this.diff(req);
      case 'note':
        return this.note(req);
      case 'worker':
        return this.workers ? this.workers.handle(req) : { ok: false, message: 'this VS Code window does not run workers' };
      case 'ticket':
        return this.tickets ? this.tickets.handleCli(req) : { ok: false, message: 'this VS Code window does not link tickets' };
    }
  }

  private async diff(req: CliRequest): Promise<CliAnswer> {
    const where = req.path ?? req.cwd;
    const feature = featureForCwd(await this.sessions.loadFeatures(), where);
    if (!feature) return { ok: false, message: `${where} is in no worktree of this VS Code window` };
    const files = await changedFiles(feature, this.mode(), req.path);
    if (!files.length) return { ok: true, message: req.path ? `${req.path} has no changes in ${feature.name}` : `${feature.name} has no changes` };
    if (req.path) {
      await openDiff(files[0], !req.focus);
      return { ok: true, message: `Opened the diff of ${req.path} (${files[0].base.label} ↔ working tree) in VS Code.` };
    }
    await openChanges(feature, files);
    return { ok: true, message: `Opened the diffs of ${files.length} changed file${files.length === 1 ? '' : 's'} of ${feature.name} in VS Code.` };
  }

  private async note(req: CliRequest): Promise<CliAnswer> {
    const name = noteFileName(req.server, req.pane);
    if (!name) return { ok: false, message: 'devdesk note works only in a tmux session' };
    const file = join(notesDirIn(sessionsStateDir()), name);
    const text = noteText(req.text ?? '');
    if (!text) await rm(file, { force: true });
    else await writeFileAtomic(file, JSON.stringify({ text, at: Date.now() }), true);
    void this.sessions.refresh();
    return { ok: true, message: text ? `Set the note on this session's card: ${text}` : "Cleared this session's note." };
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.updating = this.updating.then(() => this.stop());
  }
}

async function openFile(req: CliRequest): Promise<CliAnswer> {
  const path = req.path!;
  const st = await stat(path).catch(() => undefined);
  if (!st?.isFile()) return { ok: false, message: `no file ${path}` };
  const pos = req.line ? new vscode.Position(req.line - 1, (req.column ?? 1) - 1) : undefined;
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), {
    preserveFocus: !req.focus,
    preview: true,
    ...(pos ? { selection: new vscode.Range(pos, pos) } : {}),
  });
  if (pos) editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return { ok: true, message: `Opened ${path}${req.line ? `:${req.line}${req.column ? `:${req.column}` : ''}` : ''} in VS Code.` };
}

/**
 * The skill files that tell Claude about the command: `skills/devdesk/SKILL.md` in each Claude account's config
 * directory (`devdesk.claude.accounts`; Claude's own when none is listed), so sessions in every account know it.
 */
const skillFiles = (): string[] => [...new Set(claudeAccounts().map((a) => join(a.configDir, 'skills', SKILL_NAME, 'SKILL.md')))];

/** Rewrites DevDesk's skill files that are there when this version's text differs (the command's path, its options); the ones rewritten. */
export async function refreshSkill(command: string): Promise<string[]> {
  const text = skillText(command);
  const changed: string[] = [];
  for (const file of skillFiles()) {
    const current = await readFile(file, 'utf8').catch(() => undefined);
    if (current === undefined || !isOurSkill(current) || current === text) continue;
    await writeFile(file, text);
    changed.push(file);
  }
  return changed;
}

/** The commands that add DevDesk's skill to Claude Code (opt-in), and remove it. */
export function registerCliCommands(bridge: CliBridge): vscode.Disposable[] {
  void refreshSkill(bridge.command).then(
    (changed) => changed.length && log.info(`updated the devdesk skill: ${changed.join(', ')}`),
    (err: Error) => log.warn(`cannot update the devdesk skill: ${err.message}`),
  );
  return [
    registerTimedCommand('devdesk.cli.installSkill', async () => {
      const written: string[] = [];
      for (const file of skillFiles()) {
        const current = await readFile(file, 'utf8').catch(() => undefined);
        if (current !== undefined && !isOurSkill(current)) {
          void vscode.window.showWarningMessage(`${file} is not DevDesk's: remove it first, or keep it.`);
          continue;
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, skillText(bridge.command));
        log.info(`wrote the devdesk skill: ${file}`);
        written.push(file);
      }
      if (!written.length) return false;
      void vscode.window.showInformationMessage(`Claude sessions started from now on know the devdesk command (${written.join(', ')}).`);
      return true;
    }),
    registerTimedCommand('devdesk.cli.removeSkill', async () => {
      const removed: string[] = [];
      for (const file of skillFiles()) {
        const current = await readFile(file, 'utf8').catch(() => undefined);
        if (current === undefined || !isOurSkill(current)) continue;
        await unlink(file);
        await rmdir(dirname(file)).catch(() => undefined);
        log.info(`removed the devdesk skill: ${file}`);
        removed.push(file);
      }
      if (!removed.length) {
        void vscode.window.showInformationMessage('The devdesk skill is not installed.');
        return false;
      }
      void vscode.window.showInformationMessage('Removed the devdesk skill: new Claude sessions no longer know the devdesk command.');
      return true;
    }),
  ];
}
