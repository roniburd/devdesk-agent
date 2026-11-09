import { needsArgument } from './commandMenu';
import type { SessionCard } from './sessions';
import { cardView, distinctions, timeAgo, truncate } from './sessionsView';

/**
 * Whether Claude no longer runs in the card's session: `stopped` (a DevDesk tmux session left with a shell), or `parked`
 * (parked, exited or crashed: a resumable row, which may still name the tmux session Claude exited to). Typing into it
 * would reach a shell, or nothing; the board never resumes one to send a command.
 */
export const claudeGone = (card: SessionCard) => card.state === 'stopped' || card.state === 'parked';

/**
 * Sessions the Claude Board can type a command into: in a tmux pane of main or a worktree, with Claude still running
 * (not `claudeGone`). Those in `preferDir` (where the box starts sessions) come first, then the rest in their order.
 */
export function runningSessions(cards: readonly SessionCard[], preferDir?: string): SessionCard[] {
  const running = cards.filter((c) => c.tmuxSession && c.featureDir && !claudeGone(c));
  return [...running.filter((c) => c.featureDir === preferDir), ...running.filter((c) => c.featureDir !== preferDir)];
}

/** A quick pick row for a session: its title; where it runs and its state; its location and what it is doing. */
export interface SessionPick {
  label: string;
  description: string;
  detail: string;
  card: SessionCard;
}

/** `server`: DevDesk's tmux server (sessions on another one name it). */
export function sessionPicks(cards: readonly SessionCard[], now: number, server?: string): SessionPick[] {
  const views = cards.map((card) => cardView(card, now, server));
  const labels = views.map((v) => truncate(v.title, 80));
  const apart = distinctions(cards, labels, now);
  return cards.map((card, i) => {
    const v = views[i];
    return {
      label: labels[i],
      description: [v.worktree, v.stateLabel, timeAgo(card.updatedAt, now), apart[i]].filter(Boolean).join(' · '),
      detail: truncate([v.location, v.detail].filter(Boolean).join(' · '), 120),
      card,
    };
  });
}

/** What a session is found by: its title, name, first prompt, worktree, folder, tmux session and Claude session id. */
function haystack(card: SessionCard, now: number): string {
  const view = cardView(card, now);
  return [view.title, card.name, card.prompt, card.featureName, card.cwd, card.tmuxSession, card.sessionId, card.id].filter(Boolean).join('\n').toLowerCase();
}

/** The cards whose text holds every word of `filter` (any case); all of them for an empty filter. Keeps their order. */
export function matchSessions(cards: readonly SessionCard[], filter: string, now = Date.now()): SessionCard[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...cards];
  return cards.filter((card) => {
    const text = haystack(card, now);
    return words.every((w) => text.includes(w));
  });
}

/** What the board's session pick (`composer.sessions.pick`) returns for its "New session" row. */
export const NEW_SESSION = 'new';

/**
 * `card` as it is in `cards` (just refreshed): the card with its id, else the one in the same tmux pane on the same
 * server (its id changes when a hook first reports it, `tmux:<server>:%N` becoming the session id); `card` when gone.
 */
export function currentCard(cards: readonly SessionCard[], card: SessionCard): SessionCard {
  return (
    cards.find((c) => c.id === card.id) ??
    (card.tmuxPane ? cards.find((c) => c.tmuxPane === card.tmuxPane && c.tmuxServer === card.tmuxServer) : undefined) ??
    card
  );
}

/** Whether `card` has ended in `cards` (as just refreshed): no longer listed, stopped or parked, or no longer in tmux. */
export function sessionEnded(cards: readonly SessionCard[], card: SessionCard): boolean {
  const now = currentCard(cards, card);
  return !cards.includes(now) || claudeGone(now) || !now.tmuxSession;
}

/** The session's title as the box names it. */
export const sessionTitle = (card: SessionCard, now = Date.now()) => truncate(cardView(card, now).title, 60);

/** Commands that leave the conversation as it is, so they may go to a session while Claude works (`/btw` is made for it). */
export const WHILE_WORKING: ReadonlySet<string> = new Set(['btw', 'usage', 'context', 'status']);

/** What a capture of Claude's pane shows (`claudePromptIsEmpty` and `claudeIsWorking`). */
export interface PromptScreen {
  /** Nothing is typed at Claude's prompt (false while a question or dialog is open). */
  empty: boolean;
  /** Claude is in a turn: its spinner shows. */
  working: boolean;
  /**
   * Claude no longer runs in the pane (no Claude process under it): it has exited, though its last prompt box may still
   * show above the shell prompt, and what is typed there would run as a shell command.
   */
  exited?: boolean;
  /**
   * The pane is in a tmux mode (`#{pane_in_mode}`), as copy mode when scrolled back: keys typed there go to the mode,
   * not Claude, and the capture shows Claude's screen beneath it.
   */
  inMode?: boolean;
}

/**
 * Why `/command` (canonical name) cannot be typed into the session now, or undefined when it can: Claude must be at
 * its prompt with nothing typed (`screen.empty`), and not in a turn, as its hooks report (state `working`) or its screen
 * shows (`screen.working`, for sessions without hooks), unless the command is harmless then (`WHILE_WORKING`); and its
 * pane must not be in tmux copy mode (`screen.inMode`), which would take the keys. The
 * message names the command as typed (`typed`, an alias too), `/command` by default.
 */
export function sendBlocker(card: SessionCard, command: string, screen: PromptScreen, typed = `/${command}`): string | undefined {
  const title = sessionTitle(card);
  if ((card.state === 'working' || screen.working) && !WHILE_WORKING.has(command)) return `"${title}" is working: send ${typed} when it is done.`;
  if (screen.inMode) return `"${title}" is scrolled back (tmux copy mode): leave it (q or Escape in its terminal), then send ${typed} again.`;
  if (!screen.empty) return `"${title}" is not at an empty prompt (text is typed in it, or a question or dialog is open): answer or clear it, then send ${typed} again.`;
  return undefined;
}

/** True when the command needs an argument (its catalog hint is `<…>`, as `/btw <question>`) and none was typed. */
export const missingArgument = (argumentHint: string | undefined, arg: string) => needsArgument(argumentHint) && !arg.trim();
