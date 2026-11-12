import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sessionLabel, terminalName } from './core/terminalNames';
import { endedDir, type EndedRecord, readEndedRecords } from './core/ended';
import { parkedIn } from './core/park';
import { RestoreHold } from './core/restoreHold';
import { processAlive, readHookRecords } from './core/sessions';
import { readRegistries } from './core/sessionInfo';
import { attachArgs, attachMessage, DEFAULT_SERVER, isPaneId, killSessionArgs, launchTags, listSessions, resumeArgs, serverArgs, sessionName, shellPrinting, tmuxInstalled } from './core/tmux';
import { tmuxStartCommand } from './core/sessionStart';
import type { Feature } from './core/worktrees';
import { log } from './log';
import { sessionAccount } from './claudeAccounts';
import { applySmoothScrollWhenUp } from './smoothScroll';
import { type OpenTerminal, ReattachTerminals, reattachKey, type RestoreOutcome } from './state/reattachTerminals';
import {
  claudeSessionsDirs,
  openSettings,
  sessionsClaudeCommand,
  sessionsRestoreTerminals,
  sessionsTabTitleLength,
  sessionsEnv,
  sessionsStateDir,
  sessionsTmux,
  sessionsTmuxInstallCommand,
  sessionsTmuxOptions,
  sessionsTmuxPath,
  sessionsTmuxServer,
  sessionsTmuxSetup,
} from './config';

/** Where Claude terminals' tabs get their titles: the sessions' cards. */
export interface TerminalTitles {
  /** The board title of tmux session `session` on `server`, if the Claude view lists it. */
  title(session: string, server: string): string | undefined;
  /** Resolves once the sessions are loaded: terminals reopened after a reload wait for it, for their titles. */
  loaded(): Promise<unknown>;
  /** Fires when titles may have changed. */
  readonly onDidChange: vscode.Event<unknown>;
}

let titles: TerminalTitles | undefined;

/** A Claude terminal's tmux session and that session's server. */
export interface TerminalSession {
  session: string;
  server: string;
}

/**
 * Every Claude terminal DevDesk opened in this window, with its tmux session. Their names follow the sessions' titles,
 * so this, not the name, says which terminal is whose. Never cleared: a closed terminal is still recognized.
 */
const claudeTerminals = new WeakMap<vscode.Terminal, TerminalSession>();

/** The tmux session `terminal` is attached to, when it is one of DevDesk's Claude terminals. */
export function claudeTerminalSession(terminal: vscode.Terminal | undefined): TerminalSession | undefined {
  return terminal && claudeTerminals.get(terminal);
}

/** `terminal` is one of DevDesk's Claude terminals. */
export const isClaudeTerminal = (terminal: vscode.Terminal | undefined): boolean => !!claudeTerminalSession(terminal);

/** The Claude terminal an editor tab shows (a running one first), if it shows one. Claude terminals' names are unique. */
export function claudeTerminalOfTab(tab: vscode.Tab | undefined): vscode.Terminal | undefined {
  if (!(tab?.input instanceof vscode.TabInputTerminal)) return undefined;
  const shown = vscode.window.terminals.filter((t) => claudeTerminals.has(t) && t.name === tab.label);
  return shown.find((t) => t.exitStatus === undefined) ?? shown[0];
}

/** The editor tab shows one of DevDesk's Claude terminals. */
export const isClaudeTerminalTab = (tab: vscode.Tab): boolean => !!claudeTerminalOfTab(tab);

/** The open terminals attached to tmux session `session` on `server`. */
function terminalsOf(session: string, server: string): vscode.Terminal[] {
  return vscode.window.terminals.filter((t) => {
    if (closedDead.has(t)) return false;
    const of = claudeTerminals.get(t);
    return of?.session === session && of.server === server;
  });
}

/** The tmux server a card's session runs on: DevDesk's when the card does not say. */
export function cardServer(card: { tmuxServer?: string }): string {
  return card.tmuxServer ?? sessionsTmuxServer();
}

/** The card of tmux session `session` on `server`, if any. */
export function findByTmux<C extends { tmuxSession?: string; tmuxServer?: string }>(cards: readonly C[], session: string, server: string): C | undefined {
  return cards.find((c) => c.tmuxSession === session && cardServer(c) === server);
}

/** A card's open Claude terminal whose tmux client still runs; undefined outside tmux. */
export function cardTerminal(card: { tmuxSession?: string; tmuxServer?: string }): vscode.Terminal | undefined {
  if (!card.tmuxSession) return undefined;
  return terminalsOf(card.tmuxSession, cardServer(card)).find((t) => t.exitStatus === undefined);
}

/** `cc-main-39` as its tab says it without a title: `main-39`. */
const labelOf = (session: string, server: string) => sessionLabel(session, server, sessionsTmuxServer(), DEFAULT_SERVER);

/** The name of tmux session `session`'s terminal: its title, short, unique among the other Claude terminals than `self`. */
function nameFor(session: string, server: string, self?: vscode.Terminal): string {
  const taken = new Set(vscode.window.terminals.filter((t) => t !== self && claudeTerminals.has(t)).map((t) => t.name));
  return terminalName(titles?.title(session, server), labelOf(session, server), sessionsTabTitleLength(), taken);
}

/** How long to wait for a terminal's process id before trusting it runs (a terminal still starting may not have one yet). */
const PROCESS_ID_WAIT_MS = 200;

/**
 * Whether `terminal`'s process still runs. VS Code can keep a terminal listed, with no exit status and no close event,
 * after its tab was moved to another editor group and closed (see e2e/terminalMove.test.ts): its process is gone, so showing it does
 * nothing. The pid is already known to VS Code once the terminal has started, so this costs one `kill(pid, 0)`.
 */
async function terminalRuns(terminal: vscode.Terminal): Promise<boolean> {
  if (terminal.exitStatus !== undefined) return false;
  let timer: NodeJS.Timeout | undefined;
  const pid = await Promise.race([
    Promise.resolve(terminal.processId).catch(() => undefined),
    new Promise<'wait'>((r) => (timer = setTimeout(() => r('wait'), PROCESS_ID_WAIT_MS))),
  ]);
  clearTimeout(timer);
  // Still starting, or no pid to check: as before, trust it.
  if (pid === 'wait' || pid === undefined) return true;
  return processAlive(pid);
}

/** Terminals closed for not running: VS Code may go on listing one, so they are not picked again. */
const closedDead = new WeakSet<vscode.Terminal>();

/** Closes a Claude terminal that no longer runs, and forgets it, so it is not reopened in the next window. */
function closeDead(terminal: vscode.Terminal): void {
  closedDead.add(terminal);
  terminal.dispose();
  void reattach?.closed(terminal, false);
}

/**
 * The open terminal attached to `session` on `server` whose tmux client is still running. The others (Claude's session
 * ended, the client was detached, or the tab was closed but VS Code kept the terminal) are closed, so the caller opens a
 * fresh one.
 */
async function liveTerminal(session: string, server: string): Promise<vscode.Terminal | undefined> {
  let live: vscode.Terminal | undefined;
  for (const t of terminalsOf(session, server)) {
    if (!live && (await terminalRuns(t))) live = t;
    else closeDead(t);
  }
  return live;
}

/** Shows the open terminal attached to `session` on `server`, if its tmux client is still running (see `liveTerminal`). */
async function revealExisting(session: string, server: string): Promise<vscode.Terminal | undefined> {
  const live = await liveTerminal(session, server);
  live?.show();
  return live;
}

/** A card's open Claude terminal whose tmux client still runs, checked as `liveTerminal` does; undefined outside tmux. */
export async function liveCardTerminal(card: { tmuxSession?: string; tmuxServer?: string }): Promise<vscode.Terminal | undefined> {
  if (!card.tmuxSession) return undefined;
  return liveTerminal(card.tmuxSession, cardServer(card));
}

/** The last name asked for each terminal being renamed, so polls don't ask again while VS Code renames it. */
const renaming = new WeakMap<vscode.Terminal, string>();

/**
 * Renames the Claude terminal in front to its session's current title. VS Code only renames the active terminal
 * (`workbench.action.terminal.renameWithArg`), so a tab whose title changed while behind follows when it comes to front.
 */
async function renameActive(): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  const of = claudeTerminalSession(terminal);
  if (!terminal || !of || terminal.exitStatus !== undefined) return;
  const name = nameFor(of.session, of.server, terminal);
  if (terminal.name === name || renaming.get(terminal) === name) return;
  renaming.set(terminal, name);
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
  } catch (err) {
    log.debug(`cannot rename terminal ${terminal.name}: ${(err as Error).message}`);
  } finally {
    if (renaming.get(terminal) === name) renaming.delete(terminal);
  }
}

/**
 * Claude terminals are editor tabs that use the whole editor area: in the editor group already showing one, else in
 * the active group (never beside: the sidebar is the navigation).
 */
function terminalLocation(): vscode.TerminalOptions['location'] {
  const group = vscode.window.tabGroups.all.find((g) =>
    g.tabs.some(isClaudeTerminalTab),
  );
  return { viewColumn: group?.viewColumn ?? vscode.ViewColumn.Active };
}

/** Opens a terminal running the tmux install command (setting `devdesk.sessions.tmuxInstallCommand`). */
export function installTmux(): void {
  const terminal = vscode.window.createTerminal({ name: 'Install tmux', iconPath: new vscode.ThemeIcon('cloud-download') });
  terminal.show();
  terminal.sendText(sessionsTmuxInstallCommand());
}

/** True when the configured tmux runs; otherwise offers to install it or to fix `devdesk.sessions.tmuxPath`. */
async function ensureTmux(): Promise<boolean> {
  const bin = sessionsTmuxPath();
  if (await tmuxInstalled(bin)) return true;
  const choice = await vscode.window.showErrorMessage(
    `DevDesk runs Claude sessions in tmux, but ${bin === 'tmux' ? 'tmux is not installed (or not on PATH)' : `${bin} cannot be run`}.`,
    'Install tmux',
    'Settings',
  );
  if (choice === 'Install tmux') installTmux();
  else if (choice === 'Settings') void openSettings('devdesk.sessions.tmux');
  return false;
}

/**
 * Shows the session's terminal, or opens one attached to (or creating) tmux session `session` on DevDesk's tmux
 * server, running `command` (the configured Claude command by default) in `dir` when it is created. `preserveFocus`
 * leaves the keyboard focus where it is.
 */
export async function startClaude(
  session: string,
  dir: string,
  command = sessionsClaudeCommand(),
  location = terminalLocation(),
  preserveFocus = false,
): Promise<void> {
  const server = sessionsTmuxServer();
  if ((await revealExisting(session, server)) || !(await ensureTmux())) return;
  const terminal = vscode.window.createTerminal({
    name: nameFor(session, server),
    ...newSessionShell(session, dir, command),
    cwd: dir,
    iconPath: new vscode.ThemeIcon('hubot'),
    location,
    isTransient: true,
  });
  remember(terminal, { session, server });
  terminal.show(preserveFocus);
  void applySmoothScrollWhenUp(session);
}

/** A detached start gives up waiting for its hidden terminal after this. */
const DETACHED_START_TIMEOUT_MS = 30_000;

/**
 * Creates tmux session `session` on DevDesk's tmux server running `command` in `dir`, in the background: no terminal
 * opens (the Claude Board's composer, set to stay on the board). Its card opens it later. tmux runs in a hidden VS Code
 * terminal, like every other start: a tmux server started here gets a terminal's environment (the IDE connection, the
 * `code` CLI, `terminal.integrated.env`), not the extension host's.
 */
export async function startClaudeDetached(session: string, dir: string, command = sessionsClaudeCommand()): Promise<void> {
  if (!(await ensureTmux())) return;
  const terminal = vscode.window.createTerminal({
    name: `${labelOf(session, sessionsTmuxServer())} (starting)`,
    ...newSessionShell(session, dir, command, true),
    cwd: dir,
    hideFromUser: true,
    isTransient: true,
  });
  // `new-session -d` returns at once: wait for it (a failed one leaves its terminal open, so watch its exit status).
  const started = Date.now();
  while (!terminal.exitStatus && Date.now() - started < DETACHED_START_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 100));
  const code = terminal.exitStatus?.code;
  terminal.dispose();
  if (code !== 0) throw new Error(`tmux could not start session ${session} (exit ${code ?? 'timeout'})`);
  void applySmoothScrollWhenUp(session);
}

/**
 * The tmux command line that attaches to (or, `detached`, only creates) `session` on DevDesk's tmux server, creating it
 * in `dir` running `command` with DevDesk's environment and tmux options.
 */
function newSessionShell(session: string, dir: string, command: string, detached = false): { shellPath: string; shellArgs: string[] } {
  const { bin = 'tmux', configFile } = sessionsTmuxSetup();
  const server = sessionsTmuxServer();
  const env = { ...sessionsEnv(bin), ...launchTags(session, server) };
  const args = attachArgs(session, dir, tmuxCommand(command), env, sessionsTmuxOptions(), detached);
  return { shellPath: bin, shellArgs: serverArgs(server, args, configFile) };
}

/**
 * `command` as tmux is given it: as is, or, when too long for tmux's command line (a long prompt), written to a script in
 * a private temporary directory that the session's shell runs and removes.
 */
function tmuxCommand(command: string): string {
  return tmuxStartCommand(command, tmpdir());
}

/**
 * Shows the session's terminal, or opens one attached to an existing tmux session on `server` (DevDesk's by default),
 * focused on `pane` if given. Returns the terminal. `preserveFocus` leaves the keyboard focus where it is.
 */
export async function attachSession(name: string, pane?: string, server = sessionsTmuxServer(), preserveFocus = false): Promise<vscode.Terminal> {
  const location = terminalLocation();
  // Make the pane current so the attached client (new or existing) shows the Claude session. tmux updates a client
  // already attached as it changes, so an open terminal shows at once; a new one waits, so it starts on the pane.
  const selected = isPaneId(pane) ? sessionsTmux(server)(['select-window', '-t', pane, ';', 'select-pane', '-t', pane]).catch(() => undefined) : undefined;
  const existing = await revealExisting(name, server);
  if (existing) return existing;
  await selected;
  // Opened again meanwhile (a second click): one terminal per session.
  const opened = await revealExisting(name, server);
  if (opened) return opened;
  // One that another open created while this one checked (checked already, or too new to have exited).
  const raced = terminalsOf(name, server).find((t) => t.exitStatus === undefined);
  if (raced) {
    raced.show(preserveFocus);
    return raced;
  }
  const { bin = 'tmux', configFile } = sessionsTmuxSetup(server);
  const terminal = vscode.window.createTerminal({
    name: nameFor(name, server),
    // Says at once what it is doing: tmux can take a moment to attach and draw the session.
    ...shellPrinting(attachMessage(name, titles?.title(name, server)), bin, serverArgs(server, ['attach-session', '-t', `=${name}`], configFile)),
    iconPath: new vscode.ThemeIcon('hubot'),
    location,
    isTransient: true,
  });
  remember(terminal, { session: name, server });
  terminal.show(preserveFocus);
  return terminal;
}

/** The Claude terminals to reattach in the next window (set in `registerTerminalRestore`). */
let reattach: ReattachTerminals<vscode.Terminal> | undefined;

function remember(terminal: vscode.Terminal, open: OpenTerminal): void {
  claudeTerminals.set(terminal, open);
  void reattach?.opened(terminal, open);
}

/**
 * Claude terminals are transient: VS Code does not bring them back after a reload or a Remote-SSH reconnect (when it
 * can't reach their old process it would bring each back as a plain shell). Instead DevDesk keeps the list of open ones
 * in `state` and, when it activates, attaches again to each whose tmux session is still running (setting
 * `devdesk.sessions.restoreTerminals`).
 */
export function registerTerminalRestore(state: vscode.Memento, source: TerminalTitles): vscode.Disposable[] {
  reattach = new ReattachTerminals(state);
  titles = source;
  if (sessionsRestoreTerminals()) void restoreTerminals(reattach.saved());
  const rename = () => void renameActive();
  return [
    // VS Code closes every terminal when the window closes or reloads: those stay on the list, for the next window.
    vscode.window.onDidCloseTerminal((t) => void reattach?.closed(t, t.exitStatus?.reason === vscode.TerminalExitReason.Shutdown)),
    vscode.window.onDidChangeActiveTerminal(rename),
    source.onDidChange(rename),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devdesk.sessions.tabTitleLength')) rename();
    }),
    {
      dispose: () => {
        titles = undefined;
        reattach = undefined;
      },
    },
  ];
}

/**
 * Sessions a window is reattaching (`restoreTerminals`), which parking leaves alone meanwhile: a restore holds them at
 * most 2 minutes, and 90 seconds after it, by which time their terminals show as attached in tmux.
 */
export const restoreHold = new RestoreHold({ maxMs: 120_000, graceMs: 90_000 });

/** A reopening waits at most this long for the sessions to load, for its tabs' titles. */
const RESTORE_TITLES_WAIT_MS = 5_000;

/**
 * Attaches a terminal to each of `saved` whose tmux session is still running, without taking the keyboard focus. One
 * DevDesk parked while no window showed it (its window was closed, or Remote-SSH disconnected) is resumed in the same
 * tmux session, so the terminals that were open come back with their conversations. Then forgets those whose session
 * is gone (one that failed to reopen stays, for the next window).
 */
export async function restoreTerminals(saved: OpenTerminal[]): Promise<void> {
  // Before any await: the first sessions refresh must not park these while they are detached (see `RestoreHold`).
  restoreHold.start(saved, Date.now());
  try {
    await reopenTerminals(saved);
  } finally {
    restoreHold.finish(Date.now());
  }
}

async function reopenTerminals(saved: OpenTerminal[]): Promise<void> {
  // VS Code renames only the terminal in front, and these open behind: they get their titles now or when shown.
  if (saved.length && titles) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([titles.loaded().catch(() => undefined), new Promise((r) => (timer = setTimeout(r, RESTORE_TITLES_WAIT_MS)))]);
    clearTimeout(timer);
  }
  const running = new Map<string, Set<string>>();
  let parked: { ended: EndedRecord[]; live: Set<string> } | undefined;
  const outcomes = new Map<string, RestoreOutcome>();
  for (const open of saved) {
    const { session, server } = open;
    try {
      if (!running.has(server)) running.set(server, new Set((await listSessions(sessionsTmux(server))).map((s) => s.name)));
      if (running.get(server)?.has(session)) {
        await attachSession(session, undefined, server, true);
        outcomes.set(reattachKey(open), 'attached');
        continue;
      }
      if (server !== sessionsTmuxServer()) {
        outcomes.set(reattachKey(open), 'gone');
        continue;
      }
      parked ??= await parkedSessions();
      const record = parkedIn(session, server, parked.ended, parked.live);
      if (!record || !existsSync(record.cwd)) {
        outcomes.set(reattachKey(open), 'gone');
        continue;
      }
      log.info(`restoring the terminal of parked Claude session ${record.sessionId}: resuming it in tmux session ${session}`);
      parked.live.add(record.sessionId);
      await startClaude(session, record.cwd, sessionsClaudeCommand(resumeArgs(record.sessionId), undefined, sessionAccount(record)), terminalLocation(), true);
      outcomes.set(reattachKey(open), 'attached');
    } catch (err) {
      // Kept for the next window: it may work there.
      log.warn(`could not reopen the terminal of tmux session ${session} on ${server}: ${(err as Error).message}`);
      outcomes.set(reattachKey(open), 'failed');
    }
  }
  await reattach?.restored(outcomes);
}

/** The sessions that ended (to resume parked ones), and the ids of those running now. */
async function parkedSessions(): Promise<{ ended: EndedRecord[]; live: Set<string> }> {
  const dir = sessionsStateDir();
  const [ended, records, registry] = await Promise.all([
    readEndedRecords(endedDir(dir)),
    readHookRecords(dir),
    readRegistries(claudeSessionsDirs()),
  ]);
  // Claude's own list of its processes also covers one another window resumed a moment ago, before its first hook.
  const running = [...records, ...registry].filter((r) => r.pid !== undefined && processAlive(r.pid));
  return { ended, live: new Set(running.map((r) => r.sessionId)) };
}

/**
 * Asks for confirmation, then ends the Claude session shown as `label` by killing its tmux session `name` on `server`
 * (DevDesk's by default). Returns true if ended.
 */
export async function killTmuxSession(name: string, server = sessionsTmuxServer(), label = name): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `End Claude session "${label}"?`,
    { modal: true, detail: `Claude stops whatever it's doing, and its terminal closes. (tmux session ${name})` },
    'End Session',
  );
  if (choice !== 'End Session') return false;
  try {
    await endTmuxSession(name, server);
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not end session ${label}: ${(err as Error).message}`);
    return false;
  }
}

/** Kills tmux session `name` on `server` (DevDesk's by default), without asking. */
export function endTmuxSession(name: string, server?: string): Promise<string> {
  return sessionsTmux(server)(killSessionArgs(name));
}

/** Asks, then ends the worktree's own Claude session (`cc-<feature>`). */
export function killClaude(feature: Feature): Promise<boolean> {
  return killTmuxSession(sessionName(feature), undefined, feature.name);
}
