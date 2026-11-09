import type { Completion } from '../boardComposer';
import type { HistoryAnswer } from '../core/boardHistory';
import { type KeepPatch, type KeptState, parseKeep } from '../core/boardKept';
import type { HistoryHit } from '../core/historySearch';
import { parseScope, type ScopedPopover, type UsageScope } from '../core/usageScope';
import type { LimitsView } from '../core/statusLine';
import type { CountProgress } from '../usageCount';

/**
 * The 📊 popup's plan limits: the 5-hour and weekly use (`view`, undefined without numbers), or `setup` when DevDesk's
 * status line, which records them, is not installed (and `devdesk.usage.planLimits` is on).
 */
export interface PlanLimits {
  view?: LimitsView;
  setup?: boolean;
}
import type { NoticeTone } from './types';

// The board webview's protocol. `media/board.js` handles what the extension posts in `HOST_MESSAGES`; what it posts
// back is checked by `parseBoardMessage`.

/** Messages the extension posts for the prompt box (through `BoardUi`, recorded by `PanelUi` for the tests). */
export type HostMessage =
  /** Shows `text` in the box (an empty one takes it away); each action is a button that posts `noticeAction`. */
  | { type: 'notice'; text: string; tone: NoticeTone; actions: { id: string; label: string }[] }
  /** Changes the remembered choices (model value, effort, Ultracode, mode name) and repaints the pills. */
  | { type: 'setChoice'; model?: string; effort?: string; ultracode?: boolean; mode?: string }
  /** Opens the model pill's list (`effort`: with its effort row highlighted). */
  | { type: 'openPicker'; picker: 'model' | 'effort' }
  /** Empties the box (its text goes to the history); `started`: a session started, so it starts in main again. */
  | { type: 'clearBox'; started?: boolean }
  /**
   * The answer to `compose`: `ok` false shows `error` and keeps the text; `ok` with `keep` keeps the text (a handler
   * showed a notice instead); `ok` alone empties the box (`started`: a session started, so it starts in main again).
   */
  | { type: 'composed'; ok: boolean; keep?: boolean; started?: boolean; error?: string };

/** Every other message the extension posts (`board`, the board and `ComposerInfo`, is built in `BoardPanel.post`). */
export type PanelMessage =
  | HostMessage
  /** Focuses the box: `later` saves on Enter; `text`, `choice` and `editing` load a prompt for later to edit. */
  | { type: 'focus'; text?: string; later?: boolean; choice?: unknown; editing?: string }
  /**
   * Posted when the webview loads: what the box keeps for this project folder (`BoardProjectState`), only what is
   * saved. A field not there: nothing saved in this project yet (the webview's choices follow the defaults).
   */
  | ({ type: 'restore' } & KeptState)
  /** → from the Claude view: focus the prompt box. */
  | { type: 'enter' }
  /** The answer to `complete` number `seq`. */
  | { type: 'completions'; kind: '/' | '@'; seq: number; items: Completion[] }
  /** Text to put at the caret (`@` mentions of attached files or a pasted image). */
  | { type: 'insert'; text: string }
  /** The 📊 popover's numbers, for the window's usage scope, with the projects to choose from. */
  | { type: 'usage'; usage: ScopedPopover; limits?: PlanLimits }
  /** How far the usage count in progress has got, for the 📊 popover while it shows "Counting…" (no stored days). */
  | { type: 'usageProgress'; progress: Omit<CountProgress, 'stored'> }
  /**
   * The ✨ search's answer to `query` (`matches` and `note`, or `error`); a cancelled or superseded search posts nothing.
   * `matches` are the board's sessions; `historyMatches` the past sessions from the history.
   */
  | {
      type: 'searchResult';
      query: string;
      matches?: { id: string; reason: string }[];
      historyMatches?: (HistoryHit & { reason: string })[];
      note?: string;
      error?: string;
    }
  /** The answer to `historyQuery` number `seq`: see `HistoryAnswer`. */
  | HistoryAnswer;

/** Messages the board's webview sends; anything else is ignored. */
export type BoardMessage =
  /**
   * `noticeDismissed`: typing in the box (or Escape) removed its notice; `forgetTypedModels`: the model pill's **Forget
   * typed models**; `toggleCardLine`: the ☰ button turns `devdesk.board.cardLine` on or off.
   */
  | { type: (typeof BARE)[number] }
  | { type: (typeof CARD_ACTIONS)[number]; id: string }
  /** `replaces`: the prompt for later being edited, removed once this one is started or saved. */
  | { type: 'compose'; raw: unknown; replaces?: string }
  /** `stacked`: a `/` after other commands (skills only). */
  | { type: 'complete'; kind: '/' | '@'; query: string; where: string; seq: number; stacked?: boolean }
  | { type: 'attach'; where: string }
  /** An image pasted into the box (`data`: base64). */
  | { type: 'pasteImage'; mime: string; data: string }
  /** A button of the notice in the box was clicked. */
  | { type: 'noticeAction'; id: string }
  /** The × of a directory chip added with `/add-dir`. */
  | { type: 'removeAddDir'; dir: string }
  /** ← out of the board: focus the Claude view, on `id`'s row when given. */
  | { type: 'sidebar'; id?: string }
  /**
   * What the box keeps for this project folder changed (`KeepPatch`: choices picked, the draft, a prompt that ran for
   * ⌥↑, the filter or search), saved by `BoardProjectState`.
   */
  | ({ type: 'keep' } & KeepPatch)
  /** The webview's width (CSS px), on load and when it resizes. */
  | { type: 'size'; width: number }
  /** Enter in the search box (or ✨): find sessions about `query` with the model. */
  | { type: 'search'; query: string }
  /** The search box's text, as typed: search the past sessions for it (empty: the box was cleared, stop answering the last one). */
  | { type: 'historyQuery'; query: string; seq: number }
  /** A history result's Resume: continue the past session `id` in its folder. */
  | { type: 'resumeHistory'; id: string }
  /** A history result's Fork: a new session from past session `id`, in its folder (`inMain`: in the workspace root). */
  | { type: 'forkHistory'; id: string; inMain?: boolean }
  /** The 📊 popover's project (or worktree) changed. */
  | { type: 'usageScope'; scope: UsageScope }
  /** A history result's Copy id. */
  | { type: 'copyHistoryId'; id: string }
  /** The webview showed a posted board: in `ms`, with `cards` cards; `postedAt` comes back from the board message. */
  /** `script`: the webview's own time; `rebuilt`: the cards it built again (the others were left as shown). */
  | { type: 'rendered'; ms: number; cards: number; postedAt?: number; script?: number; rebuilt?: number };

/** Messages with no fields. */
const BARE = ['ready', 'settings', 'toggleCardLine', 'noticeDismissed', 'forgetTypedModels', 'usage', 'usageMore', 'cancelSearch', 'setupLimits'] as const;
/** A session card's (`open`, `fork`, `end`, `fixChecks`) or prompt for later's buttons, on the card `id`. */
const CARD_ACTIONS = ['open', 'fork', 'end', 'fixChecks', 'start', 'plan', 'spec', 'draft', 'edit', 'delete'] as const;

/** A Claude session id, as history messages name past sessions. */
const HISTORY_ID = /^[\w-]{1,100}$/;

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/** What the webview sent, checked field by field; undefined for anything the board does not handle. */
export function parseBoardMessage(m: unknown): BoardMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const { type, id } = o;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (isOneOf(BARE, type)) return { type };
  if (isOneOf(CARD_ACTIONS, type) && typeof id === 'string') return { type, id };
  if (type === 'compose') return { type, raw: m, ...(typeof o.replaces === 'string' ? { replaces: o.replaces } : {}) };
  if (type === 'complete' && (o.kind === '/' || o.kind === '@') && typeof o.seq === 'number') {
    return { type, kind: o.kind, query: str(o.query).slice(0, 200), where: str(o.where), seq: o.seq, ...(o.stacked === true ? { stacked: true } : {}) };
  }
  if (type === 'rendered' && typeof o.ms === 'number' && typeof o.cards === 'number') {
    const num = (k: 'postedAt' | 'script' | 'rebuilt') => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? { [k]: o[k] as number } : {});
    return { type, ms: o.ms, cards: o.cards, ...num('postedAt'), ...num('script'), ...num('rebuilt') };
  }
  if (type === 'attach') return { type, where: str(o.where) };
  if (type === 'pasteImage' && typeof o.data === 'string') return { type, mime: str(o.mime), data: o.data };
  if (type === 'noticeAction' && typeof id === 'string') return { type, id };
  if (type === 'removeAddDir' && typeof o.dir === 'string') return { type, dir: o.dir };
  if (type === 'keep') {
    const patch = parseKeep(o);
    return patch ? { type, ...patch } : undefined;
  }
  if (type === 'size' && typeof o.width === 'number' && Number.isFinite(o.width)) return { type, width: o.width };
  if (type === 'sidebar') return { type, ...(typeof id === 'string' ? { id } : {}) };
  if (type === 'search' && typeof o.query === 'string' && o.query.trim()) return { type, query: o.query.trim().slice(0, 500).trim() };
  if (type === 'historyQuery' && typeof o.query === 'string' && typeof o.seq === 'number') return { type, query: o.query.trim().slice(0, 500).trim(), seq: o.seq };
  if ((type === 'resumeHistory' || type === 'copyHistoryId') && typeof id === 'string' && HISTORY_ID.test(id)) return { type, id };
  if (type === 'forkHistory' && typeof id === 'string' && HISTORY_ID.test(id)) return { type, id, ...(o.inMain === true ? { inMain: true } : {}) };
  if (type === 'usageScope') {
    const scope = parseScope(o.scope);
    return scope ? { type, scope } : undefined;
  }
  return undefined;
}
