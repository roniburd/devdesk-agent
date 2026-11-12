import { joinArgs } from '../modes';
import { readPaneScreen, readPromptScreen, SUBMIT_DELAY_MS, typeIntoPane } from '../paneScreen';
import type { ProcessTable } from '../processes';
import type { SessionCard } from '../sessions';
import { claudeGone, sendBlocker } from '../sessionSend';
import { tmuxStartCommand } from '../sessionStart';
import { promptArg } from '../shell';
import { attachArgs, claudeShellCommand, nextSessionName, paneTarget, sessionName, tmuxTargetGone, type TmuxRunner, typedLine } from '../tmux';
import { readTail } from '../transcriptTail';
import type { Feature } from '../worktrees';
import { ansiToSpans } from './ansi';
import { toWebCard, type WebView } from './cards';
import type { DaemonConfig } from './config';
import { keyArgs } from './keys';
import { DETAIL_MAX_TAIL_BYTES, DETAIL_TAIL_BYTES, DETAIL_TURNS, transcriptTurns } from './transcript';
import { launchArgs, webModels } from './composer';
import type { ErrorCode, ErrorResponse, NewSessionRequest, NewSessionResponse, OkResponse, ScreenState, SessionDetail, Turn, WebKey, WebModel } from './types';

/** What the web access routes do to a session: read it, type into it, press a key in it, or start a new one. */

export interface ActionDeps {
  tmux: (server: string) => TmuxRunner;
  listProcesses: () => Promise<ProcessTable | undefined>;
  /** os.tmpdir(), for scripted long commands. */
  tmpDir: string;
  /** SUBMIT_DELAY_MS (150) */
  submitDelayMs?: number;
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
  const detail: SessionDetail = { card: toWebCard(card, o), turns, screen: [], prompt: NO_SCREEN, ended: claudeGone(card) };
  const target = paneTarget(card);
  if (!target) return { status: 200, body: { ...detail, ended: true } };
  try {
    const { capture, screen, promptShown } = await readPaneScreen(d.tmux(o.server), target, d.listProcesses);
    detail.screen = ansiToSpans(capture);
    detail.prompt = { ...screen, dialog: !promptShown && !screen.exited && !screen.inMode };
    detail.ended ||= screen.exited;
  } catch (err) {
    if (!tmuxTargetGone((err as Error).message)) return tmuxFailed(err);
    detail.ended = true;
  }
  return { status: 200, body: detail };
}

/** claudeGone / no pane -> 410; readPromptScreen; exited -> 410; sendBlocker(card, '', screen, 'your reply') -> 409; typeIntoPane; tmuxTargetGone -> 410; other tmux error -> 502. */
export async function sendText(card: SessionCard, text: string, server: string, d: ActionDeps): Promise<ActionResult<OkResponse>> {
  const target = paneTarget(card);
  if (!target || claudeGone(card)) return ended();
  if (!typedLine(text)) return fail(400, 'bad-request', 'There is nothing to send.');
  const tmux = d.tmux(server);
  try {
    const screen = await readPromptScreen(tmux, target, d.listProcesses);
    if (screen.exited) return ended();
    const blocker = sendBlocker(card, '', screen, 'your reply');
    if (blocker) return fail(409, 'blocked', blocker);
    await typeIntoPane(tmux, target, text, d.submitDelayMs ?? SUBMIT_DELAY_MS);
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
 * 400), named after the feature (`cc-main`, then `cc-main-2`, … past `existing`), on cfg.tmux.server, with DevDesk's
 * environment and tmux options; the mode, model and effort chosen (only what `models`, the model pill's rows, and the
 * configured modes offer: else 400); the prompt, when given, as Claude's first prompt.
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
  const { command, path, args } = cfg.claude;
  const shell = claudeShellCommand({ command, path, args }, joinArgs(launch.args, req.prompt ? promptArg(req.prompt) : ''));
  try {
    const run = tmuxStartCommand(shell, d.tmpDir);
    await d.tmux(cfg.tmux.server)(attachArgs(name, feature.dir, run, cfg.tmux.env, cfg.tmux.options, true));
  } catch (err) {
    return tmuxFailed(err);
  }
  return { status: 201, body: { tmuxSession: name, server: cfg.tmux.server } };
}
