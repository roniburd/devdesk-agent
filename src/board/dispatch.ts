import { type Category, isPromptKind, spelledText, type SubmissionKind, typedCommand } from '../core/builtins';
import { addDir } from './commands/addDir';
import { blocked } from './commands/blocked';
import { clear } from './commands/clear';
import { config } from './commands/config';
import { effort } from './commands/effort';
import { help } from './commands/help';
import { interactiveOnly } from './commands/interactiveOnly';
import { model } from './commands/model';
import { passThrough } from './commands/passThrough';
import { plan } from './commands/plan';
import { resume } from './commands/resume';
import { sendToSession } from './commands/sendToSession';
import { unknownCommand } from './commands/unknownCommand';
import type { CategoryHandlers, Handler, SubmitContext, SubmitOutcome } from './types';

/**
 * What the board does with each category of built-in (`BUILTINS` in core/builtins.ts says which command is in which).
 * F (skills, prompt commands) and plain text are not here: they start a session (`passThrough`).
 */
export const CATEGORIES: Readonly<Record<Exclude<Category, 'F'>, CategoryHandlers>> = {
  /** Board-native: the board does it itself and sends nothing to Claude. */
  A: { commands: { model, effort, clear, help, resume } },
  /** Launch flags: arguments of the next new session instead of its text. */
  B: { commands: { plan, 'add-dir': addDir } },
  /** Sent to a running session the user picks, typed into its tmux pane while its prompt is empty. */
  C: { commands: {}, fallback: sendToSession },
  /** Interactive-only panels: sent to a running session or launched in a new one, which is opened. */
  D: { commands: { config }, fallback: interactiveOnly },
  /** Blocked: the box says why, nothing runs. */
  E: { commands: {}, fallback: blocked },
};

/** A catalog command whose category has no handler for it (the catalog grew): the box says so, nothing runs. */
export const notHandled: Handler = async ({ submission }) => ({ clear: false, error: `The board does not run ${typedCommand(submission)} yet.` });

/** The handler for a submission: its command's own, else its category's; F and plain text start a session on it. */
export function handlerFor(kind: SubmissionKind, command: string | undefined): Handler {
  if (isPromptKind(kind)) return passThrough;
  if (kind === 'unknown') return unknownCommand;
  const category = CATEGORIES[kind];
  return (command && Object.hasOwn(category.commands, command) ? category.commands[command] : undefined) ?? category.fallback ?? notHandled;
}

/** Runs the submission's handler, on the text with its command spelled as Claude knows it. */
export function dispatch(ctx: SubmitContext): Promise<SubmitOutcome> {
  return handlerFor(ctx.submission.kind, ctx.submission.command)({ ...ctx, text: spelledText(ctx.text, ctx.submission) });
}
