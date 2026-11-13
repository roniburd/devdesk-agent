import { accountEnv, accountOfTranscript } from '../accounts';
import { readPaneScreen, typeIntoPane } from '../paneScreen';
import { type ProgramStatus, programStatusBlocksArrow, screenWithProgramStatus } from '../programStatus';
import type { ProcessTable } from '../processes';
import { runningCopy, type SessionCard } from '../sessions';
import type { RegistryEntry } from '../sessionInfo';
import { claudeGone, sendBlocker } from '../sessionSend';
import { claudeLaunchCommand, tmuxStartCommand } from '../sessionStart';
import { promptArg } from '../shell';
import {
  attachArgs,
  DEFAULT_PASTE_SETTLE_MS,
  isSessionId,
  launchTags,
  nextSessionName,
  paneTarget,
  resumeArgs,
  sessionName,
  tmuxTargetGone,
  type TmuxRunner,
  typedLine,
} from '../tmux';
import { readTail } from '../transcriptTail';
import type { Feature } from '../worktrees';
import { ansiToSpans } from './ansi';
import { toWebCard, type WebView } from './cards';
import type { DaemonConfig } from './config';
import { keyArgs } from './keys';
import { DETAIL_MAX_TAIL_BYTES, DETAIL_TAIL_BYTES, DETAIL_TURNS, transcriptTurns } from './transcript';
import { launchArgs, webModels } from './composer';
import type {
  ErrorCode,
  ErrorResponse,
  NewSessionRequest,
  NewSessionResponse,
  OkResponse,
  ResumeResponse,
  ScreenState,
  SessionDetail,
  Turn,
  WebKey,
  WebModel,
} from './types';

/** What the web access routes do to a session: read it, type into it, press a key in it, or start a new one. */

export interface ActionDeps {
  tmux: (server: string) => TmuxRunner;
  listProcesses: () => Promise<ProcessTable | undefined>;
  /** os.tmpdir(), for scripted long commands. */
  tmpDir: string;
  /** How long Claude gets to take in a paste before Enter (`devdesk.board.pasteSettleMs`; DEFAULT_PASTE_SETTLE_MS). */
  settleMs?: number;
  /** Claude's own report for the card's pane (Program Status, `readCardProgramStatus`), when it runs under the relay. */
  programStatus?: (card: SessionCard) => Promise<ProgramStatus | undefined>;
}

/**
 * What the pane shows, with Claude's own report on top where there is one (`screenWithProgramStatus`), as the Claude
 * Board reads a session before typing into it: whether it works or a dialog is open.
 */
async function paneScreen(card: SessionCard, tmux: TmuxRunner, target: string, d: ActionDeps) {
  const read = await readPaneScreen(tmux, target, d.listProcesses);
  const status = await d.programStatus?.(card);
  const screen = screenWithProgramStatus(read.screen, status);
  return { ...read, screen: { ...read.screen, ...screen }, dialogOpen: !read.promptShown || programStatusBlocksArrow(status) };
}

export type ActionResult<T> = { status: 200 | 201; body: T } | { status: 400 | 404 | 409 | 410 | 413 | 502; body: ErrorResponse };

type ErrorStatus = 400 | 404 | 409 | 410 | 413 | 502;
const fail = (status: ErrorStatus, code: ErrorCode, error: string): { status: ErrorStatus; body: ErrorResponse } => ({ status, body: { error, code } });
const ended = () => fail(410, 'ended', 'The session has ended.');
const tmuxFailed = (err: unknown) => fail(502, 'tmux', `tmux failed: ${(err as Error).message}`);
const NO_SCREEN: ScreenState = { empty: false, dialog: false, working: false, inMode: false, exited: false };

/** The card's transcript turns, its pane's screen and what that shows. `o.server`: card.tmuxServer ?? cfg.tmux.server. */
/**
 * The detail's turns from the end of a transcript. Tool output (screenshots, file reads) can fill the first read, so while
 * it holds fewer than DETAIL_TURNS messages and the file goes on further back, it reads twice as far, up to
 * DETAIL_MAX_TAIL_BYTES.
 */
export async function detailTurns(path: string): Promise<Turn[]> {
  for (let bytes = DETAIL_TAIL_BYTES; ; bytes *= 2) {
    const tail = await readTail(path, bytes);
    if (!tail) return [];
    const turns = transcriptTurns(tail.lines);
    if (turns.filter((t) => t.kind !== 'tool').length >= DETAIL_TURNS || tail.bytes <= bytes || bytes >= DETAIL_MAX_TAIL_BYTES) return turns;
  }
}

export async function sessionDetail(card: SessionCard, o: WebView & { server: string }, d: ActionDeps): Promise<ActionResult<SessionDetail>> {
  const turns: Turn[] = card.transcriptPath ? await detailTurns(card.transcriptPath) : [];
  const detail: SessionDetail = { card: toWebCard(card, o), turns, screen: [], prompt: NO_SCREEN, ended: claudeGone(card), ...(card.featureDir ? { dir: card.featureDir } : {}) };
  const target = paneTarget(card);
  if (!target) return { status: 200, body: { ...detail, ended: true } };
  try {
    const { capture, screen, dialogOpen } = await paneScreen(card, d.tmux(o.server), target, d);
    detail.screen = ansiToSpans(capture);
    detail.prompt = { ...screen, dialog: dialogOpen && !screen.exited && !screen.inMode };
    detail.ended ||= screen.exited;
  } catch (err) {
    if (!tmuxTargetGone((err as Error).message)) return tmuxFailed(err);
    detail.ended = true;
  }
  return { status: 200, body: detail };
}

/** claudeGone / no pane -> 410; the pane's screen (with Claude's own report); exited -> 410; sendBlocker(card, '', screen, 'your reply') -> 409; typeIntoPane; tmuxTargetGone -> 410; other tmux error -> 502. */
export async function sendText(card: SessionCard, text: string, server: string, d: ActionDeps): Promise<ActionResult<OkResponse>> {
  const target = paneTarget(card);
  if (!target || claudeGone(card)) return ended();
  if (!typedLine(text)) return fail(400, 'bad-request', 'There is nothing to send.');
  const tmux = d.tmux(server);
  try {
    const { screen } = await paneScreen(card, tmux, target, d);
    if (screen.exited) return ended();
    const blocker = sendBlocker(card, '', screen, 'your reply');
    if (blocker) return fail(409, 'blocked', blocker);
    await typeIntoPane(tmux, target, text, { tmpDir: d.tmpDir, settleMs: d.settleMs ?? DEFAULT_PASTE_SETTLE_MS });
  } catch (err) {
    return tmuxTargetGone((err as Error).message) ? ended() : tmuxFailed(err);
  }
  return { status: 200, body: { ok: true } };
}

/** No pane / claudeGone -> 410; keyArgs; tmuxTargetGone -> 410. No sendBlocker: keys are for dialogs and Esc. */
export async function pressKey(card: SessionCard, key: WebKey, server: string, d: ActionDeps): Promise<ActionResult<OkResponse>> {
  const target = paneTarget(card);
  if (!target || claudeGone(card)) return ended();
  let args: string[];
  try {
    args = keyArgs(target, key);
  } catch (err) {
    return fail(400, 'bad-request', (err as Error).message);
  }
  try {
    await d.tmux(server)(args);
  } catch (err) {
    return tmuxTargetGone((err as Error).message) ? ended() : tmuxFailed(err);
  }
  return { status: 200, body: { ok: true } };
}

/** The feature `dir` is (its dir, or its realDir), if it is one of `features`. */
export function featureOf(dir: string, features: readonly Feature[]): Feature | undefined {
  return features.find((f) => f.dir === dir || (f.realDir !== undefined && f.realDir === dir));
}

/**
 * Starts Claude in a new detached tmux session in one of `features` (`req.dir` must be its dir, or its realDir: else
 * 400), named after the feature (`cc-main`, then `cc-main-2`, … past `existing`), on cfg.tmux.server, as the Claude
 * view starts one (`newSessionShell` in claudeSessions.ts): DevDesk's environment and the session's launch tags, its
 * tmux options, and Claude as `cfg.claude` says (`claudeLaunchCommand`: the Claude account, the Program Status relay)
 * in the mode, with the model and effort chosen (only what `models`, the model pill's rows, and the configured modes
 * offer: else 400); the prompt, when given, as Claude's first prompt.
 */
export async function startSession(
  req: NewSessionRequest,
  features: readonly Feature[],
  existing: readonly string[],
  cfg: Pick<DaemonConfig, 'tmux' | 'claude'>,
  d: ActionDeps,
  models: readonly WebModel[] = webModels(cfg.claude, undefined),
): Promise<ActionResult<NewSessionResponse>> {
  const feature = featureOf(req.dir, features);
  if (!feature) return fail(400, 'bad-request', 'Sessions can only start in one of the listed folders.');
  const launch = launchArgs(req, cfg.claude, models);
  if ('error' in launch) return fail(400, 'bad-request', launch.error);
  const name = nextSessionName(sessionName(feature), existing);
  const server = cfg.tmux.server;
  const shell = claudeLaunchCommand({ ...cfg.claude, modeArgs: launch.args }, req.prompt ? promptArg(req.prompt) : '');
  const env = { ...cfg.tmux.env, ...launchTags(name, server) };
  try {
    const run = tmuxStartCommand(shell, d.tmpDir);
    await d.tmux(server)(attachArgs(name, feature.dir, run, env, cfg.tmux.options, true));
  } catch (err) {
    return tmuxFailed(err);
  }
  return { status: 201, body: { tmuxSession: name, server: cfg.tmux.server } };
}

/** What resuming a parked session looks at: the cards as just read, Claude's registries, and the tmux session names. */
export interface ResumeContext {
  cards: readonly SessionCard[];
  registry: readonly RegistryEntry[];
  /** tmux session names on cfg.tmux.server. */
  existing: readonly string[];
  features: readonly Feature[];
  /** existsSync */
  exists: (dir: string) => boolean;
  /** processAlive */
  alive: (pid: number) => boolean;
}

/**
 * Resumes a parked session as the Claude view does when you open one (`resumeSession` in sessionsCommands.ts):
 * `claude --resume <id>` (same session id) in the Claude account its transcript is in, in its tmux pane when Claude
 * exited to a shell there, else in the DevDesk tmux session it had when still free, else in a new one named after its
 * worktree. A session that runs (here, or the conversation in a DevDesk tmux session) gives its id instead; one running
 * outside DevDesk's tmux sessions, or whose folder is gone, 409; an unknown conversation 400.
 */
export async function resumeSession(
  card: SessionCard,
  ctx: ResumeContext,
  cfg: Pick<DaemonConfig, 'tmux' | 'claude'>,
  d: ActionDeps,
): Promise<ActionResult<ResumeResponse>> {
  if (card.state !== 'parked') return { status: 200, body: { id: card.id } };
  const id = card.sessionId;
  const cwd = card.cwd;
  if (!isSessionId(id) || !cwd) return fail(400, 'bad-request', 'DevDesk does not know which conversation this session had, so it cannot resume it.');
  if (!ctx.exists(cwd)) return fail(409, 'blocked', `Cannot resume this Claude session: its folder ${cwd} is gone.`);
  const copy = runningCopy(ctx.cards, ctx.registry, id, ctx.alive);
  if (copy === 'elsewhere') {
    return fail(409, 'blocked', "This Claude conversation is already running outside DevDesk's tmux sessions, so DevDesk does not resume it again.");
  }
  if (copy) return { status: 200, body: { id: copy.id } };
  // Without the accounts (a config from an older extension, or a daemon started by hand), the default account's env:
  // telling Claude's own directory apart from another account's needs the ambient one.
  const ambient = cfg.claude.ambientConfigDir;
  const account = ambient ? accountOfTranscript(cfg.claude.accounts ?? [], card.transcriptPath, ambient) : undefined;
  const command = claudeLaunchCommand({ ...cfg.claude, ...(account ? { env: accountEnv(account) } : {}) }, resumeArgs(id));
  const run = tmuxStartCommand(command, d.tmpDir);
  if (card.tmuxSession && card.tmuxPane) {
    try {
      // The pane runs only the shell Claude exited to: run Claude there again, so a terminal open on it follows.
      await d.tmux(card.tmuxServer ?? cfg.tmux.server)(['respawn-pane', '-k', '-t', card.tmuxPane, '-c', cwd, run]);
      return { status: 201, body: { id } };
    } catch {
      // Gone meanwhile: a new tmux session below.
    }
  }
  const server = cfg.tmux.server;
  const former = card.formerTmuxSession;
  const feature = ctx.features.find((f) => f.dir === card.featureDir);
  const name =
    former?.startsWith('cc-') && card.formerTmuxServer === server && !ctx.existing.includes(former)
      ? former
      : nextSessionName(feature ? sessionName(feature) : 'cc-resumed', ctx.existing);
  try {
    await d.tmux(server)(attachArgs(name, cwd, run, { ...cfg.tmux.env, ...launchTags(name, server) }, cfg.tmux.options, true));
  } catch (err) {
    return tmuxFailed(err);
  }
  return { status: 201, body: { id } };
}
