import type { RecordState, SessionState } from './sessions';

/** What each session state means to the rest of DevDesk, in one place. */
export interface StateInfo {
  /** A state a hook record can say (a live session with DevDesk's hooks), so a card takes it from its newest record. */
  fromRecord: boolean;
  /** Claude was still in a turn: a dead process with a record in this state crashed or was killed. */
  midTurn: boolean;
  /** Claude still runs in the session (not stopped, not parked). */
  live: boolean;
  /** Its turn is over and nothing waits on the user, so the session may be parked. */
  parkable: boolean;
  /** DevDesk's Haiku insight looks at sessions in this state. */
  insights: boolean;
  /** Claude reported how a turn the board started ended (a question, an error, or done), so it no longer shows as starting. */
  endsPendingTurn: boolean;
  /** The order of `buildSessionCards`' list. */
  listOrder: number;
  /** The attention order's rank (see `attentionOrder`), which puts an unread done session (2) above working ones (3). */
  attentionRank: number;
  /** The state's label (`CardView.stateLabel`). */
  label: string;
  /** The activity bar badge counts sessions in this state (by `listOrder`, the most urgent first). */
  badge?: { one: string; many: string };
}

export const STATE_INFO: Readonly<Record<SessionState, Readonly<StateInfo>>> = {
  waiting: {
    fromRecord: true,
    midTurn: true,
    live: true,
    parkable: false,
    insights: true,
    endsPendingTurn: true,
    listOrder: 0,
    attentionRank: 0,
    label: 'NEEDS INPUT',
    badge: { one: 'needs you', many: 'need you' },
  },
  blocked: {
    fromRecord: true,
    midTurn: true,
    live: true,
    parkable: true,
    insights: false,
    endsPendingTurn: true,
    listOrder: 1,
    attentionRank: 1,
    label: 'BLOCKED',
    badge: { one: 'blocked on an error', many: 'blocked on an error' },
  },
  working: {
    fromRecord: true,
    midTurn: true,
    live: true,
    parkable: false,
    insights: true,
    endsPendingTurn: false,
    listOrder: 2,
    attentionRank: 3,
    label: 'WORKING',
    badge: { one: 'working', many: 'working' },
  },
  done: {
    fromRecord: true,
    midTurn: false,
    live: true,
    parkable: true,
    insights: true,
    endsPendingTurn: true,
    listOrder: 3,
    attentionRank: 4,
    label: 'DONE',
  },
  idle: {
    fromRecord: true,
    midTurn: false,
    live: true,
    parkable: true,
    insights: false,
    endsPendingTurn: false,
    listOrder: 4,
    attentionRank: 5,
    label: 'READY',
  },
  unknown: {
    fromRecord: false,
    midTurn: false,
    live: true,
    parkable: false,
    insights: false,
    endsPendingTurn: false,
    listOrder: 5,
    attentionRank: 6,
    label: 'NO STATUS',
  },
  stopped: {
    fromRecord: false,
    midTurn: false,
    live: false,
    parkable: false,
    insights: false,
    endsPendingTurn: false,
    listOrder: 6,
    attentionRank: 7,
    label: 'NOT RUNNING',
  },
  parked: {
    fromRecord: false,
    midTurn: false,
    live: false,
    parkable: true,
    insights: false,
    endsPendingTurn: false,
    listOrder: 7,
    attentionRank: 8,
    label: 'PARKED',
  },
};

/** What `state` (any string, as read from a file) means; undefined when it is no session state. */
export function stateInfo(state: string): Readonly<StateInfo> | undefined {
  return Object.hasOwn(STATE_INFO, state) ? STATE_INFO[state as SessionState] : undefined;
}

/** `state` is one a hook record can say. */
export const isRecordState = (state: string): state is RecordState => !!stateInfo(state)?.fromRecord;
