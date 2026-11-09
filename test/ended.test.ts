import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EndedRecord,
  EndedRecords,
  listableEnded,
  parseEndedRecord,
  readEndedRecords,
  removeEndedRecord,
  writeEndedRecord,
} from '../src/core/ended';
import { buildBoard } from '../src/core/board';
import { buildSessionCards, type HookRecord, type SessionCard } from '../src/core/sessions';
import { attentionOrder, cardSignature, foldParked, stateLook } from '../src/core/sessionsView';
import type { TmuxPane } from '../src/core/tmux';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const rec = (over: Partial<HookRecord> = {}): HookRecord => ({
  sessionId: 's1',
  pid: 100,
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  cwd: '/w',
  event: 'Stop',
  state: 'done',
  detail: 'All tests pass.',
  updatedAt: NOW - 3 * DAY,
  ...over,
});
const ended = (over: Partial<EndedRecord> = {}): EndedRecord => ({ ...rec(), endedAt: NOW - DAY, endReason: 'parked', ...over });
const pane = (session: string, paneId: string, command: string): TmuxPane => ({ session, paneId, command, attached: false, server: 'devdesk' });
const card = (over: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  sessionId: 's1',
  pid: 100,
  tmuxSession: 'cc-main',
  tmuxPane: '%1',
  tmuxServer: 'devdesk',
  cwd: '/w',
  state: 'done',
  detail: 'x',
  updatedAt: NOW - 3 * DAY,
  attached: false,
  ...over,
});

describe('ended records', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-ended-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips, skipping invalid files', async () => {
    expect(await writeEndedRecord(dir, rec(), 'exited', NOW)).toBe(true);
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...rec({ sessionId: 'bad' }), endReason: 'nope', endedAt: 1 }));
    expect(await readEndedRecords(dir)).toEqual([{ ...rec(), endedAt: NOW, endReason: 'exited' }]);
    expect(await readEndedRecords(join(dir, 'missing'))).toEqual([]);
    expect(parseEndedRecord('{')).toBeUndefined();
  });

  it('keeps why DevDesk parked a session when its process then dies', async () => {
    await writeEndedRecord(dir, rec(), 'parked', NOW);
    expect(await writeEndedRecord(dir, rec(), 'exited', NOW + 5)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 's1.json'), 'utf8')).endReason).toBe('parked');
    // Resumed and active since: a new end replaces it.
    expect(await writeEndedRecord(dir, rec({ updatedAt: NOW + 10 }), 'exited', NOW + 20)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 's1.json'), 'utf8')).endReason).toBe('exited');
    await removeEndedRecord(dir, 's1');
    expect(await readdir(dir)).toEqual([]);
  });

  it("records a session's end once when two windows record it at the same moment", async () => {
    const results = await Promise.all([writeEndedRecord(dir, rec(), 'parked', NOW), writeEndedRecord(dir, rec(), 'exited', NOW)]);
    expect(results.filter(Boolean).length).toBe(1);
    expect(await readdir(dir)).toEqual(['s1.json']);
  });

  it('keeps parsed records across reads, re-reading only new or rewritten files', async () => {
    const reader = new EndedRecords();
    const a = join(dir, 'a.json');
    await writeFile(a, JSON.stringify(ended({ sessionId: 'a', detail: 'first' })));
    const at = new Date(NOW);
    await utimes(a, at, at);
    await writeFile(join(dir, 'bad.json'), 'not json');
    expect((await reader.read(dir)).records.map((r) => [r.sessionId, r.detail])).toEqual([['a', 'first']]);
    // Same size and times: what was parsed before is used.
    await writeFile(a, JSON.stringify(ended({ sessionId: 'a', detail: 'other' })));
    await utimes(a, at, at);
    expect((await reader.read(dir)).records.map((r) => r.detail)).toEqual(['first']);
    await writeFile(a, JSON.stringify(ended({ sessionId: 'a', detail: 'rewritten' })));
    await utimes(a, at, new Date(NOW + 5000));
    await writeFile(join(dir, 'b.json'), JSON.stringify(ended({ sessionId: 'b' })));
    expect((await reader.read(dir)).records.map((r) => [r.sessionId, r.detail])).toEqual([
      ['a', 'rewritten'],
      ['b', 'All tests pass.'],
    ]);
    await rm(a);
    expect((await reader.read(dir)).records.map((r) => r.sessionId)).toEqual(['b']);
    expect((await new EndedRecords().read(join(dir, 'missing'))).records).toEqual([]);
  });

  it('checks a new record\'s transcript at once, and seen ones again only once the interval has passed', async () => {
    let now = NOW;
    const reader = new EndedRecords(60_000, () => now);
    const transcript = join(dir, 't.jsonl');
    await writeFile(transcript, '');
    await writeFile(join(dir, 'a.json'), JSON.stringify(ended({ sessionId: 'a', transcriptPath: transcript })));
    await writeFile(join(dir, 'b.json'), JSON.stringify(ended({ sessionId: 'b', transcriptPath: join(dir, 'never.jsonl') })));
    let read = await reader.read(dir);
    expect(read.exists(transcript)).toBe(true);
    expect(read.exists(join(dir, 'never.jsonl'))).toBe(false);
    await rm(transcript);
    now += 59_000;
    read = await reader.read(dir);
    expect(read.exists(transcript)).toBe(true);
    now += 1_000;
    read = await reader.read(dir);
    expect(read.exists(transcript)).toBe(false);
    expect(listableEnded(read.records, new Map(), read.exists).stale.map((r) => r.sessionId)).toEqual(['a', 'b']);
  });

  it('lists ended records that do not run and still have a transcript', () => {
    const records = [
      ended({ sessionId: 'resumed' }),
      ended({ sessionId: 'dying' }),
      ended({ sessionId: 'swept', transcriptPath: '/gone.jsonl' }),
      ended({ sessionId: 'kept', transcriptPath: '/t.jsonl' }),
    ];
    const live = new Map([
      ['resumed', NOW],
      ['dying', NOW - 3 * DAY], // just parked: its Claude has not exited yet
    ]);
    const { listed, stale } = listableEnded(records, live, (p) => p === '/t.jsonl');
    expect(listed.map((r) => r.sessionId)).toEqual(['kept']);
    expect(stale.map((r) => r.sessionId)).toEqual(['resumed', 'swept']);
  });
});

describe('parked cards', () => {
  it('lists ended sessions as parked, and gives a tmux session left with a shell the Claude that ran in it', () => {
    const cards = buildSessionCards(
      [pane('cc-main', '%1', 'zsh')],
      [],
      [],
      () => false,
      'devdesk',
      new Map(),
      [ended({ sessionId: 'older', endedAt: NOW - 2 * DAY }), ended({ sessionId: 'newer', endReason: 'exited' }), ended({ sessionId: 'gone', tmuxSession: 'cc-x', endReason: 'crashed' })],
    );
    expect(cards.map((c) => [c.id, c.state, c.tmuxSession, c.endReason, !!c.crashed])).toEqual([
      ['gone', 'parked', undefined, 'crashed', true],
      ['newer', 'parked', 'cc-main', 'exited', false],
      ['older', 'parked', undefined, 'parked', false],
    ]);
  });

  it('hides an ended session that runs again, and those of other tmux servers', () => {
    const cards = buildSessionCards(
      [pane('cc-main', '%1', 'claude')],
      [rec({ updatedAt: NOW })],
      [],
      (pid) => pid === 100,
      'devdesk',
      new Map(),
      [ended(), ended({ sessionId: 'yours', tmuxServer: 'default' })],
    );
    expect(cards.map((c) => [c.id, c.state])).toEqual([['s1', 'done']]);
  });

  it('look parked, sort last, and parking them is not news', () => {
    const live = card({ state: 'done', detail: 'All tests pass.' });
    const parked = card({ state: 'parked', lastState: 'done', detail: 'All tests pass.', tmuxSession: undefined });
    expect(cardSignature(parked)).toBe(cardSignature(live));
    expect(stateLook(parked, { now: NOW, stuckMs: 1 })).toBe('parked');
    expect(stateLook({ ...parked, crashed: true }, { now: NOW, stuckMs: 1 })).toBe('crashed');
    const order = attentionOrder([parked, card({ id: 'idle', state: 'idle', updatedAt: NOW - 9 * DAY })], { now: NOW, idleMs: 1, unread: new Set() });
    expect(order.map((c) => c.id)).toEqual(['idle', 's1']);
  });

  it('fold past the limit, oldest first out', () => {
    const cards = [card({ id: 'live' }), ...['p1', 'p2', 'p3'].map((id) => card({ id, state: 'parked' }))];
    const { shown, folded } = foldParked(cards, 2);
    expect(shown.map((c) => c.id)).toEqual(['live', 'p1', 'p2']);
    expect(folded.map((c) => c.id)).toEqual(['p3']);
    expect(foldParked(cards, 0).shown.map((c) => c.id)).toEqual(['live']);
  });

  it('go under the divider of the Done / idle lane on the board, newest first up to the limit, can be resumed and removed', () => {
    const cards = ['p1', 'p2', 'p3'].map((id, i) => card({ id, sessionId: id, state: 'parked', tmuxSession: undefined, updatedAt: NOW - i * DAY }));
    const board = buildBoard(cards, [], { view: { now: NOW, idleMs: 1, stuckMs: 1, unread: new Set(), unreadFirst: false }, parkedLimit: 2 });
    const idle = board.lanes.find((l) => l.id === 'review')!;
    expect(idle.sessions.map((s) => [s.id, s.look, s.canOpen, s.canEnd, s.parked, s.idle])).toEqual([
      ['p1', 'parked', true, true, true, true],
      ['p2', 'parked', true, true, true, true],
    ]);
    expect(idle.more).toBe(1);
  });
});
