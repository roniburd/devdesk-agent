import { typedCommand } from '../../core/builtins';
import type { SessionCard } from '../../core/sessions';
import { claudeGone, missingArgument, NEW_SESSION, type PromptScreen, sendBlocker, sessionTitle } from '../../core/sessionSend';
import { truncate } from '../../core/sessionsView';
import { tmuxTargetGone, typedLine } from '../../core/tmux';
import { keepText } from '../outcomes';
import type { Handler, NoticeAction, SubmitContext, SubmitOutcome } from '../types';

/** Commands after which the CLI lists other skills or plugin commands. */
const RELOADS: ReadonlySet<string> = new Set(['reload-skills', 'reload-plugins']);

/** The command line as the pick title and the Sent notice show it: on one line, cut short (all of it is typed). */
const shownLine = (text: string) => truncate(typedLine(text), 80);

/** A notice button that opens the session's terminal, or says the session has ended (its terminal would close at once). */
export const openSessionAction = (ctx: SubmitContext, card: SessionCard): NoticeAction => ({
  label: 'Open session',
  run: async () => {
    const { sessions } = ctx.composer;
    if (await sessions.ended(card)) {
      ctx.ui.notice({ text: `"${sessionTitle(sessions.latest(card))}" has ended.`, tone: 'warning' });
      return;
    }
    await sessions.open(card);
  },
});

/**
 * Types the submitted command into `card` when Claude waits at an empty prompt there, not in a turn (C and D):
 * `ended` says the session is gone (stopped, or its pane or tmux server no longer there), `blocked` why it was not
 * sent, `error` that tmux failed; none when it was sent.
 */
export async function typeIfIdle(ctx: SubmitContext, card: SessionCard): Promise<{ ended?: string; blocked?: string; error?: string }> {
  const { sessions } = ctx.composer;
  const title = sessionTitle(card);
  const ended = { ended: `"${title}" has ended: start a session to send ${typedCommand(ctx.submission)} to.` };
  if (claudeGone(card)) return ended;
  let screen: PromptScreen;
  try {
    screen = await sessions.promptScreen(card);
  } catch (err) {
    if (tmuxTargetGone((err as Error).message)) return ended;
    return { error: `Cannot read the prompt of "${title}": ${(err as Error).message}` };
  }
  // Claude exited (its old prompt box may still show): the shell would run what is typed.
  if (screen.exited) return ended;
  const blocked = sendBlocker(card, ctx.submission.command ?? '', screen, typedCommand(ctx.submission));
  if (blocked) return { blocked };
  try {
    await sessions.typeInto(card, ctx.text);
  } catch (err) {
    if (tmuxTargetGone((err as Error).message)) return ended;
    return { error: `Cannot type into "${title}": ${(err as Error).message}` };
  }
  return {};
}

/** Types the command into `card` when Claude waits at an empty prompt there, else says why (with Open session and Try again). */
async function sendTo(ctx: SubmitContext, picked: SessionCard): Promise<SubmitOutcome> {
  const card = ctx.composer.sessions.latest(picked);
  const { ended, blocked, error } = await typeIfIdle(ctx, card);
  if (error) return { clear: false, error };
  if (ended) return keepText(ctx.ui, ended);
  if (blocked) return keepText(ctx.ui, { text: blocked, actions: [openSessionAction(ctx, card), { label: 'Try again', run: () => sendTo(ctx, card) }] });
  // The session reloads what it offers: so does the box's `/` menu.
  if (RELOADS.has(ctx.submission.command ?? '')) ctx.composer.clearCommands();
  ctx.ui.notice({ text: `Sent ${shownLine(ctx.text)} to "${sessionTitle(card)}".`, tone: 'info', actions: [openSessionAction(ctx, card)] });
  return { clear: true };
}

/**
 * Asks which session runs the submitted command (C and D), those where the box starts sessions first; while the quick
 * pick shows, the box says where to answer.
 */
export async function pickTarget(ctx: SubmitContext, options: { title: string; placeHolder?: string; offerNew?: string }) {
  const { composer, choice, ui, submission } = ctx;
  const typed = typedCommand(submission);
  const picked = await composer.sessions.pick({
    ...options,
    preferDir: composer.dirOf(choice.where),
    onShow: () => ui.notice({ text: `Pick the session that runs ${typed}, in the list at the top of the window.` }),
  });
  ui.clearNotice();
  return picked;
}

/**
 * Category C: the command goes to a running session the user picks (main and the worktrees), typed into its tmux pane
 * as written (an alias too) while Claude waits at an empty prompt there; otherwise the box says why and keeps the text.
 */
export const sendToSession: Handler = async (ctx) => {
  const { submission, composer, ui } = ctx;
  const typed = typedCommand(submission);
  const hint = submission.builtin?.argumentHint;
  if (missingArgument(hint, submission.arg)) {
    return keepText(ui, `Type ${hint} after ${typed}.`);
  }
  // No pre-check against the last poll: it can predate a session started a moment ago. The pick refreshes first.
  const picked = await pickTarget(ctx, { title: `Send ${shownLine(ctx.text)} to` });
  // No list showed: the refresh before it found no session running.
  if (!picked && !composer.sessions.running().length) return keepText(ui, `No Claude session is running to send ${typed} to: start one first.`);
  if (!picked || picked === NEW_SESSION) return { clear: false };
  return sendTo(ctx, picked);
};
