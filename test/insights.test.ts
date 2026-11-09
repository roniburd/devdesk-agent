import { describe, expect, it } from 'vitest';
import {
  withInsight,
  buildExcerpt,
  earlierPromptsPart,
  firstPrompts,
  freshInsights,
  latestPrompt,
  insightDue,
  insightFileName,
  ledgerLine,
  mergeAnswer,
  parseAnswer,
  parseCallOutput,
  parseInsight,
} from '../src/core/insights';
import type { SessionCard } from '../src/core/sessions';

const card = (o: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  sessionId: 's1',
  transcriptPath: '/t/s1.jsonl',
  state: 'working',
  detail: 'Running Bash',
  attached: false,
  turnStartedAt: 100,
  ...o,
});

describe('insightDue', () => {
  it('asks once per finished turn', () => {
    let done = card({ state: 'done', turnEndedAt: 200 });
    expect(insightDue(done, undefined, 1000, 45_000, 10)).toBe('done');
    expect(insightDue(done, { doneFor: 200, title: 'Fix parser', objectiveAsked: true }, 1000, 45_000, 10)).toBeUndefined();
    // Answered before insights had objectives: asked once more.
    expect(insightDue(done, { doneFor: 200, title: 'Fix parser' }, 1000, 45_000, 10)).toBe('done');
    // Answered before insights had titles: asked once more, unless that answer had none either.
    expect(insightDue(done, { doneFor: 200 }, 1000, 45_000, 10)).toBe('done');
    expect(insightDue(done, mergeAnswer({ doneFor: 200 }, 'done', 200, { waitingForUser: false }, 1000, 10), 1000, 45_000, 10)).toBeUndefined();
    expect(insightDue(done, { doneFor: 150 }, 1000, 45_000, 10)).toBe('done');
    // An older hook script's record: its last update stands for the end.
    let old = card({ state: 'done', updatedAt: 180 });
    expect(insightDue(old, { doneFor: 180, title: 'Old', objectiveAsked: true }, 1000, 45_000, 10)).toBeUndefined();
    let asked = card({ state: 'done', updatedAt: 180 });
    asked = withInsight(asked, { doneFor: 180, waitingForUser: true });
    expect(asked.asksQuestion).toBe(true);
  });

  it('asks a new working turn right away, then after new activity at most every refresh', () => {
    const w = card();
    expect(insightDue(w, undefined, 1000, 45_000, 10)).toBe('status');
    expect(insightDue(w, { statusFor: 50, statusAt: 900, bytes: 10 }, 1000, 45_000, 10)).toBe('status');
    const fresh = { statusFor: 100, statusAt: 1000, bytes: 10 };
    expect(insightDue(w, fresh, 30_000, 45_000, 20)).toBeUndefined(); // too soon
    expect(insightDue(w, fresh, 50_000, 45_000, 10)).toBeUndefined(); // nothing new
    expect(insightDue(w, fresh, 50_000, 45_000, 20)).toBe('status');
  });

  it('leaves other states and sessions without a transcript alone', () => {
    expect(insightDue(card({ state: 'idle' }), undefined, 0, 1, 1)).toBeUndefined();
    expect(insightDue(card({ transcriptPath: undefined }), undefined, 0, 1, 1)).toBeUndefined();
    // An older hook script: no turn times.
    expect(insightDue(card({ turnStartedAt: undefined }), undefined, 0, 1, 1)).toBeUndefined();
  });
});

describe('asks about a wait', () => {
  it('asks once per wait for the user, keyed by its record time', () => {
    const w = card({ state: 'waiting', updatedAt: 300, detail: 'Claude needs your permission to use Bash' });
    expect(insightDue(w, undefined, 1000, 45_000, 10)).toBe('ask');
    expect(insightDue(w, { askFor: 300 }, 1000, 45_000, 10)).toBeUndefined();
    expect(insightDue(card({ state: 'waiting', updatedAt: 400 }), { askFor: 300 }, 1000, 45_000, 10)).toBe('ask');
  });

  it('shows the ask only while that wait lasts, and the title always', () => {
    const insight = mergeAnswer({ summary: 'old' }, 'ask', 300, { ask: 'Allow npm uninstall aws-sdk?', title: 'Upgrade to SDK v3', waitingForUser: true }, 1000, 50);
    expect(insight).toMatchObject({ askFor: 300, ask: 'Allow npm uninstall aws-sdk?', title: 'Upgrade to SDK v3', summary: 'old' });
    let waiting = card({ state: 'waiting', updatedAt: 300 });
    waiting = withInsight(waiting, insight);
    expect([waiting.askSummary, waiting.insightTitle]).toEqual(['Allow npm uninstall aws-sdk?', 'Upgrade to SDK v3']);
    let later = card({ state: 'waiting', updatedAt: 400 });
    later = withInsight(later, insight);
    expect(later.askSummary).toBeUndefined();
    let working = card({ updatedAt: 300 });
    working = withInsight(working, insight);
    expect([working.askSummary, working.insightTitle]).toEqual([undefined, 'Upgrade to SDK v3']);
    // A wait answered with nothing to ask drops the last one.
    expect(mergeAnswer(insight, 'ask', 400, { waitingForUser: true }, 1000, 50)).not.toHaveProperty('ask');
  });

  it('keeps the title and the ask through the insight file, trimmed', () => {
    const parsed = parseInsight(JSON.stringify({ title: `  Raise   login timeout ${'x'.repeat(60)}`, ask: 'Allow?', askFor: 3 }))!;
    expect(parsed.title!.length).toBeLessThanOrEqual(40);
    expect(parsed.title!.startsWith('Raise login timeout')).toBe(true);
    expect([parsed.ask, parsed.askFor]).toEqual(['Allow?', 3]);
    expect(parseAnswer('{"title":"Raise login timeout.","ask":"","waitingForUser":false}')).toEqual({ title: 'Raise login timeout', waitingForUser: false });
  });

  it("puts AskUserQuestion's questions in the excerpt", () => {
    const excerpt = buildExcerpt([
      JSON.stringify({ type: 'user', message: { content: 'paginate search' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Cursor or page numbers?' }, { question: 'Page size?' }] } }] } }),
    ]);
    expect(excerpt).toContain('- AskUserQuestion Cursor or page numbers? / Page size?');
  });
});

describe('withInsight', () => {
  it('shows the status only for the turn it is about, while working', () => {
    let c = card();
    c = withInsight(c, { statusFor: 100, status: 'Running tests', summary: 'Parser fixed' });
    expect(c).toMatchObject({ liveStatus: 'Running tests', insightSummary: 'Parser fixed' });
    let old = card({ turnStartedAt: 300 });
    old = withInsight(old, { statusFor: 100, status: 'Running tests' });
    expect(old.liveStatus).toBeUndefined();
    let done = card({ state: 'done', turnEndedAt: 200 });
    done = withInsight(done, { statusFor: 100, status: 'Running tests' });
    expect(done.liveStatus).toBeUndefined();
  });

  it("overrides the hook's question mark only for the finished turn it read", () => {
    let asked = card({ state: 'done', turnEndedAt: 200 });
    asked = withInsight(asked, { doneFor: 200, waitingForUser: true });
    expect(asked.asksQuestion).toBe(true);
    let rhetorical = card({ state: 'done', turnEndedAt: 200, asksQuestion: true });
    rhetorical = withInsight(rhetorical, { doneFor: 200, waitingForUser: false });
    expect(rhetorical.asksQuestion).toBeUndefined();
    let later = card({ state: 'done', turnEndedAt: 300, asksQuestion: true });
    later = withInsight(later, { doneFor: 200, waitingForUser: false });
    expect(later.asksQuestion).toBe(true);
    let parked = card({ state: 'parked', lastState: 'done', turnEndedAt: 200 });
    parked = withInsight(parked, { doneFor: 200, waitingForUser: true });
    expect(parked.asksQuestion).toBe(true);
  });
});

describe('insight files', () => {
  it('parses only well-formed fields and trims long text', () => {
    expect(parseInsight('nope')).toBeUndefined();
    const i = parseInsight(JSON.stringify({ statusFor: 1, status: `  ${'x'.repeat(200)} `, waitingForUser: 'yes', doneFor: 'a', summary: 'ok' }));
    expect(i).toEqual({ statusFor: 1, status: `${'x'.repeat(79)}…`, summary: 'ok' });
  });

  it('merges an answer into the turn it is for', () => {
    const answer = { status: 'Editing', summary: 'Half done', waitingForUser: true };
    expect(mergeAnswer({ doneFor: 5, waitingForUser: false }, 'status', 100, answer, 1000, 42)).toEqual({
      doneFor: 5,
      waitingForUser: false,
      statusFor: 100,
      statusAt: 1000,
      status: 'Editing',
      summary: 'Half done',
      summaryAt: 1000,
      untitled: true,
      objectiveAsked: true,
      bytes: 42,
    });
    expect(mergeAnswer({ statusFor: 100, status: 'Editing' }, 'done', 200, { waitingForUser: true }, 2000, 50)).toEqual({
      statusFor: 100,
      status: 'Editing',
      doneFor: 200,
      waitingForUser: true,
      untitled: true,
      objectiveAsked: true,
      bytes: 50,
    });
  });

  it('only names plain session ids', () => {
    expect(insightFileName('3f2a-b_c', 'json')).toBe('3f2a-b_c.json');
    expect(insightFileName('../x', 'lock')).toBeUndefined();
  });
});

describe('buildExcerpt', () => {
  const line = (o: unknown) => JSON.stringify(o);
  it('reports the latest prompt, the tools since and the end of the reply', () => {
    const excerpt = buildExcerpt([
      line({ type: 'user', message: { content: 'old task' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] } }),
      line({ type: 'user', message: { content: 'fix the parser' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'user', message: { content: 'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] done' } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent words' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tests pass. Should I release?' }] } }),
      'not json',
    ]);
    expect(excerpt).toContain('Task from the user:\nfix the parser');
    expect(excerpt).toContain('- Bash Run tests');
    expect(excerpt).not.toContain('Read');
    expect(excerpt).toContain("End of Claude's latest message:\nTests pass. Should I release?");
    expect(excerpt).not.toContain('subagent');
    expect(excerpt).not.toContain('hand-back');
  });

  it("uses the hook's prompt when a long turn pushed its own out of the lines read, and is empty without any", () => {
    const lines = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })];
    expect(buildExcerpt(lines)).toBe('');
    expect(buildExcerpt(lines, 'fix the parser')).toContain('Task from the user:\nfix the parser');
  });
});

describe('answers', () => {
  it('reads the JSON object, tolerating a fence', () => {
    expect(parseAnswer('```json\n{"status":"Testing","summary":"Done soon","waitingForUser":true}\n```')).toEqual({
      status: 'Testing',
      summary: 'Done soon',
      waitingForUser: true,
    });
    expect(parseAnswer('no json')).toBeUndefined();
  });

  it('reads the CLI result and its usage', () => {
    const out = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '{"status":"x","summary":"y","waitingForUser":false}',
      duration_ms: 900,
      usage: { input_tokens: 89, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 13 },
      modelUsage: { 'claude-haiku-5-5': {} },
    });
    const r = parseCallOutput(out);
    expect(r.answer).toEqual({ status: 'x', summary: 'y', waitingForUser: false });
    expect(r.usage).toEqual({ input: 89, cacheRead: 10, cacheWrite: 5, output: 13, model: 'claude-haiku-5-5', ms: 900 });
    expect(JSON.parse(ledgerLine(5, 'done', 's1', r))).toMatchObject({ at: 5, kind: 'done', sessionId: 's1', ok: true, input: 89, output: 13 });
    expect(parseCallOutput('garbage').error).toBeTruthy();
    expect(parseCallOutput(JSON.stringify({ is_error: true, result: 'auth failed' })).error).toBe('auth failed');
    expect(JSON.parse(ledgerLine(5, 'status', 's1', { error: 'x' }))).toMatchObject({ ok: false, input: 0 });
  });
});

describe('objective', () => {
  const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
  const lines = [user('Add OAuth login'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }), user('<command-name>/clear</command-name>'), user('Also migrate session storage'), user('Fix the failing test')];

  it("reads the session's first prompts and its latest", () => {
    expect(firstPrompts(lines, 2)).toEqual(['Add OAuth login', 'Also migrate session storage']);
    expect(latestPrompt(lines)).toBe('Fix the failing test');
    expect(earlierPromptsPart(firstPrompts(lines), 'Fix the failing test')).toBe(
      "The session's first prompts (oldest first):\n- Add OAuth login\n- Also migrate session storage",
    );
    // A one-prompt session has no earlier prompts.
    expect(earlierPromptsPart(['Add OAuth login'], 'Add OAuth login')).toBe('');
  });

  it('keeps the objective across answers and puts it on the card', () => {
    const answer = parseAnswer('{"title":"Fix test","objective":"Add OAuth login and migrate storage.","waitingForUser":false}')!;
    const next = mergeAnswer(undefined, 'done', 200, answer, 1000, 10);
    expect(next).toMatchObject({ objective: 'Add OAuth login and migrate storage', objectiveAsked: true });
    const kept = mergeAnswer(next, 'status', 300, { waitingForUser: false, status: 'Running tests' }, 2000, 20);
    expect(kept.objective).toBe('Add OAuth login and migrate storage');
    expect(parseInsight(JSON.stringify(kept))).toMatchObject({ objective: 'Add OAuth login and migrate storage', objectiveAsked: true });
    let c = card({ state: 'done' });
    c = withInsight(c, kept);
    expect(c.insightObjective).toBe('Add OAuth login and migrate storage');
  });
});

describe('freshInsights', () => {
  const i1 = { title: 'old' } as never;
  const i2 = { title: 'new' } as never;
  it('keeps what a refresh read while each file is still as read', () => {
    const r = {};
    const out = freshInsights(new Map([['s', { insight: i1, read: r }]]), new Map([['s', r]]), new Map([['s', i2]]));
    expect(out.insights.get('s')).toBe(i1);
    expect(out.changed).toEqual([]);
  });
  it('keeps the shown insight of a file that changed after the refresh read it, and lists it to read again', () => {
    // The watcher already showed I2 while the refresh still held I1: the refresh must not put I1 back.
    const out = freshInsights(new Map([['s', { insight: i1, read: {} }]]), new Map([['s', {}]]), new Map([['s', i2]]));
    expect(out.insights.get('s')).toBe(i2);
    expect(out.changed).toEqual(['s']);
  });
  it('uses what the refresh read for a changed file it did not show before', () => {
    const out = freshInsights(new Map([['s', { insight: i1, read: {} }]]), new Map(), new Map());
    expect(out.insights.get('s')).toBe(i1);
    expect(out.changed).toEqual(['s']);
  });
});
