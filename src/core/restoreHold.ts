/** A tmux session a window is reattaching a terminal to, and that session's server. */
export interface HeldSession {
  server: string;
  session: string;
}

export interface RestoreHoldLimits {
  /** A restore that runs longer than this (a hung tmux) no longer holds anything. */
  maxMs: number;
  /** After the restore, its sessions are held this long more: until their new terminals show as attached in tmux. */
  graceMs: number;
}

const keyOf = (server: string, session: string) => `${server}\n${session}`;

/**
 * Keeps parking off the sessions a window is reattaching after a reload. While the window reloads its terminals are
 * detached from tmux, so those sessions look unattached and parkable; parking one then means its terminal comes back
 * by resuming Claude (`claude --resume`, slow) instead of attaching to tmux. So parking waits while the restore runs,
 * and skips the restored sessions for a grace period after it.
 *
 * Only for that while: the saved terminal list can keep an entry for good (VS Code crashed, or another window on the
 * folder closed), and such an entry must never keep its session from parking.
 */
export class RestoreHold {
  private keys = new Set<string>();
  /** When the running restore stops holding even if it hasn't finished; 0 when none runs. */
  private restoringUntil = 0;
  /** When the finished restore's sessions are no longer held. */
  private graceUntil = 0;

  constructor(private readonly limits: RestoreHoldLimits) {}

  /** A restore of `sessions` starts now. */
  start(sessions: Iterable<HeldSession>, now: number): void {
    this.keys = new Set([...sessions].map((s) => keyOf(s.server, s.session)));
    this.restoringUntil = this.keys.size ? now + this.limits.maxMs : 0;
    this.graceUntil = 0;
  }

  /** The restore finished (or failed). */
  finish(now: number): void {
    if (!this.restoringUntil) return;
    this.restoringUntil = 0;
    this.graceUntil = now + this.limits.graceMs;
  }

  /** A restore is running: no session is parked now. */
  parkingWaits(now: number): boolean {
    return now < this.restoringUntil;
  }

  /** The session on `server` is being restored, or was just restored: it is not parked now. */
  holds(server: string, session: string, now: number): boolean {
    return this.keys.has(keyOf(server, session)) && (this.parkingWaits(now) || now < this.graceUntil);
  }
}
