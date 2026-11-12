import type { SessionState } from '../sessions';
import type { StateLook } from '../stateLooks';

/**
 * The web access JSON API, shared by the daemon (`src/web`) and the page (`src/web/page`). Only `WEB_KEYS` and `SESSION_VIEWS` (and isSessionView) are values,
 * so the page can import this file without pulling in Node code.
 */

export type WebTone = 'yellow' | 'orange' | 'red' | 'blue' | 'green' | 'purple' | 'dim';
/** needs: waiting, blocked, or a finished turn that asks a question; working; rest. The list's sections, in this order. */
export type WebGroup = 'needs' | 'working' | 'rest';

export interface WebCard {
  /** SessionCard.id (session id, or tmux:<server>:<pane|session>); URL-encode it in paths. */
  id: string;
  /** sessionTitle(card) */
  title: string;
  state: SessionState;
  /** stateLook(card, { now, stuckMs }) */
  look: StateLook;
  /** LOOKS[look].label */
  label: string;
  /** LOOKS[look].glyph */
  glyph: string;
  /** First class of LOOKS[look].glyphClass ('blue spin' -> 'blue'); 'dim' when none. */
  tone: WebTone;
  /** glyphClass contains 'spin'. */
  spin: boolean;
  /** featureName */
  feature?: string;
  /** askSummary || liveStatus || detail, oneLine'd, truncated to 200. */
  line: string;
  group: WebGroup;
  updatedAt?: number;
  /** timeAgo(updatedAt, now) */
  ago: string;
  /** tmuxPane: the page follows a card whose id changes (tmux:… -> session id). */
  pane?: string;
  tmuxSession?: string;
  /** !!paneTarget(card) && !claudeGone(card) */
  canSend: boolean;
}

export interface CardsResponse {
  cards: WebCard[];
  at: number;
}

export type TurnKind = 'user' | 'assistant' | 'tool';
/** One transcript entry: the user's words, Claude's text, or one line per tool call (`- Bash npm test`). */
export interface Turn {
  kind: TurnKind;
  text: string;
}

/** A run of screen text with one style. Colours: 0–255 (xterm palette) or `#rrggbb`. */
export interface Span {
  text: string;
  fg?: number | string;
  bg?: number | string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
}
export type ScreenLine = Span[];

/** PromptScreen as JSON (see core/sessionSend.ts). */
export interface ScreenState {
  empty: boolean;
  /** A dialog or menu is open instead of Claude's prompt box (a permission prompt, a choice): it waits for a key. */
  dialog: boolean;
  working: boolean;
  inMode: boolean;
  exited: boolean;
}

export interface SessionDetail {
  card: WebCard;
  /** The last DETAIL_TURNS (40) entries, oldest first. */
  turns: Turn[];
  /** capture-pane -p -e of the pane; [] outside tmux. */
  screen: ScreenLine[];
  prompt: ScreenState;
  /** The pane is gone or Claude exited: the page says "session ended" and goes back. */
  ended: boolean;
}

export interface WebFolder {
  dir: string;
  name: string;
  isMain: boolean;
}
/** Main first, then the others by name. */
export interface FoldersResponse {
  folders: WebFolder[];
}

/** 1..MAX_TEXT_BYTES (65536) UTF-8 bytes. */
export interface SendRequest {
  text: string;
}
/** The page's view of a session: the transcript with a reply box, or the experimental terminal (core/web/terminal.ts). */
export const SESSION_VIEWS = ['transcript', 'terminal-experimental'] as const;
export type SessionView = (typeof SESSION_VIEWS)[number];
export const isSessionView = (v: unknown): v is SessionView => typeof v === 'string' && (SESSION_VIEWS as readonly string[]).includes(v);

/** GET api/settings: what the page shows by default (devdesk.web.sessionView); each browser may choose its own. */
export interface SettingsResponse {
  sessionView: SessionView;
}

/** POST api/sessions/<id>/term/input and …/term/resize. `term`: the id the stream's `hello` event gave. */
export interface TermInputRequest {
  term: string;
  data: string;
}
export interface TermResizeRequest {
  term: string;
  cols: number;
  rows: number;
}

export const WEB_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Enter', 'Escape', 'Up', 'Down'] as const;
export type WebKey = (typeof WEB_KEYS)[number];
export interface KeyRequest {
  key: WebKey;
}
/**
 * prompt may be ''; <= MAX_TEXT_BYTES. mode, model and effort as `ComposerResponse` offers them (absent: the default
 * mode, Claude's own model and effort).
 */
export interface NewSessionRequest {
  dir: string;
  prompt: string;
  mode?: string;
  model?: string;
  effort?: string;
}

/** A command the prompt box's `/` menu offers (core/slashCommands.ts's SlashCommand). */
export interface WebCommand {
  name: string;
  description: string;
  argumentHint?: string;
  origin: string;
  aliases?: readonly string[];
  /** core/builtins.ts's categories; absent: a skill or prompt command (F). */
  category?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  hidden?: boolean;
}
/** A row of the model pill (core/composer.ts's ModelChoice): `value` is what `--model` gets, `Default` none. */
export interface WebModel {
  value: string;
  label: string;
  description: string;
  /** Effort levels besides Default; [] when the model takes none. */
  efforts: string[];
}
export interface WebMode {
  name: string;
  description: string;
}
/** GET api/composer?dir=…: what the prompt box offers for a session in that folder. */
export interface ComposerResponse {
  commands: WebCommand[];
  /** Default first. */
  models: WebModel[];
  modes: WebMode[];
  defaultMode: string;
  /** The mode that starts Claude in plan mode (`--permission-mode plan`), for `/plan <task>`; absent when none does. */
  planMode?: string;
  /** The Claude CLI is still being asked for its commands and models: ask again in a few seconds for its rows. */
  listing: boolean;
}
export interface NewSessionResponse {
  tmuxSession: string;
  server: string;
}

export type ErrorCode = 'bad-request' | 'forbidden' | 'not-found' | 'blocked' | 'ended' | 'too-large' | 'unsupported-type' | 'tmux';
export interface ErrorResponse {
  error: string;
  code: ErrorCode;
}
export interface OkResponse {
  ok: true;
}
