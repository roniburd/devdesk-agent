import type { BoardComposer } from '../boardComposer';
import type { Submission } from '../core/builtins';
import type { LaunchChoice } from '../core/composer';

/**
 * The Claude Board's prompt box as handlers see it. Every method posts one message to the webview (see `messages.ts`
 * for their shapes and `media/board.js` `HOST_MESSAGES` for what the webview does with them).
 */
export interface BoardUi {
  /** Shows a message in the box, replacing the one there; `actions` are buttons under it. Gone when the text changes. */
  notice(notice: Notice): void;
  /** Takes the message away. */
  clearNotice(): void;
  /** Changes the box's remembered choices, as if the user picked them in the pills (applies to the next launch only). */
  setChoice(patch: ChoicePatch): void;
  /** Opens the model pill's list, or that list with its effort row highlighted. */
  openPicker(picker: 'model' | 'effort'): void;
  /** Empties the box (and puts its text in the history); `started`: a session started, so the box starts in main again. */
  clearBox(started?: boolean): void;
}

export type NoticeTone = 'info' | 'warning' | 'error';

export interface Notice {
  text: string;
  tone?: NoticeTone;
  /** Buttons under the message; clicking one takes the message away and runs `run`. */
  actions?: NoticeAction[];
}

export interface NoticeAction {
  label: string;
  /** What clicking it does; an outcome with `clear` empties the box, one with `error` shows it. */
  run: () => Promise<SubmitOutcome | void> | SubmitOutcome | void;
}

/** The choices the box remembers between launches. */
export type ChoicePatch = Partial<Pick<LaunchChoice, 'model' | 'effort' | 'ultracode' | 'mode'>>;

/** Everything a handler gets for one submission. */
export interface SubmitContext {
  /** The text as submitted (trimmed). */
  text: string;
  /** What `classifySubmission` made of it. */
  submission: Submission;
  /** The box's choices (already checked against what the board offers). */
  choice: LaunchChoice;
  composer: BoardComposer;
  ui: BoardUi;
  /** A prompt for later started from its card: the box holds something else, and its history never held this text. */
  fromCard?: boolean;
}

/** What a handler did: `clear` empties the box; `started` (a session started) also removes a prompt for later being edited. */
export interface SubmitOutcome {
  clear: boolean;
  started?: boolean;
  /** Shown in the box's error line; the text stays. */
  error?: string;
}

export type Handler = (ctx: SubmitContext) => Promise<SubmitOutcome>;

/** A category's handlers: one per command (canonical name, no slash), and the one for the rest of the category. */
export interface CategoryHandlers {
  commands: Readonly<Record<string, Handler>>;
  /** For the category's commands without one of their own (categories whose commands all do the same). */
  fallback?: Handler;
}
