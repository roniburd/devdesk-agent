import type { ClaudeSpinner } from '../claudePrompt';
import type { SessionCard } from '../sessions';
import type { WorkProgress } from './types';

/** The line under a session's last turn on the web page while Claude works (`✻ Cogitating… 1m 12s · ↓ 3.4k tokens`). */

/**
 * How Claude's turn goes: the spinner's verb, time and tokens; for its time, when the spinner shows none (or none
 * shows), how long ago the hooks saw the turn start, while they say it still works.
 */
export function workProgress(card: Pick<SessionCard, 'state' | 'turnStartedAt'>, spinner: ClaudeSpinner | undefined, now: number): WorkProgress | undefined {
  const progress: WorkProgress = { ...spinner };
  const fromHooks = card.state === 'working' && card.turnStartedAt !== undefined ? Math.max(0, Math.floor((now - card.turnStartedAt) / 1000)) : undefined;
  const seconds = spinner?.seconds ?? fromHooks;
  if (seconds !== undefined) progress.seconds = seconds;
  return Object.keys(progress).length ? progress : undefined;
}

/** `72` -> `1m 12s`, as Claude's spinner counts: `5s`, `1m 0s`, `1h 2m 3s`. */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  if (h) return `${h}h ${m}m ${s % 60}s`;
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** `Cogitating… 1m 12s · ↓ 3.4k tokens`, its time `since` seconds on from the progress read; `Working…` with nothing known. */
export function progressLine(p: WorkProgress | undefined, since = 0): string {
  const time = p?.seconds !== undefined ? elapsed(p.seconds + since) : undefined;
  const rest = [time, p?.tokens].filter((x): x is string => !!x).join(' · ');
  return `${p?.verb ?? 'Working'}…${rest ? ` ${rest}` : ''}`;
}
