import type { BoardUi, Notice, SubmitOutcome } from './types';

/** What a handler returns after `composer.start`: the box empties when the session started, else it says so. */
export function startedOutcome(started: boolean): SubmitOutcome {
  return started ? { clear: true, started: true } : { clear: false, error: 'The session was not started.' };
}

/** Shows `notice` in the box (a warning unless its `tone` says otherwise) and keeps the text there: nothing ran. */
export function keepText(ui: BoardUi, notice: string | Notice): SubmitOutcome {
  ui.notice(typeof notice === 'string' ? { text: notice, tone: 'warning' } : { tone: 'warning', ...notice });
  return { clear: false };
}
