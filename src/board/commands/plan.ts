import { isPromptKind, spelledText, typedCommand, unknownCommandNotice } from '../../core/builtins';
import { keepText, startedOutcome } from '../outcomes';
import type { Handler } from '../types';

/**
 * `/plan <task>` starts a new session in the mode that plans (the configured one whose arguments plan, else Claude's
 * plan permission mode) with the task as its prompt, without Ultracode or the spec prefix. Bare `/plan` asks for a task.
 * The task is classified first, as the CLI runs a first prompt starting with a command as that command: a skill or
 * prompt command (F) or plain text starts; a built-in (`/plan /model opus`, `/plan /exit`) is refused; an unknown command
 * warns, with "Send as text anyway" starting it in plan mode as typed.
 */
export const plan: Handler = async ({ submission, choice, composer, ui }) => {
  const task = submission.arg.trim();
  if (!task) {
    return keepText(ui, 'Type the task after /plan: /plan <task> starts a new session in plan mode on it.');
  }
  const start = async (text: string) => startedOutcome(await composer.start(text, choice, { mode: composer.planMode(), ultracode: false, ui }));
  const inner = await composer.classify(task, choice.where);
  if (inner.kind === 'unknown') return keepText(ui, { text: unknownCommandNotice(inner), actions: [{ label: 'Send as text anyway', run: () => start(task) }] });
  if (!isPromptKind(inner.kind)) {
    return keepText(ui, `/plan takes a task, not ${typedCommand(inner)}: as the first prompt Claude would run that command. Submit ${typedCommand(inner)} on its own.`);
  }
  return start(spelledText(task, inner));
};
