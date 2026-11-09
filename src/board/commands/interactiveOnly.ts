import type { BoardComposer } from '../../boardComposer';
import { typedCommand } from '../../core/builtins';
import type { LaunchChoice } from '../../core/composer';
import { NEW_SESSION } from '../../core/sessionSend';
import { keepText, startedOutcome } from '../outcomes';
import type { Handler } from '../types';
import { pickTarget, typeIfIdle } from './sendToSession';

/**
 * Where the new session starts: where the box starts, except that New worktree means main, as a panel is no reason to
 * make a worktree (it would be named after the command).
 */
function newSessionChoice(choice: LaunchChoice): LaunchChoice {
  return choice.where === 'new' ? { ...choice, where: 'main', worktreeName: undefined } : choice;
}

/** Where the new session would start, for the quick pick. */
function startsIn(composer: BoardComposer, choice: LaunchChoice): string {
  const worktree = composer.info().worktrees.find((w) => w.dir === choice.where);
  return `in ${worktree?.name ?? 'main'}`;
}

/**
 * Category D, a command that only opens a panel in Claude's terminal (`/permissions`, `/hooks`, `/config`, …): asks
 * whether a running session or a new one runs it, types it into the running one (while Claude waits at an empty prompt
 * there) or starts the new one on it (`newSessionChoice`), and opens that session whatever `devdesk.board.afterStart`
 * says, as the panel is what it is for. Sent as typed: no Ultracode, no Spec prefix.
 */
export const interactiveOnly: Handler = async (ctx) => {
  const { text, composer, ui, submission } = ctx;
  const choice = newSessionChoice(ctx.choice);
  const { sessions } = composer;
  const typed = typedCommand(submission);
  const picked = await pickTarget(ctx, { title: `Run ${typed}`, placeHolder: 'Which Claude session should run it?', offerNew: startsIn(composer, choice) });
  // Cancelled: the text stays in the box.
  if (!picked) return { clear: false };
  if (picked === NEW_SESSION) return startedOutcome(await composer.start(text, choice, { ultracode: false, open: true, ui, turn: false }));
  const card = sessions.latest(picked);
  const { ended, blocked, error } = await typeIfIdle(ctx, card);
  // Nothing to open: the session is gone.
  if (ended) return keepText(ui, ended);
  // Opened either way: to use the panel, or to see why the command was not sent.
  await sessions.open(card);
  const why = blocked ?? error;
  if (!why) return { clear: true, started: true };
  return keepText(ui, why);
};
