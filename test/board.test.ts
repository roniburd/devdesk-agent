import { describe, expect, it } from 'vitest';
import { type BacklogItem, besideBoardWidth, buildBoard, choiceChips, fullBoardWidth, LANES, LAUNCH_GRACE_MS, laneForLook, launchKey, liveLaunches, parseBacklog, serializeBacklog } from '../src/core/board';
import { HIDDEN_PARKED_MAX } from '../src/core/boardSearch';
import type { SessionCard } from '../src/core/sessions';
import type { StateLook } from '../src/core/sessionsView';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const opts = { now: NOW, idleMs: 30 * MIN, stuckMs: 10 * MIN, unread: new Set<string>(), unreadFirst: true };

const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({
  id,
  sessionId: '0b7d1c9e-1111-4222-8333-944455556666',
  tmuxSession: `cc-${id}`,
  tmuxPane: '%1',
  cwd: `/ws/worktrees/${id}`,
  featureName: id,
  featureDir: `/ws/worktrees/${id}`,
  state: 'done',
  detail: 'Finished',
  prompt: `do ${id}`,
  updatedAt: NOW - MIN,
  attached: false,
  ...over,
});

describe('laneForLook', () => {
  it('puts every look in one of the session lanes', () => {
    const expected: Record<StateLook, string> = {
      question: 'needs',
      permission: 'needs',
      plan: 'needs',
      input: 'needs',
      working: 'working',
      stuck: 'working',
      background: 'working',
      done: 'review',
      asked: 'review',
      interrupted: 'review',
      error: 'review',
      limited: 'review',
      crashed: 'review',
      idle: 'review',
      stopped: 'review',
      parked: 'review',
      unknown: 'review',
    };
    for (const [look, lane] of Object.entries(expected)) expect(laneForLook(look as StateLook), look).toBe(lane);
  });

  it('lists the lanes in board order, backlog first', () => {
    expect(LANES.map((l) => l.id)).toEqual(['backlog', 'needs', 'working', 'review']);
  });
});

describe('buildBoard', () => {
  it('tells apart cards with the same title by when they started, else their tmux session', () => {
    const hookless = (id: string, over: Partial<SessionCard> = {}) =>
      card(id, { name: undefined, prompt: undefined, cwd: '/w/src/PkgA', tmuxSession: `cc-${id}`, state: 'unknown', updatedAt: undefined, ...over });
    const board = buildBoard([hookless('a', { startedAt: NOW - 5 * MIN }), hookless('b'), card('solo', { name: 'Alone' })], [], opts);
    const titles = Object.fromEntries(board.lanes.flatMap((l) => l.sessions).map((s) => [s.id, s.title]));
    expect(titles).toEqual({ a: 'Claude in PkgA · started 5m ago', b: 'Claude in PkgA · cc-b', solo: 'Alone' });
  });
  it('sorts sessions into lanes and counts the ones that need you and are working', () => {
    const board = buildBoard(
      [
        card('a', { state: 'waiting', detail: 'Asking: which one?' }),
        card('b', { state: 'working', detail: 'Running Bash: npm test' }),
        card('c', { state: 'working', updatedAt: NOW - 20 * MIN }),
        card('d', { state: 'blocked', detail: 'API error' }),
        card('e', { state: 'done', updatedAt: NOW - 2 * 60 * MIN }),
        card('f', { state: 'stopped', crashed: true }),
        card('g', { state: 'idle', detail: 'Ready' }),
        card('h', { state: 'done', detail: 'Interrupted', updatedAt: NOW - 1000 }),
      ],
      [],
      opts,
    );
    const ids = Object.fromEntries(board.lanes.map((l) => [l.id, l.sessions.map((s) => s.id)]));
    expect(ids).toEqual({ backlog: [], needs: ['a'], working: ['b', 'c'], review: ['d', 'h', 'g', 'e', 'f'] });
    // Read, and sorting as idle or later (done two hours ago too): under the Done / idle lane's divider.
    const review = board.lanes.find((l) => l.id === 'review')!;
    expect(review.divider).toBe('Idle / stopped');
    expect(review.sessions.filter((s) => s.idle).map((s) => s.id)).toEqual(['g', 'e', 'f']);
    expect(board.lanes.filter((l) => l.id !== 'review').every((l) => !l.divider)).toBe(true);
    expect(board.needYou).toBe(1);
    expect(board.working).toBe(2);
    const stuck = board.lanes[2].sessions[1];
    expect(stuck.look).toBe('stuck');
    expect(stuck.lookLabel).toBe('NO PROGRESS (STUCK?)');
  });

  it("shows the note Claude set on its card (devdesk note), in its hover too, and finds it", () => {
    const board = buildBoard([card('a', { note: 'waiting for CI' }), card('b')], [], opts);
    const [a, b] = ['a', 'b'].map((id) => board.lanes.flatMap((l) => l.sessions).find((s) => s.id === id)!);
    expect(a.note).toBe('waiting for CI');
    expect(a.hoverParts).toContainEqual({ label: "Claude's note", text: 'waiting for CI' });
    expect(a.search.all).toContain('waiting for ci');
    expect(b.note).toBeUndefined();
  });

  it('marks the card whose Claude terminal is in front', () => {
    const board = buildBoard([card('a'), card('b')], [], { ...opts, focused: 'b' });
    const flags = board.lanes.flatMap((l) => l.sessions).map((s) => [s.id, s.focused]);
    expect(flags.sort()).toEqual([
      ['a', undefined],
      ['b', true],
    ]);
  });

  it('orders a lane unread first and marks unread cards', () => {
    const board = buildBoard(
      [card('old', { updatedAt: NOW - 2 * MIN }), card('new', { updatedAt: NOW - MIN })],
      [],
      { ...opts, unread: new Set(['old']) },
    );
    const review = board.lanes.find((l) => l.id === 'review')!;
    expect(review.sessions.map((s) => [s.id, s.unread])).toEqual([
      ['old', true],
      ['new', false],
    ]);
  });

  it('shows what each card can do, its worktree and its running children', () => {
    const board = buildBoard(
      [
        card('a', {
          state: 'working',
          children: [{ id: 'k', kind: 'agent', label: 'x', state: 'running', children: [] } as never],
        }),
        card('b', { tmuxSession: undefined, tmuxPane: undefined, featureName: undefined }),
        card('c', { sessionId: undefined }),
      ],
      [],
      opts,
    );
    const all = board.lanes.flatMap((l) => l.sessions);
    const a = all.find((s) => s.id === 'a')!;
    const b = all.find((s) => s.id === 'b')!;
    const c = all.find((s) => s.id === 'c')!;
    expect(a).toMatchObject({ title: 'do a', worktree: 'a', running: 1, canOpen: true, canFork: true, canEnd: true });
    expect(b).toMatchObject({ worktree: 'no worktree', canOpen: false, canFork: true, canEnd: false });
    expect(c.canFork).toBe(false);
    expect(board.worktrees).toEqual(['a', 'c', 'no worktree']);
  });

  it("hovers with Claude's latest recap, the last prompt and the detail", () => {
    const board = buildBoard(
      [card('a', { name: 'Alarm work', summary: 'Added the alarm', summaryAt: NOW - 2 * MIN, detail: 'Running Bash: npm test', state: 'working', updatedAt: NOW })],
      [],
      opts,
    );
    const s = board.lanes.flatMap((l) => l.sessions)[0];
    expect(s.hoverParts.slice(0, 4)).toEqual([
      { text: 'Alarm work' },
      { label: "Claude's recap", text: 'Added the alarm (2m ago)' },
      { label: 'Last prompt', text: 'do a' },
      { label: 'Latest', text: 'Running Bash: npm test' },
    ]);
  });

  it('keeps a parked session under the Done / idle divider with the look its last turn ended with', () => {
    const board = buildBoard([card('p', { state: 'parked', lastState: 'done', tmuxSession: undefined, endReason: 'exited', updatedAt: NOW - MIN })], [], opts);
    const s = board.lanes.find((l) => l.id === 'review')!.sessions[0];
    expect(s).toMatchObject({ look: 'done', lookLabel: 'DONE · PARKED (NOT RUNNING)', parked: true, idle: true });
    expect(s.search.is).toContain('idle / stopped');
    const done = buildBoard([card('d')], [], opts).lanes.find((l) => l.id === 'review')!.sessions[0];
    expect(done.search.is).toContain('done / to review');
  });

  it('keeps unread idle sessions above the divider, to review', () => {
    const board = buildBoard([card('u', { state: 'idle', detail: 'Ready' }), card('r', { state: 'idle', detail: 'Ready', updatedAt: NOW - 2 * MIN })], [], { ...opts, unread: new Set(['u']) });
    const review = board.lanes.find((l) => l.id === 'review')!;
    expect(review.sessions.map((s) => [s.id, !!s.idle])).toEqual([
      ['u', false],
      ['r', true],
    ]);
  });

  it('keeps unread parked sessions to review past the parked limit; read ones past it only count in more', () => {
    const parked = (id: string, at: number) => card(id, { state: 'parked', lastState: 'done', tmuxSession: undefined, endReason: 'exited', updatedAt: NOW - at * MIN });
    const cards = [parked('r1', 1), parked('r2', 2), parked('r3', 3), parked('u1', 4), parked('u2', 5)];
    const board = buildBoard(cards, [], { ...opts, unread: new Set(['u1', 'u2']), parkedLimit: 1 });
    const lane = (id: string) => board.lanes.find((l) => l.id === id)!;
    expect(lane('review').sessions.map((s) => [s.id, !!s.idle])).toEqual([
      ['u1', false],
      ['u2', false],
      ['r1', true],
    ]);
    expect(lane('review').sessions.every((s) => s.parked)).toBe(true);
    expect(lane('review').more).toBe(2);
  });

  it('shows the model the board started a session with, on its tmux server only', () => {
    const launchedModels = new Map([[launchKey('devdesk', 'cc-a'), 'Opus (1M context)']]);
    const board = buildBoard([card('a', { tmuxServer: 'devdesk' }), card('b', { tmuxServer: 'devdesk' }), card('c', { tmuxSession: 'cc-a' })], [], { ...opts, launchedModels });
    const byId = Object.fromEntries(board.lanes.flatMap((l) => l.sessions).map((s) => [s.id, s]));
    expect(byId.a.model).toBe('Opus (1M context)');
    expect(byId.a.hoverParts).toContainEqual({ label: 'Started with', text: 'Opus (1M context)' });
    expect(byId.b).not.toHaveProperty('model');
    // Same name on the default tmux server: not the board's.
    expect(byId.c).not.toHaveProperty('model');
  });

  it("shows DevDesk's live status while working, else the detail with the summary under it", () => {
    const board = buildBoard(
      [
        card('a', { state: 'working', detail: 'Running Bash: npm test', liveStatus: 'Running the unit tests', insightSummary: 'Parser fixed', updatedAt: NOW }),
        card('b', { state: 'done', detail: 'All green.', insightSummary: 'Released v2', updatedAt: NOW }),
      ],
      [],
      opts,
    );
    const [a, b] = ['a', 'b'].map((id) => board.lanes.flatMap((l) => l.sessions).find((s) => s.id === id)!);
    expect([a.detail, a.insight]).toEqual(['Running the unit tests', '']);
    expect(a.hoverParts).toContainEqual({ label: 'Where it stands', text: 'Parser fixed' });
    expect(a.hoverParts).toContainEqual({ label: 'Doing now', text: 'Running the unit tests' });
    expect(a.hoverParts).toContainEqual({ label: 'Latest', text: 'Running Bash: npm test' });
    expect([b.detail, b.insight]).toEqual(['All green.', 'Released v2']);
    // Only Working cards say what Claude is doing now.
    expect(a.doing).toBe('Running the unit tests');
    expect(b).not.toHaveProperty('doing');
  });

  it("says in Working what Claude is doing: the live status, else the hook's detail", () => {
    const board = buildBoard([card('a', { state: 'working', detail: 'Running Bash: npm test', updatedAt: NOW })], [], opts);
    expect(board.lanes.flatMap((l) => l.sessions)[0].doing).toBe('Running Bash: npm test');
  });

  it("titles a card by DevDesk's Haiku title, unless the user named the session", () => {
    const board = buildBoard(
      [
        card('a', { prompt: 'Fix the login timeout when the session expires: raise TIMEOUT_MS', insightTitle: 'Raise login timeout' }),
        card('b', { name: 'Claude made this up', insightTitle: 'Bump Node' }),
        card('c', { name: 'my name', nameByUser: true, insightTitle: 'Bump Node' }),
        card('d', { prompt: 'no insight yet' }),
      ],
      [],
      opts,
    );
    const byId = Object.fromEntries(board.lanes.flatMap((l) => l.sessions).map((s) => [s.id, s]));
    expect([byId.a.title, byId.b.title, byId.c.title, byId.d.title]).toEqual(['Raise login timeout', 'Bump Node', 'my name', 'no insight yet']);
    // The prompt the short title stands for is in the hover.
    expect(byId.a.hoverParts).toContainEqual({ label: 'Last prompt', text: 'Fix the login timeout when the session expires: raise TIMEOUT_MS' });
  });

  it('with cardTitle objective, titles a card by the session objective, the latest step under it', () => {
    const cards = [
      card('a', { insightTitle: 'Fix failing test', insightObjective: 'Add OAuth login and migrate storage' }),
      card('b', { insightTitle: 'Bump Node' }),
      card('c', { name: 'my name', nameByUser: true, insightTitle: 'Bump Node', insightObjective: 'Upgrade the toolchain' }),
    ];
    const byId = (cardTitle?: 'objective' | 'latest') =>
      Object.fromEntries(buildBoard(cards, [], { ...opts, cardTitle }).lanes.flatMap((l) => l.sessions).map((s) => [s.id, s]));
    const o = byId('objective');
    expect([o.a.title, o.a.latest]).toEqual(['Add OAuth login and migrate storage', 'Fix failing test']);
    expect(o.a.hoverParts).toContainEqual({ label: 'Latest step', text: 'Fix failing test' });
    // No objective yet, or a name the user gave: the title as with `latest`, nothing under it.
    expect([o.b.title, o.b.latest]).toEqual(['Bump Node', undefined]);
    expect([o.c.title, o.c.latest]).toEqual(['my name', undefined]);
    const l = byId('latest');
    expect([l.a.title, l.a.latest]).toEqual(['Fix failing test', undefined]);
  });

  it("says in Needs you what Claude asks: Haiku's line, else the hook's detail", () => {
    const board = buildBoard(
      [
        card('a', { state: 'waiting', detail: 'Claude needs your permission to use Bash', askSummary: 'Allow npm uninstall aws-sdk?' }),
        card('b', { state: 'waiting', detail: 'Asking: Cursor or page numbers?' }),
        card('c', { state: 'done' }),
      ],
      [],
      opts,
    );
    const byId = Object.fromEntries(board.lanes.flatMap((l) => l.sessions).map((s) => [s.id, s]));
    expect([byId.a.ask, byId.b.ask]).toEqual(['Allow npm uninstall aws-sdk?', 'Cursor or page numbers?']);
    expect(byId.a.hoverParts).toContainEqual({ label: 'Waiting on', text: 'Claude needs your permission to use Bash' });
    expect(byId.c).not.toHaveProperty('ask');
  });

  it('lists prompts for later newest first, with where they run and what they change from the defaults', () => {
    const backlog: BacklogItem[] = [
      { id: '1', prompt: 'Old prompt', createdAt: NOW - 3 * 60 * MIN },
      { id: '2', prompt: 'New prompt\nmore', createdAt: NOW - 5 * MIN, choice: { where: 'new', worktreeName: 'fix-it', mode: 'Plan', model: 'opus', effort: 'high', ultracode: true } },
      { id: '3', prompt: 'In a worktree', createdAt: NOW - 1 * MIN, choice: { where: '/ws/worktrees/feat-a', mode: 'Default', model: 'Default', effort: 'Default' } },
    ];
    const lane = buildBoard([], backlog, { ...opts, defaultMode: 'Default', starting: new Set(['3']) }).lanes[0];
    expect(lane.title).toBe('Prompts for later');
    expect(lane.tasks).toEqual([
      { id: '3', prompt: 'In a worktree', ago: '1m', chips: ['feat-a'], starting: true },
      { id: '2', prompt: 'New prompt\nmore', ago: '5m', chips: ['new: fix-it', 'Plan', 'opus', 'effort high', 'Ultracode'], starting: false },
      { id: '1', prompt: 'Old prompt', ago: '3h', chips: ['main'], starting: false },
    ]);
  });
});

describe('choiceChips', () => {
  const rows = [
    { value: 'global.anthropic.claude-opus-5-5[1m]', label: 'Opus (1M context)', description: '', efforts: [] },
    { value: 'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc', label: 'Team router', description: '', efforts: [] },
  ];

  it("shows a model by its row's name, not its raw value", () => {
    expect(choiceChips({ model: 'global.anthropic.claude-opus-5-5[1m]' }, 'Default', rows)).toEqual(['main', 'Opus (1M context)']);
    expect(choiceChips({ model: rows[1].value }, 'Default', rows)).toEqual(['main', 'Team router']);
  });

  it('falls back to the raw value for a model no row offers', () => {
    expect(choiceChips({ model: 'sonnet' }, 'Default', rows)).toEqual(['main', 'sonnet']);
    expect(choiceChips({ model: 'sonnet' }, 'Default')).toEqual(['main', 'sonnet']);
  });

  it('names the model in the backlog lane from the board rows', () => {
    const backlog: BacklogItem[] = [{ id: '1', prompt: 'P', createdAt: NOW, choice: { model: 'global.anthropic.claude-opus-5-5[1m]' } }];
    expect(buildBoard([], backlog, { ...opts, models: rows }).lanes[0].tasks[0].chips).toEqual(['main', 'Opus (1M context)']);
  });
});

describe('backlog file', () => {
  it('round-trips items', () => {
    const items: BacklogItem[] = [
      { id: 'a', prompt: 'One', createdAt: 1 },
      { id: 'b', prompt: 'Two', createdAt: 2, choice: { where: 'main', mode: 'Plan', ultracode: false } },
    ];
    expect(parseBacklog(serializeBacklog(items))).toEqual(items);
  });

  it('reads tasks from before prompts as one prompt: the title, then the notes', () => {
    expect(parseBacklog(JSON.stringify({ items: [{ id: 'a', title: ' Fix it ', notes: 'see run 4412 ', createdAt: 1 }, { id: 'b', title: 'Only', createdAt: 2 }] }))).toEqual([
      { id: 'a', prompt: 'Fix it\n\nsee run 4412', createdAt: 1 },
      { id: 'b', prompt: 'Only', createdAt: 2 },
    ]);
  });

  it('drops malformed entries and fields of the wrong type', () => {
    expect(
      parseBacklog(
        JSON.stringify({
          items: [
            { id: 'a', prompt: 'ok', createdAt: 1, choice: { mode: 3, model: 'opus', ultracode: 'yes', extra: 'x' } },
            { id: 'b', prompt: ' ', createdAt: 1 },
            { id: 3, prompt: 'x', createdAt: 1 },
            { id: 'c', title: '', createdAt: 1 },
            null,
          ],
        }),
      ),
    ).toEqual([{ id: 'a', prompt: 'ok', createdAt: 1, choice: { model: 'opus' } }]);
  });

  it('throws on a file that is not a backlog, so it is never mistaken for an empty one', () => {
    expect(() => parseBacklog('not json')).toThrow();
    expect(() => parseBacklog('{"items": 3}')).toThrow();
    expect(() => parseBacklog('null')).toThrow();
  });

  it('reads a blank file as no prompts', () => {
    expect(parseBacklog('')).toEqual([]);
    expect(parseBacklog(' \n')).toEqual([]);
  });

  it('writes each prompt as a title and notes too, for windows still running a version from before prompts', () => {
    const items = JSON.parse(serializeBacklog([{ id: 'a', prompt: 'Fix it\n\nsee run 4412', createdAt: 1 }, { id: 'b', prompt: 'One line', createdAt: 2 }])).items;
    expect(items).toEqual([
      { id: 'a', prompt: 'Fix it\n\nsee run 4412', createdAt: 1, title: 'Fix it', notes: 'see run 4412' },
      { id: 'b', prompt: 'One line', createdAt: 2, title: 'One line' },
    ]);
    // What such a window writes back still reads as the same prompt.
    expect(parseBacklog(JSON.stringify({ items: items.map(({ id, title, notes, createdAt }: Record<string, unknown>) => ({ id, title, notes, createdAt })) }))).toEqual([
      { id: 'a', prompt: 'Fix it\n\nsee run 4412', createdAt: 1 },
      { id: 'b', prompt: 'One line', createdAt: 2 },
    ]);
  });
});

describe('liveLaunches', () => {
  it('keeps launches whose session is listed, or that are too new to be listed yet', () => {
    const launches = new Map([
      [launchKey('devdesk', 'cc-main'), { model: 'Opus', at: NOW - 10 * MIN }],
      [launchKey('devdesk', 'cc-main-2'), { model: 'Sonnet', at: NOW - 10 * MIN }],
      [launchKey('devdesk', 'cc-main-3'), { model: 'Haiku', at: NOW - LAUNCH_GRACE_MS + 1 }],
    ]);
    const live = liveLaunches(launches, new Set([launchKey('devdesk', 'cc-main')]), NOW);
    expect([...live.values()].map((l) => l.model)).toEqual(['Opus', 'Haiku']);
    expect(launchKey(undefined, 'cc-main')).toBe('default\ncc-main');
  });
});

describe('besideBoardWidth', () => {
  const full = fullBoardWidth(220);

  it('fits every lane at the lane width', () => {
    expect(full).toBe(4 * 220 + 3 * 10 + 28);
  });

  it('auto: the full board beside the terminal when the terminal gets at least as much room', () => {
    expect(besideBoardWidth(2740, 'auto', 220)).toBe(full);
    expect(besideBoardWidth(2 * full, 'auto', 220)).toBe(full);
    expect(besideBoardWidth(2 * full - 1, 'auto', 220)).toBeUndefined();
  });

  it('always: splits a narrow editor area too, the board taking at most half', () => {
    expect(besideBoardWidth(1600, 'always', 220)).toBe(800);
    expect(besideBoardWidth(2740, 'always', 220)).toBe(full);
  });

  it('never, or no width measured yet: no split', () => {
    expect(besideBoardWidth(4000, 'never', 220)).toBeUndefined();
    expect(besideBoardWidth(0, 'auto', 220)).toBeUndefined();
    expect(besideBoardWidth(Number.NaN, 'always', 220)).toBeUndefined();
  });
});

describe('buildBoard: search', () => {
  it('gives every card its search fields', () => {
    const board = buildBoard([card('a', { state: 'waiting', prompt: 'Fix the parser', summary: 'Parser fixed, tests pass' })], [], opts);
    const s = board.lanes.find((l) => l.id === 'needs')!.sessions[0];
    expect(s.search.all).toContain('fix the parser');
    expect(s.search.all).toContain('tests pass');
    expect(s.search.is).toContain('needs you');
    expect(s.search.is).toContain('waiting');
  });

  it('sends the parked sessions parkedLimit hides as the lane hidden ones, newest first, and still counts them', () => {
    const parked = [1, 2, 3].map((i) => card(`p${i}`, { state: 'parked', updatedAt: 1000 - i, cwd: '/w' }));
    const board = buildBoard(parked, [], { ...opts, parkedLimit: 1 });
    const lane = board.lanes.find((l) => l.sessions.some((s) => s.id === 'p1'))!;
    expect(lane.sessions.map((s) => s.id)).toEqual(['p1']);
    expect(lane.hidden!.map((s) => s.id)).toEqual(['p2', 'p3']);
    expect(lane.more).toBe(2);
    expect(lane.hidden![0].search.is).toContain('parked');
  });

  it('sends at most HIDDEN_PARKED_MAX hidden parked sessions', () => {
    const parked = Array.from({ length: HIDDEN_PARKED_MAX + 5 }, (_, i) => card(`p${i}`, { state: 'parked', updatedAt: 100_000 - i, cwd: '/w' }));
    const board = buildBoard(parked, [], { ...opts, parkedLimit: 0 });
    const lane = board.lanes.find((l) => l.hidden?.length)!;
    expect(lane.hidden!.length).toBe(HIDDEN_PARKED_MAX);
    expect(lane.more).toBe(HIDDEN_PARKED_MAX + 5);
  });
});

describe('buildBoard: colors given by hand', () => {
  it('gives each colored session its color, and the others none', () => {
    const board = buildBoard([card('a'), card('b')], [], { ...opts, colors: new Map([['a', 'purple']]) });
    const sessions = board.lanes.flatMap((l) => l.sessions);
    expect(sessions.find((s) => s.id === 'a')?.color).toBe('purple');
    expect(sessions.find((s) => s.id === 'b')).not.toHaveProperty('color');
  });
});
