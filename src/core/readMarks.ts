import { EDITION_TAG } from './edition';
import type { SessionCard } from './sessions';
import { cardSignature } from './sessionsView';

/*
 * The read state both DevDesk Claude versions save (`devdesk.sessions.seen@<host>` in the shared file, see
 * `sharedState.ts`): `[session id, mark]`, where a mark is `<edition>:<cardSignature>`. Each version builds a card's
 * detail its own way, so its signature of a session differs from the other version's: a mark the other version saved
 * says the user had read the session there, but cannot be compared here. Such a mark (and one saved before marks named
 * their version, unless this version saved it) counts as read as the session shows now, and is saved again in this
 * version's terms (`adoptForeign`).
 *
 * The same code is on `main` (v2) and `v1`: keep the two copies the same.
 */

/** What a mark this version cannot compare reads as: the session was read in the other version. */
export const FOREIGN_MARK = '\u0000read elsewhere';

/** The mark this version saves for `signature`. */
export function tagMark(signature: string, tag = EDITION_TAG): string {
  return `${tag}:${signature}`;
}

/**
 * The saved marks in this version's terms: this version's signature, or `FOREIGN_MARK`. An untagged mark (saved before
 * marks named their version) is this version's when its own Memento still holds it (`ownLegacy`), else the other's.
 */
export function ownMarks(saved: ReadonlyMap<string, string>, ownLegacy: ReadonlyMap<string, string>, tag = EDITION_TAG): Map<string, string> {
  const prefix = `${tag}:`;
  const result = new Map<string, string>();
  for (const [id, mark] of saved) {
    if (mark.startsWith(prefix)) result.set(id, mark.slice(prefix.length));
    else if (/^v\d+:/.test(mark)) result.set(id, FOREIGN_MARK);
    else result.set(id, ownLegacy.get(id) === mark ? mark : FOREIGN_MARK);
  }
  return result;
}

/** `seen` with the listed sessions read in the other version read as they show now; `seen` itself when there are none. */
export function adoptForeign(seen: ReadonlyMap<string, string>, cards: readonly SessionCard[]): ReadonlyMap<string, string> {
  const foreign = cards.filter((c) => seen.get(c.id) === FOREIGN_MARK);
  if (!foreign.length) return seen;
  const result = new Map(seen);
  for (const c of foreign) result.set(c.id, cardSignature(c));
  return result;
}
