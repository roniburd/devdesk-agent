import { cardsWithNotes, notesDirIn, readNotes } from './devdeskCli';
import type { EndedRecord } from './ended';
import { cardsWithProgramStatus, type ProgramStatus, programStatusDirIn, readProgramStatuses } from './programStatus';
import { type ChildrenReader, runningBackground } from './sessionChildren';
import { readRegistries, readRegistry, type RegistryEntry } from './sessionInfo';
import { buildSessionCards, type HookRecord, type SessionCard } from './sessions';
import { STATE_INFO } from './sessionStates';
import type { TmuxPane } from './tmux';
import { cardsWithWorkers, type Mailbox, readMailboxes, workersDirIn } from './workers';
import type { Feature } from './worktrees';

/**
 * The session cards from what a refresh reads, as the Claude view (`SessionsModel.refresh`) and the web access daemon
 * (`SessionSnapshot`) both build them: the hook records and tmux panes, then Claude's own reports, the notes Claude set
 * and the coordinator/worker mailboxes on top.
 */

/** What the cards take besides the panes and hook records, from the sessions state directory. */
export interface CardExtras {
  /** Claude's own reports (OSC 7501) for sessions run under the Program Status relay, by status file name. */
  statuses: Map<string, ProgramStatus>;
  /** Notes Claude set on its cards (`devdesk note`), by pane. */
  notes: Map<string, { text: string; at: number }>;
  /** Coordinator and worker sessions (`devdesk worker`): which card works for which. */
  mailboxes: Map<string, Mailbox>;
}

/** Reads `CardExtras` from the sessions state directory `stateDir`. */
export async function readCardExtras(stateDir: string, alive: (pid: number) => boolean): Promise<CardExtras> {
  const [statuses, notes, mailboxes] = await Promise.all([
    readProgramStatuses(programStatusDirIn(stateDir), alive),
    readNotes(notesDirIn(stateDir)),
    readMailboxes(workersDirIn(stateDir)),
  ]);
  return { statuses, notes, mailboxes };
}

/** Claude Code's session registry: one directory, several (one per Claude account), or none. */
export function readClaudeRegistries(dirs: string | readonly string[] | undefined): Promise<RegistryEntry[]> {
  return !dirs ? Promise.resolve([]) : typeof dirs === 'string' ? readRegistry(dirs) : readRegistries(dirs);
}

export interface CardSources extends CardExtras {
  panes: readonly TmuxPane[];
  records: readonly HookRecord[];
  features: readonly Feature[];
  alive: (pid: number) => boolean;
  /** Only sessions on this tmux server; every session when undefined (`devdesk.sessions.show` all). */
  onlyServer?: string;
  forkParents?: ReadonlyMap<string, string>;
  ended?: readonly EndedRecord[];
  now: number;
  /** `devdesk.sessions.hooksQuietMinutes` in ms: when Claude's own report goes before a quiet hook record. */
  quietMs: number;
}

/** Every session's card (see `buildSessionCards`), with Claude's reports, notes and workers. */
export function sessionCards(s: CardSources): SessionCard[] {
  const cards = buildSessionCards(s.panes, s.records, s.features, s.alive, s.onlyServer, s.forkParents, s.ended);
  return cardsWithWorkers(cardsWithNotes(cardsWithProgramStatus(cards, s.statuses, { now: s.now, quietMs: s.quietMs }), s.notes), s.mailboxes);
}

/**
 * Lists what each session spun off, from its transcript, when `shown` says to (`devdesk.sessions.showChildren`: how many
 * finished ones; undefined: none), and marks every live session that still runs something in the background
 * (`runsInBackground`), which shows as waiting on background work either way. Changes `cards` in place.
 */
export async function addSessionChildren(cards: SessionCard[], reader: ChildrenReader, shown: number | undefined, alive: (pid: number) => boolean): Promise<void> {
  const finishedLimit = shown ?? 0;
  await Promise.all(
    cards.map(async (card) => {
      if (!card.transcriptPath) return;
      const live = card.pid !== undefined && STATE_INFO[card.state].live && alive(card.pid);
      // Nothing to list, nor anything that can still run.
      if (shown === undefined && !live) return;
      const children = await reader.read(card.transcriptPath, { finishedLimit, live, since: card.sessionStartedAt, roster: card.subagents });
      if (shown !== undefined && children.length) card.children = children;
      if (live && runningBackground(children)) card.runsInBackground = true;
    }),
  );
  reader.prune();
}
