import { typedCommand } from '../../core/builtins';
import type { Handler } from '../types';

/**
 * `/clear` (`/new`, `/reset`): empties the box (the board already took its message away on submit); no session starts,
 * none is cleared. Text after it is not sent anywhere, so the box says so (⌥↑ brings it back from the history). Saved
 * for later and started from its card, the box's history never held that text: the prompt stays in the lane.
 */
export const clear: Handler = async ({ submission, ui, fromCard }) => {
  const dropped = submission.arg.trim();
  if (!dropped) return { clear: true };
  const kept = fromCard ? 'It stays in Prompts for later.' : '⌥↑ brings it back.';
  ui.notice({ text: `${typedCommand(submission)} only empties the box: “${dropped}” was not sent. ${kept}`, tone: 'info' });
  return { clear: !fromCard };
};
