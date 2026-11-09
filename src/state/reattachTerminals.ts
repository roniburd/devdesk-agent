import type * as vscode from 'vscode';
import { MementoEntries } from './mementoState';

/** A Claude terminal to open again in the next window: the tmux session it is attached to, and that session's server. */
export interface OpenTerminal {
  session: string;
  server: string;
}

/** Where the list is kept (`workspaceState`): `[key, OpenTerminal][]`, changed per entry by every window on the folder. */
export const REATTACH_KEY = 'devdesk.claudeTerminalEntries';
/** The whole-list `OpenTerminal[]` versions up to 0.5.55 kept: copied once into `REATTACH_KEY`. */
export const LEGACY_REATTACH_KEY = 'devdesk.claudeTerminals';

const isOpenTerminal = (v: unknown): v is OpenTerminal =>
  typeof v === 'object' && v !== null && typeof (v as OpenTerminal).session === 'string' && typeof (v as OpenTerminal).server === 'string';

/** The entry's id: one per tmux session (a window shows one terminal per session). */
export const reattachKey = (open: OpenTerminal): string => `${open.server}\n${open.session}`;

/** What a restore found for one saved terminal: attached again, its session is gone (forget it), or it failed (keep it). */
export type RestoreOutcome = 'attached' | 'gone' | 'failed';

/**
 * The Claude terminals to reattach after a reload or a Remote-SSH reconnect, shared by every window on this folder.
 * Each window saves only its own changes (a terminal opened, a terminal closed), on top of what is saved now: never a
 * whole list, so a window still restoring, or another window on the same folder, loses nothing.
 *
 * `T` is the terminal (`vscode.Terminal`), only used as a key.
 */
export class ReattachTerminals<T> {
  private readonly entries: MementoEntries<OpenTerminal>;
  /** This window's terminals on the list. */
  private readonly open = new Map<T, OpenTerminal>();

  constructor(memento: vscode.Memento) {
    this.entries = new MementoEntries(memento, REATTACH_KEY, isOpenTerminal);
    if (!this.entries.saved) {
      const legacy = memento.get<unknown>(LEGACY_REATTACH_KEY);
      const old = Array.isArray(legacy) ? legacy.filter(isOpenTerminal) : [];
      if (old.length) void this.entries.apply(new Map(old.map((o) => [reattachKey(o), { session: o.session, server: o.server }])));
    }
  }

  /** The terminals saved now, by this window and the others on the folder. */
  saved(): OpenTerminal[] {
    return [...this.entries.get().values()];
  }

  /** `terminal` was opened, attached to `open`'s session. */
  opened(terminal: T, open: OpenTerminal): Thenable<void> {
    this.open.set(terminal, open);
    return this.entries.apply(new Map([[reattachKey(open), open]]));
  }

  /**
   * `terminal` was closed. `shutdown`: VS Code closed it because the window is closing or reloading (it disposes every
   * terminal then, `TerminalExitReason.Shutdown`), so it stays on the list for the next window to reattach.
   */
  closed(terminal: T, shutdown: boolean): Thenable<void> {
    const open = this.open.get(terminal);
    if (!open) return Promise.resolve();
    this.open.delete(terminal);
    const key = reattachKey(open);
    if (shutdown || this.isOpenHere(key)) return Promise.resolve();
    return this.entries.apply(new Map([[key, undefined]]));
  }

  /** Forgets the saved terminals whose session a restore found gone, unless one is open here again meanwhile. */
  restored(outcomes: ReadonlyMap<string, RestoreOutcome>): Thenable<void> {
    const changes = new Map<string, undefined>();
    for (const [key, outcome] of outcomes) if (outcome === 'gone' && !this.isOpenHere(key)) changes.set(key, undefined);
    return this.entries.apply(changes);
  }

  private isOpenHere(key: string): boolean {
    for (const o of this.open.values()) if (reattachKey(o) === key) return true;
    return false;
  }
}
