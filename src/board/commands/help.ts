import { boardHelp, commandHelp, isUnlisted } from '../../core/boardHelp';
import type { Handler } from '../types';

/** `/help`: the board's commands by category, in the box; `/help <command>`: that command and what the board does with it. */
export const help: Handler = async ({ submission, choice, composer, ui }) => {
  const name = submission.arg.split(/\s+/)[0]?.replace(/^\/+/, '');
  if (!name) {
    ui.notice({ text: boardHelp(), tone: 'info' });
    return { clear: true };
  }
  const asked = await composer.classify(`/${name}`, choice.where);
  const listed = asked.kind === 'F' ? (await composer.commands(choice.where)).find((c) => c.name === asked.command)?.description : undefined;
  ui.notice({ text: commandHelp(asked, listed), tone: isUnlisted(asked) ? 'warning' : 'info' });
  return { clear: true };
};
