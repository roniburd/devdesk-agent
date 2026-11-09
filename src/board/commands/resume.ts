import { matchSessions, NEW_SESSION } from '../../core/sessionSend';
import { keepText } from '../outcomes';
import type { Handler } from '../types';

/**
 * `/resume [words]` (`/continue`): a quick pick of the board's sessions DevDesk can open (those in tmux) whose title,
 * prompt, worktree or ids hold every word, and the chosen one opened. Words that match one session open it right away.
 * Sessions outside tmux have no terminal to open, so they are left out, and the box says so when they are all that match.
 */
export const resume: Handler = async ({ submission, composer, ui }) => {
  const filter = submission.arg;
  const all = composer.viewState.cards;
  const matched = matchSessions(all, filter);
  const cards = matched.filter((c) => c.tmuxSession);
  if (!cards.length) {
    const text = matched.length
      ? `${matched.length === 1 ? 'The Claude session' : 'The Claude sessions'}${filter ? ` matching "${filter}"` : ''} ${matched.length === 1 ? 'runs' : 'run'} outside tmux, so DevDesk cannot open ${matched.length === 1 ? 'its terminal' : 'their terminals'}. Fork it from the Claude view to continue it here.`
      : all.length
        ? `No Claude session matches "${filter}".`
        : 'There are no Claude sessions to resume: start one from the box.';
    return keepText(ui, { text, tone: 'info' });
  }
  const picked =
    filter && cards.length === 1
      ? cards[0]
      : await composer.sessions.pick({ cards, title: 'Resume a Claude Session', placeHolder: filter ? `Sessions matching "${filter}"` : 'Pick the session to open' });
  // Dismissed: the text stays, to pick again.
  if (!picked || picked === NEW_SESSION) return { clear: false };
  await composer.sessions.open(picked);
  return { clear: true };
};
