import type { SessionCard } from '../sessions';
import { claudeGone, sessionTitle } from '../sessionSend';
import { displayState, stateLook, timeAgo, waitsOnBackground } from '../sessionsView';
import { LOOKS } from '../stateLooks';
import { oneLine, truncate } from '../text';
import { paneTarget } from '../tmux';
import type { Feature } from '../worktrees';
import { type SortMode, sortSessions } from '../urgency';
import type { WebCard, WebFolder, WebGroup, WebTone } from './types';

/** The session cards as the page shows them: the same titles, looks and labels as the Claude view and the board. */

const TONES: ReadonlySet<string> = new Set<WebTone>(['yellow', 'orange', 'red', 'blue', 'green', 'purple', 'dim']);
const LINE_MAX = 200;

/**
 * What the list goes by, as the Claude view: the time, the stuck and idle limits, the sessions you have not read, and
 * the order (`devdesk.sessions.sort`: `mode`, with `recentMs` and `unreadFirst`).
 */
export interface WebView {
  now: number;
  stuckMs: number;
  idleMs: number;
  unread: ReadonlySet<string>;
  mode: SortMode;
  recentMs: number;
  unreadFirst: boolean;
}

/**
 * The group a session shows under, following `attentionOrder`'s ranks: needs (waiting, blocked, or done and unread),
 * working (also done but waiting on background work), the rest (read done, idle: done and not updated for idleMs, no status).
 */
export function webGroup(card: SessionCard, v: Pick<WebView, 'now' | 'idleMs' | 'unread'>): WebGroup {
  const state = displayState(card, v);
  if (waitsOnBackground(card) || state === 'working') return 'working';
  if (state === 'waiting' || state === 'blocked' || (state === 'done' && v.unread.has(card.id))) return 'needs';
  return 'rest';
}

export function toWebCard(card: SessionCard, o: WebView): WebCard {
  const look = stateLook(card, o);
  const info = LOOKS[look];
  const classes = info.glyphClass.split(/\s+/).filter(Boolean);
  const tone = classes.find((c) => TONES.has(c)) as WebTone | undefined;
  return {
    id: card.id,
    title: sessionTitle(card, o.now),
    state: card.state,
    look,
    label: info.label,
    glyph: info.glyph,
    tone: tone ?? 'dim',
    spin: classes.includes('spin'),
    ...(card.featureName ? { feature: card.featureName } : {}),
    line: truncate(oneLine(card.askSummary || card.liveStatus || card.detail || ''), LINE_MAX),
    group: webGroup(card, o),
    ...(card.updatedAt !== undefined ? { updatedAt: card.updatedAt } : {}),
    ago: timeAgo(card.updatedAt, o.now),
    ...(card.tmuxPane ? { pane: card.tmuxPane } : {}),
    ...(card.tmuxSession ? { tmuxSession: card.tmuxSession } : {}),
    canSend: !!paneTarget(card) && !claudeGone(card),
  };
}

/** In the Claude view's order (`sortSessions`, working sessions not settled), so the phone lists sessions as VS Code does. */
export function webCards(cards: readonly SessionCard[], v: WebView): WebCard[] {
  return sortSessions(cards, v).map((c) => toWebCard(c, v));
}

/** The folders a new session may start in: main first, then the others by name. */
export function webFolders(features: readonly Feature[]): WebFolder[] {
  return features
    .map((f) => ({ dir: f.dir, name: f.name, isMain: f.isMain }))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name));
}
