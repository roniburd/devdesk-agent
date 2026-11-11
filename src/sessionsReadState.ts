import * as vscode from 'vscode';
import type { SessionCard } from './core/sessions';
import { changedEntries } from './core/entries';
import {
  cardShown,
  cardSignature,
  cardView,
  firstSeen,
  type HandMark,
  markSeen,
  nextSeen,
  SEEN_LIMIT,
  type ShownParts,
  shownChange,
  truncate,
  unreadCards,
  withHandMarks,
} from './core/sessionsView';
import { cardServer, claudeTerminalOfTab, claudeTerminalSession } from './claudeSessions';
import { sessionsReadAfterMs, sessionsStateDir, sessionsTmuxServer } from './config';
import { mkdir } from 'node:fs/promises';
import { writeFileAtomic } from './core/atomicWrite';
import { webDir, webSeenJson, webSeenPath } from './core/web/webState';
import { log } from './log';
import type { SessionsModel } from './sessionsModel';
import { hostKey, MementoEntries } from './state/mementoState';
import { adoptForeign, FOREIGN_MARK, ownMarks, tagMark } from './core/readMarks';

/**
 * `globalState` key of what the user has read of each session: `[session id, cardSignature][]`, saved per host under
 * `hostKey(SEEN_KEY)`. Under `SEEN_KEY` itself is what versions before that saved for every host together: read (never
 * written: windows still running those versions use it) on a host's first load.
 */
export const SEEN_KEY = 'devdesk.sessions.seen';

/** How often a mark by hand is checked against what is saved while it stands (`withHandMarks`). */
const HAND_MARK_RECHECK_MS = 5_000;

const isString = (v: unknown): v is string => typeof v === 'string';

/** Why a session last became read or unread, and when. */
export interface ReadChange {
  at: number;
  unread: boolean;
  why: string;
}

/**
 * Which sessions are unread: something happened in them since their terminal was last in front of a focused window for
 * `devdesk.sessions.readAfterSeconds`. What the user has seen of each session (`cardSignature`) is kept in `globalState`
 * per host so a reload or reconnect keeps it; a host's first load takes what the shared key saved (`firstSeen`) and
 * counts the rest as read. Every change it notices itself (a terminal comes to the front, or has been there long
 * enough) calls `recheck`, which calls `sync`.
 *
 * `globalState` is shared by every window of this VS Code (the laptop's local windows and its remote ones alike), and
 * VS Code updates it here when another window writes it. So it is read afresh each time, and only the entries this
 * window changed are saved, on top of what is saved now (`MementoEntries.apply`). A mark by hand that another window's
 * write undoes anyway (it wrote before the mark reached it) is saved again (`withHandMarks`).
 */
export class SessionsReadState implements vscode.Disposable {
  private unreadIds = new Set<string>();
  /** What `shareWithWeb` last wrote. */
  private webSeen: string | undefined;
  /** What the user has seen of each of this host's sessions, as saved now (by this window or another). */
  private readonly saved: MementoEntries<string>;
  /** What versions before per-host read state saved for every host together, for a host's first load. */
  private readonly shared: MementoEntries<string>;
  /** This window's recent marks by hand, saved again if another window's write undoes them. */
  private handMarks = new Map<string, HandMark>();
  /** Sessions whose terminal tab is in front of a focused window, and since when. */
  private looking = new Map<string, number>();
  private lookTimer: NodeJS.Timeout | undefined;
  /** What each session showed at the last refresh (this window only), to log what made it unread. */
  private shown = new Map<string, ShownParts>();
  private readReasons = new Map<string, ReadChange>();
  /** The session being marked read or unread by hand (`setRead`), for the read-state log. */
  private manualRead: { id: string; why: string } | undefined;
  /** Whether this window has logged the read state of a listing yet (the first one says what was loaded). */
  private loggedListing = false;
  /** The last logged set of terminals in front (`visibleCards`), so only changes are logged. */
  private lastVisible = '';
  private readonly subscriptions: vscode.Disposable[];
  /** What this extension saved in its own Memento before the shared file: its untagged marks (`ownMarks`). */
  private readonly ownLegacy: ReadonlyMap<string, string>;
  /** The saved marks last read, in this version's terms. */
  private ownSeen: { from: ReadonlyMap<string, string>; seen: ReadonlyMap<string, string> } | undefined;

  constructor(
    private readonly model: SessionsModel,
    state: vscode.Memento,
    private readonly recheck: () => void,
  ) {
    this.saved = new MementoEntries(state, hostKey(SEEN_KEY), isString, SEEN_LIMIT);
    this.shared = new MementoEntries(state, SEEN_KEY, isString);
    const own = (state as Partial<{ ownValue<T>(key: string): T | undefined }>).ownValue?.<unknown>(hostKey(SEEN_KEY));
    this.ownLegacy = new Map(Array.isArray(own) ? own.filter((e): e is [string, string] => Array.isArray(e) && isString(e[0]) && isString(e[1])) : []);
    this.subscriptions = [
      vscode.window.onDidChangeActiveTerminal(() => recheck()),
      vscode.window.tabGroups.onDidChangeTabs(() => recheck()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => recheck()),
      vscode.window.onDidChangeWindowState(() => recheck()),
      { dispose: () => clearTimeout(this.lookTimer) },
    ];
  }

  /** What the user has seen of each session, as saved now (by this window or another). */
  private get seen(): ReadonlyMap<string, string> {
    const from = this.saved.get();
    if (this.ownSeen?.from !== from) this.ownSeen = { from, seen: ownMarks(from, this.ownLegacy) };
    return this.ownSeen.seen;
  }

  /** Whether any window has saved the read state of this host yet. */
  private get seeded(): boolean {
    return this.saved.saved;
  }

  /** Sessions with something new since the user last looked at them. */
  get unread(): ReadonlySet<string> {
    return this.unreadIds;
  }

  /**
   * Tracks which terminals are in front, re-checking once the next one has been in front for the read delay, and
   * recomputes the unread sessions; true when they changed.
   */
  sync(): boolean {
    const now = Date.now();
    const visible = this.visibleCards();
    const visibleKey = `${vscode.window.state.focused ? 'focused' : 'unfocused'}:${visible.join(',')}`;
    if (visibleKey !== this.lastVisible) {
      this.lastVisible = visibleKey;
      log.info(
        `read state: window ${vscode.window.state.focused ? 'focused' : 'not focused'}; Claude terminals in front: ${
          visible.length ? visible.map((id) => this.describe(id)).join(', ') : 'none'
        }; active tabs: ${vscode.window.tabGroups.all.map((g) => g.activeTab?.label ?? '-').join(' | ')}`,
      );
    }
    this.looking = new Map(visible.map((id) => [id, this.looking.get(id) ?? now]));
    clearTimeout(this.lookTimer);
    this.lookTimer = undefined;
    const readMs = sessionsReadAfterMs();
    const waits = [...this.looking.values()].map((since) => since + readMs - now).filter((ms) => ms > 0 && Number.isFinite(ms));
    // Another window's write can undo a mark by hand at any time; nothing else may refresh for a minute.
    if (this.handMarks.size) waits.push(HAND_MARK_RECHECK_MS);
    if (waits.length) this.lookTimer = setTimeout(() => this.recheck(), Math.min(...waits) + 50);
    return this.refreshUnread();
  }

  /**
   * Whether the user has read what `card` shows now: listed and not unread, or (another workspace's session) last seen
   * showing what it shows now. A session never seen counts as unread.
   */
  isRead(card: SessionCard): boolean {
    if (this.unreadIds.has(card.id)) return false;
    const mark = this.seen.get(card.id);
    // Read in the other version: as it showed there (this version saves it in its terms once it lists it).
    return mark === FOREIGN_MARK || mark === cardSignature(card);
  }

  /**
   * Marks a session read or unread by hand. Marked unread while its terminal is in front, it stays unread until that
   * terminal leaves the front and comes back (like an email marked unread while open). Undefined when the session is not
   * listed, else whether the unread sessions changed.
   */
  setRead(id: string, read: boolean): boolean | undefined {
    const card = this.model.find(id);
    if (!card) return undefined;
    // Marked before this host's first load was saved: save that load's read state with the mark.
    const marked = markSeen(this.seeded ? this.seen : firstSeen(this.shared.get(), this.model.current), card, read);
    this.handMarks.set(id, { signature: marked.get(id), shown: cardSignature(card), at: Date.now() });
    this.save(changedEntries(this.seen, marked));
    if (read) this.looking.delete(id);
    else if (this.looking.has(id)) this.looking.set(id, Number.POSITIVE_INFINITY);
    this.lookTimer ??= setTimeout(() => this.recheck(), HAND_MARK_RECHECK_MS);
    this.manualRead = { id, why: read ? 'marked read' : 'marked unread' };
    try {
      return this.refreshUnread();
    } finally {
      this.manualRead = undefined;
    }
  }

  /** For `devdesk.sessions.diagnostics`: whether this host's read state is saved yet, under which key, and how many sessions it has. */
  get savedState(): { seeded: boolean; count: number; key: string } {
    return { seeded: this.seeded, count: this.seen.size, key: this.saved.key };
  }

  /** For `devdesk.sessions.diagnostics`: the saved signature, the last read change and since when its terminal is in front. */
  sessionState(id: string): { savedSignature?: string; lastChange?: ReadChange; inFrontSince?: number } {
    return { savedSignature: this.seen.get(id), lastChange: this.readReasons.get(id), inFrontSince: this.looking.get(id) };
  }

  /** Sessions whose Claude terminal is the visible tab of some editor group while the window has focus. */
  private visibleCards(): string[] {
    if (!vscode.window.state.focused) return [];
    const shown = new Set(
      vscode.window.tabGroups.all.flatMap((g) => {
        const of = claudeTerminalSession(claudeTerminalOfTab(g.activeTab));
        return of ? [`${of.server}\n${of.session}`] : [];
      }),
    );
    return this.model.current.filter((c) => c.tmuxSession && shown.has(`${cardServer(c)}\n${c.tmuxSession}`)).map((c) => c.id);
  }

  /** Saves these changes (a signature, or undefined for unread) on top of what is saved now. */
  private save(changes: ReadonlyMap<string, string | undefined>): void {
    const marks = new Map([...changes].filter(([, sig]) => sig !== FOREIGN_MARK).map(([id, sig]) => [id, sig === undefined ? undefined : tagMark(sig)] as const));
    void this.saved.apply(marks).then(undefined, (err) => log.warn(`cannot save read sessions: ${(err as Error).message}`));
  }

  /** Recomputes the unread sessions; true when they changed. */
  private refreshUnread(): boolean {
    const now = Date.now();
    const readMs = sessionsReadAfterMs();
    const looked = new Set([...this.looking].filter(([, since]) => now - since >= readMs).map(([id]) => id));
    // Before the first listing there are no cards, which would forget every saved session.
    if (!this.model.isLoaded) return false;
    const cards = this.model.current;
    const saved = this.seen;
    // A host's first load: what the shared key saved for the listed sessions, the others read.
    const first = this.seeded ? undefined : { shared: this.shared.get() };
    // Sessions read in the other version count as read as they show now, saved in this version's terms below.
    const marked = withHandMarks(first ? firstSeen(first.shared, cards) : adoptForeign(saved, cards), this.handMarks, cards, looked, now);
    this.handMarks = marked.marks;
    // Unlimited here: the cap applies when saving, to what is saved by then (`MementoEntries`).
    const seen = nextSeen(marked.seen, cards, looked, false, Number.POSITIVE_INFINITY);
    const changes = changedEntries(saved, seen);
    if (first || changes.size) this.save(changes);
    const unread = unreadCards(seen, cards);
    this.shareWithWeb(seen);
    this.logReadChanges(cards, unread, looked, first && { fromShared: cards.filter((c) => first.shared.has(c.id)).length }, seen);
    const changed = unread.size !== this.unreadIds.size || [...unread].some((id) => !this.unreadIds.has(id));
    this.unreadIds = unread;
    return changed;
  }

  /**
   * Writes what the user has read to `<stateDir>/web-v2/seen.json` when it changed, so the web access daemon (which
   * cannot read VS Code's state) orders and marks sessions as this view does, also after the window closes.
   */
  private shareWithWeb(seen: ReadonlyMap<string, string>): void {
    const text = webSeenJson(seen);
    if (text === this.webSeen) return;
    this.webSeen = text;
    const dir = webDir(sessionsStateDir());
    void mkdir(dir, { recursive: true })
      .then(() => writeFileAtomic(webSeenPath(dir), text))
      .then(undefined, (err) => log.warn(`cannot share read sessions with web access: ${(err as Error).message}`));
  }

  /** `<id prefix> "<title>"`, for log lines. */
  private describe(id: string): string {
    const card = this.model.current.find((c) => c.id === id);
    const title = card ? cardView(card, Date.now(), sessionsTmuxServer()).title : '?';
    return `${id.slice(0, 8)} ${JSON.stringify(truncate(title, 50))}`;
  }

  /** Logs each session that became read or unread, and what it showed that was new. */
  private logReadChanges(
    cards: readonly SessionCard[],
    unread: ReadonlySet<string>,
    looked: ReadonlySet<string>,
    seed: { fromShared: number } | undefined,
    seen: ReadonlyMap<string, string>,
  ): void {
    const now = Date.now();
    const first = !this.loggedListing;
    this.loggedListing = true;
    if (seed) {
      log.info(
        `read state: first load on this host (${this.saved.key}), ${cards.length} sessions listed: ${seed.fromShared} take their read state from ${SEEN_KEY} (saved for every host together), the others count as read; ${unread.size} unread`,
      );
    } else if (first) {
      const saved = cards.filter((c) => seen.has(c.id)).length;
      log.info(
        `read state: loaded ${seen.size} saved sessions of this host (${this.saved.key}); ${cards.length} listed (${saved} of them saved), ${unread.size} unread`,
      );
    }
    for (const c of cards) {
      const after = cardShown(c);
      const before = this.shown.get(c.id);
      const change = before ? shownChange(before, after) : '';
      const wasUnread = this.unreadIds.has(c.id);
      const isUnread = unread.has(c.id);
      let why = '';
      if (this.manualRead?.id === c.id && wasUnread !== isUnread) why = this.manualRead.why;
      else if (!before && isUnread) {
        const known = seen.has(c.id);
        if (first) why = known ? 'changed since it was last read (saved signature differs)' : 'not in the saved read state';
        else why = known ? 'listed again, changed since it was last read' : 'new session';
      }
      else if (!wasUnread && isUnread) why = change ? `changed: ${change}` : 'signature differs from the saved one';
      else if (wasUnread && !isUnread) why = looked.has(c.id) ? `terminal was in front ${Math.round(sessionsReadAfterMs() / 1000)}s` : 'back to what was read';
      else if (isUnread && change) log.debug(`read state: ${this.describe(c.id)} still unread, changed: ${change}`);
      else if (!isUnread && change) log.debug(`read state: ${this.describe(c.id)} changed while in front: ${change}`);
      if (why) {
        log.info(`read state: ${this.describe(c.id)} → ${isUnread ? 'UNREAD' : 'read'} (${why}); now ${after.state}, ${JSON.stringify(truncate(after.detail, 80))}`);
        this.readReasons.set(c.id, { at: now, unread: isUnread, why });
      }
      this.shown.set(c.id, after);
    }
    const listed = new Set(cards.map((c) => c.id));
    const gone = [...this.shown.keys()].filter((id) => !listed.has(id));
    if (gone.length) {
      log.info(
        `read state: ${gone.length} sessions no longer listed (${cards.length} listed now), their read state kept: ${gone.map((id) => id.slice(0, 8)).join(', ')}`,
      );
    }
    for (const id of gone) this.shown.delete(id);
    for (const id of this.readReasons.keys()) if (!listed.has(id)) this.readReasons.delete(id);
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
  }
}
