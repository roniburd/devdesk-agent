import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../src/core/json';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildrenReader, limitFinished, runningBackground, runningCount, type SessionChild, TranscriptScan } from '../src/core/sessionChildren';

const T = '2026-10-29T10:00:00.000Z';
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const use = (id: string, name: string, input: Record<string, unknown>) =>
  line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, toolUseResult: unknown, text = '', isError = false) =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] }, toolUseResult });
const reply = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const notify = (body: string) => line({ type: 'user', message: { content: `<task-notification>\n${body}\n</task-notification>` } });

const agentLaunch = (id: string, agentId: string, description: string, type = 'Explore') =>
  use(id, 'Agent', { description, subagent_type: type, prompt: 'p', run_in_background: true }) +
  result(id, { isAsync: true, status: 'async_launched', agentId, description });
const shellLaunch = (id: string, taskId: string, description: string) =>
  use(id, 'Bash', { command: 'npm test', description, run_in_background: true }) +
  result(id, { stdout: '', backgroundTaskId: taskId }, `Command running in background with ID: ${taskId}. Output is being written to: /tmp/t/${taskId}.output. You will be notified.`);

/** The reader as it was before it kept anything: reads every file whole on each call. */
async function reference(transcript: string, options: { finishedLimit: number; live: boolean }): Promise<SessionChild[]> {
  const sessionDir = transcript.replace(/\.jsonl$/, '');
  const scanned = new Map<string, TranscriptScan>();
  const scan = async (file: string) => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return scanned.get(file);
    }
    const s = new TranscriptScan();
    s.feed(text);
    scanned.set(file, s);
    return s;
  };
  const STATES: Record<string, SessionChild['state']> = { completed: 'done', done: 'done', failed: 'failed', error: 'failed', cancelled: 'stopped', canceled: 'stopped', stopped: 'stopped', killed: 'stopped', running: 'running', queued: 'running' };
  const stopAll = (n: SessionChild): void => {
    if (n.state === 'running') n.state = 'stopped';
    n.children.forEach(stopAll);
  };
  type WfAgent = { agentId?: string; label: string; phase: string; state: SessionChild['state']; startedAt?: number };
  const byPhase = (id: string, agents: WfAgent[], dir: string): SessionChild[] => {
    const phases = new Map<string, SessionChild>();
    for (const a of agents) {
      let phase = phases.get(a.phase);
      if (!phase) phases.set(a.phase, (phase = { id: `${id}/phase:${a.phase}`, kind: 'phase', label: a.phase || 'Agents', state: 'done', background: true, children: [] }));
      phase.children.push({ id: `${id}/agent:${a.agentId ?? a.label}`, kind: 'agent', label: a.label, detail: 'workflow agent', state: a.state, startedAt: a.startedAt, background: true, file: a.agentId ? join(dir, `agent-${a.agentId}.jsonl`) : undefined, children: [] });
    }
    for (const p of phases.values()) {
      const cs = p.children;
      p.state = cs.some((c) => c.state === 'running') ? 'running' : cs.some((c) => c.state === 'failed') ? 'failed' : cs.some((c) => c.state === 'stopped') ? 'stopped' : 'done';
      p.children = limitFinished(p.children, options.finishedLimit);
    }
    return [...phases.values()];
  };
  const under = async (file: string, depth: number): Promise<SessionChild[]> => {
    const s = await scan(file);
    if (!s) return [];
    const children = await Promise.all(
      s.list().map(async (l) => {
        const base: SessionChild = { id: l.id, kind: l.kind, label: l.label, detail: l.detail, state: l.state, startedAt: l.startedAt, background: l.background, children: [] };
        if (l.kind === 'shell') base.file = l.outputPath;
        else if (l.kind === 'agent' && l.agentId) {
          const f = join(sessionDir, 'subagents', `agent-${l.agentId}.jsonl`);
          base.file = f;
          if (depth < 4) base.children = await under(f, depth + 1);
          const meta = await readJson(f.replace(/\.jsonl$/, '.meta.json'));
          if (base.state === 'running' && (meta?.finished === true || scanned.get(f)?.finished === true)) base.state = 'done';
        } else if (l.kind === 'workflow' && l.runId) {
          const dir = join(sessionDir, 'subagents', 'workflows', l.runId);
          const summaryPath = join(sessionDir, 'workflows', `${l.runId}.json`);
          const summary = await readJson(summaryPath);
          if (summary) {
            base.file = summaryPath;
            if (base.state === 'running') base.state = STATES[String(summary.status)] ?? 'running';
            const progress = Array.isArray(summary.workflowProgress) ? (summary.workflowProgress as Record<string, unknown>[]) : [];
            const agents = progress
              .filter((p) => p && p.type === 'workflow_agent')
              .map((p) => ({ agentId: typeof p.agentId === 'string' ? p.agentId : undefined, label: String(p.label ?? 'agent'), phase: String(p.phaseTitle ?? ''), state: STATES[String(p.state)] ?? (base.state === 'running' ? 'running' : 'stopped'), startedAt: typeof p.startedAt === 'number' ? p.startedAt : undefined }));
            base.children = byPhase(base.id, agents, dir);
          } else {
            base.file = l.scriptPath;
            const names = await readdir(dir).catch(() => undefined);
            if (names) {
              const agents = await Promise.all(
                names
                  .filter((n) => n.endsWith('.meta.json'))
                  .map(async (n) => {
                    const agentId = n.slice('agent-'.length, -'.meta.json'.length);
                    const f = join(dir, `agent-${agentId}.jsonl`);
                    const [meta, sc, info] = await Promise.all([readJson(join(dir, n)), scan(f), stat(f).catch(() => undefined)]);
                    const state: SessionChild['state'] = meta?.finished === true || sc?.finished === true ? 'done' : 'running';
                    return { agentId, label: typeof meta?.description === 'string' ? meta.description : agentId, phase: typeof meta?.workflowPhase === 'string' ? meta.workflowPhase : '', state, startedAt: info?.birthtimeMs };
                  }),
              );
              agents.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
              base.children = byPhase(base.id, agents, dir);
            }
          }
        }
        if (!options.live) stopAll(base);
        return base;
      }),
    );
    return limitFinished(children, options.finishedLimit);
  };
  return under(transcript, 0);
}

const flat = (cs: SessionChild[], d = 0): string[] =>
  cs.flatMap((c) => [`${'  '.repeat(d)}${c.kind}:${c.label}:${c.state}`, ...flat(c.children, d + 1)]);

describe('TranscriptScan', () => {
  it('keeps a partial last line for the next chunk', () => {
    const s = new TranscriptScan();
    const text = agentLaunch('t1', 'a1', 'Look around');
    s.feed(text.slice(0, 40));
    expect(s.list()).toEqual([]);
    s.feed(text.slice(40));
    expect(s.list()).toMatchObject([{ id: 't1', kind: 'agent', label: 'Look around', detail: 'Explore', agentId: 'a1', background: true, state: 'running' }]);
  });

  it('ignores foreground Bash and malformed lines', () => {
    const s = new TranscriptScan();
    s.feed(`not json\n${use('t1', 'Bash', { command: 'ls' })}${use('t2', 'Read', { file_path: '/x' })}`);
    expect(s.list()).toEqual([]);
  });

  it('marks a foreground agent done when its result arrives', () => {
    const s = new TranscriptScan();
    s.feed(use('t1', 'Agent', { description: 'Fg', prompt: 'p' }) + result('t1', { status: 'completed', agentId: 'a1' }));
    expect(s.list()[0]).toMatchObject({ state: 'done', background: false, agentId: 'a1' });
  });

  it('reads notification statuses by tool use id or task id', () => {
    const s = new TranscriptScan();
    s.feed(
      shellLaunch('t1', 'b1', 'Tests') +
        shellLaunch('t2', 'b2', 'Server') +
        agentLaunch('t3', 'a3', 'Research') +
        notify('<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<status>failed</status>') +
        notify('<task-id>b2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>') +
        line({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification><tool-use-id>t3</tool-use-id><status>completed</status></task-notification>' } }),
    );
    expect(s.list().map((l) => [l.label, l.state, l.outputPath])).toEqual([
      ['Tests', 'failed', '/tmp/t/b1.output'],
      ['Server', 'stopped', '/tmp/t/b2.output'],
      ['Research', 'done', undefined],
    ]);
  });

  it('marks a task stopped with TaskStop (or the older KillShell) stopped, but not when stopping it failed', () => {
    const s = new TranscriptScan();
    s.feed(
      shellLaunch('t1', 'b1', 'Build') +
        shellLaunch('t2', 'b2', 'Old build') +
        shellLaunch('t3', 'b3', 'Still running') +
        use('k1', 'TaskStop', { task_id: 'b1' }) +
        result('k1', { message: 'Successfully stopped task: b1', task_id: 'b1' }, '{"message":"Successfully stopped task: b1"}') +
        use('k2', 'KillShell', { shell_id: 'b2' }) +
        result('k2', { success: true }, 'Successfully killed shell: b2') +
        use('k3', 'TaskStop', { task_id: 'b3' }) +
        result('k3', undefined, 'No task found with ID: b3', true),
    );
    expect(s.list().map((l) => [l.label, l.state])).toEqual([
      ['Build', 'stopped'],
      ['Old build', 'stopped'],
      ['Still running', 'running'],
    ]);
  });

  it('lists a ! command that moved to the background, and only then', () => {
    const s = new TranscriptScan();
    const bang = (content: string) => line({ type: 'user', timestamp: T, message: { role: 'user', content } });
    s.feed(
      bang('<bash-input> ls</bash-input>') +
        bang('<bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>') +
        bang('<bash-input> bash cleanup.sh</bash-input>') +
        bang(
          '<bash-stdout>step 1\nCommand did not complete within its 120s timeout and was moved to the background (ID: b5s7). Output is being written to: /tmp/t/b5s7.output. You will be notified when it completes.</bash-stdout><bash-stderr></bash-stderr>',
        ),
    );
    expect(s.list()).toMatchObject([
      { id: 'bang:b5s7', kind: 'shell', label: 'bash cleanup.sh', detail: 'bash cleanup.sh', taskId: 'b5s7', outputPath: '/tmp/t/b5s7.output', background: true, state: 'running' },
    ]);
    s.feed(notify('<task-id>b5s7</task-id>\n<status>completed</status>'));
    expect(s.list()[0].state).toBe('done');
  });

  it('does not read notifications quoted inside tool results', () => {
    const s = new TranscriptScan();
    s.feed(shellLaunch('t1', 'b1', 'Tests') + result('x', {}, '<task-notification><tool-use-id>t1</tool-use-id><status>failed</status></task-notification>'));
    expect(s.list()[0].state).toBe('running');
  });

  it('tracks whether an agent transcript ends on a reply', () => {
    const s = new TranscriptScan();
    s.feed(reply('thinking'));
    s.feed(use('t1', 'Read', {}));
    expect(s.finished).toBe(false);
    s.feed(result('t1', {}) + reply('All done'));
    expect(s.finished).toBe(true);
    s.feed(use('t2', 'Read', {}));
    expect(s.finished).toBe(false);
    s.feed(line({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } }));
    expect(s.finished).toBe(true);
  });

  it('does not take a reply that goes on to a tool call for the end of the agent', () => {
    const s = new TranscriptScan();
    // Claude Code writes each content block on its own line: the text, then (once streamed) the tool call.
    s.feed(line({ type: 'assistant', message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Running the tests' }] } }));
    expect(s.finished).toBe(false);
    s.feed(use('t1', 'Bash', { command: 'npm test' }));
    expect(s.finished).toBe(false);
    s.feed(result('t1', {}) + line({ type: 'assistant', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All done' }] } }));
    expect(s.finished).toBe(true);
  });
});

describe('ChildrenReader', () => {
  let dir: string;
  let transcript: string;
  let session: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devdesk-children-'));
    transcript = join(dir, 's1.jsonl');
    session = join(dir, 's1');
    await mkdir(join(session, 'subagents'), { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const opts = { finishedLimit: 10, live: true };

  it('nests agents of agents and their shells, and reads only what was appended', async () => {
    await writeFile(transcript, agentLaunch('t1', 'a1', 'Parent agent', 'general-purpose') + shellLaunch('t2', 'b2', 'Dev server'));
    await writeFile(join(session, 'subagents', 'agent-a1.jsonl'), agentLaunch('u1', 'a2', 'Child agent') + shellLaunch('u2', 'b3', 'Child tests'));
    await writeFile(join(session, 'subagents', 'agent-a2.jsonl'), reply('found it'));
    const reader = new ChildrenReader();
    const tree = await reader.read(transcript, opts);
    expect(flat(tree)).toEqual([
      'agent:Parent agent:running',
      '  agent:Child agent:done',
      '  shell:Child tests:running',
      'shell:Dev server:running',
    ]);
    expect(tree[0].file).toBe(join(session, 'subagents', 'agent-a1.jsonl'));
    expect(tree[1].file).toBe('/tmp/t/b2.output');
    expect(runningCount(tree)).toBe(3);

    await appendFile(transcript, notify('<tool-use-id>t2</tool-use-id><status>completed</status>'));
    await writeFile(join(session, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ description: 'Parent agent', finished: true }));
    expect(flat(await reader.read(transcript, opts))).toEqual([
      'agent:Parent agent:done',
      '  agent:Child agent:done',
      '  shell:Child tests:running',
      'shell:Dev server:done',
    ]);
  });

  it('shows nothing it started as running once the session is gone', async () => {
    await writeFile(transcript, shellLaunch('t1', 'b1', 'Server'));
    expect(flat(await new ChildrenReader().read(transcript, { ...opts, live: false }))).toEqual(['shell:Server:stopped']);
  });

  it('shows what an earlier Claude process started as stopped once the session resumed', async () => {
    const later = (id: string, taskId: string, description: string) =>
      shellLaunch(id, taskId, description).replace(T, '2026-10-29T12:00:00.000Z');
    await writeFile(transcript, shellLaunch('t1', 'b1', 'Before') + agentLaunch('t2', 'a2', 'Old agent') + later('t3', 'b3', 'After'));
    const since = Date.parse('2026-10-29T11:00:00.000Z');
    expect(flat(await new ChildrenReader().read(transcript, { ...opts, since }))).toEqual([
      'shell:Before:stopped',
      'agent:Old agent:stopped',
      'shell:After:running',
    ]);
    // A record from an older hook script has no start: nothing changes.
    expect(flat(await new ChildrenReader().read(transcript, opts)).filter((c) => c.endsWith('running'))).toHaveLength(3);
  });

  describe('with the hooks roster', () => {
    it('shows a subagent the roster says stopped as done at once, and the transcript alone without a roster', async () => {
      await writeFile(transcript, agentLaunch('t1', 'a1', 'Background agent') + agentLaunch('t2', 'a2', 'Other agent'));
      await writeFile(join(session, 'subagents', 'agent-a1.jsonl'), use('x', 'Read', { file_path: '/a' }));
      const reader = new ChildrenReader();
      // The fallback: no roster (an older hook script or Claude Code), so the transcript says both still run.
      expect(flat(await reader.read(transcript, opts))).toEqual(['agent:Background agent:running', 'agent:Other agent:running']);
      const roster = { a1: { type: 'Explore', startedAt: 1, runningSince: 1, stoppedAt: 2 }, a2: { type: 'Explore', startedAt: 1, runningSince: 1 } };
      const tree = await reader.read(transcript, { ...opts, roster });
      expect(flat(tree)).toEqual(['agent:Background agent:done', 'agent:Other agent:running']);
      expect(runningBackground(tree)).toBe(true);
      // The last one stops: nothing runs in the background any more, though no notification reached the transcript.
      const done = await reader.read(transcript, { ...opts, roster: { ...roster, a2: { ...roster.a2, stoppedAt: 3 } } });
      expect(flat(done)).toEqual(['agent:Background agent:done', 'agent:Other agent:done']);
      expect(runningBackground(done)).toBe(false);
    });

    it('keeps a failed or stopped state the transcript shows, and an agent the transcript shows finished stays finished', async () => {
      await writeFile(transcript, agentLaunch('t1', 'a1', 'Killed') + agentLaunch('t2', 'a2', 'Finished'));
      await appendFile(transcript, notify('<tool-use-id>t1</tool-use-id><status>killed</status>') + notify('<tool-use-id>t2</tool-use-id><status>completed</status>'));
      // a1 stopped (killed, not done); no SubagentStop came for a2 (the hook missed it): the transcript's states stand.
      const roster = { a1: { startedAt: 1, stoppedAt: 2 }, a2: { startedAt: 1 } };
      expect(flat(await new ChildrenReader().read(transcript, { ...opts, roster }))).toEqual(['agent:Killed:stopped', 'agent:Finished:done']);
    });

    it('shows a resumed subagent running, and an idle teammate idle and never folded away', async () => {
      await writeFile(transcript, agentLaunch('t1', 'a1', 'Resumed') + agentLaunch('t2', 'a2', 'Teammate') + agentLaunch('t3', 'a3', 'Done'));
      await appendFile(transcript, notify('<tool-use-id>t1</tool-use-id><status>completed</status>') + notify('<tool-use-id>t3</tool-use-id><status>completed</status>'));
      const roster = { a1: { startedAt: 1, runningSince: 5, resumed: true }, a2: { name: 'helper', startedAt: 1, idleAt: 4 } };
      const tree = await new ChildrenReader().read(transcript, { finishedLimit: 0, live: true, roster });
      expect(flat(tree)).toEqual(['more:1 earlier finished:done', 'agent:Resumed:running', 'agent:Teammate:idle']);
      expect(runningCount(tree)).toBe(1);
      // Once the session is gone, nothing runs or waits.
      expect(flat(await new ChildrenReader().read(transcript, { ...opts, live: false, roster }))).toEqual(['agent:Resumed:stopped', 'agent:Teammate:stopped', 'agent:Done:done']);
    });

    it('trusts the roster of the running Claude process over an older launch time', async () => {
      await writeFile(transcript, agentLaunch('t1', 'a1', 'Old agent') + agentLaunch('t2', 'a2', 'Resumed now'));
      await appendFile(transcript, notify('<tool-use-id>t2</tool-use-id><status>completed</status>'));
      const since = Date.parse('2026-10-29T11:00:00.000Z');
      const roster = { a2: { startedAt: since + 1, runningSince: since + 1, resumed: true } };
      expect(flat(await new ChildrenReader().read(transcript, { ...opts, since, roster }))).toEqual(['agent:Old agent:stopped', 'agent:Resumed now:running']);
    });
  });

  it('groups a finished workflow by phase from its summary', async () => {
    await writeFile(
      transcript,
      use('w1', 'Workflow', { script: 'x' }) +
        result('w1', { status: 'async_launched', taskId: 'wt', runId: 'wf_1', workflowName: 'review-changes', summary: 'Review and verify' }),
    );
    await mkdir(join(session, 'workflows'));
    await writeFile(
      join(session, 'workflows', 'wf_1.json'),
      JSON.stringify({
        status: 'completed',
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: 'Review' },
          { type: 'workflow_agent', label: 'review:bugs', phaseTitle: 'Review', agentId: 'x1', state: 'done' },
          { type: 'workflow_agent', label: 'review:perf', phaseTitle: 'Review', agentId: 'x2', state: 'failed' },
          { type: 'workflow_agent', label: 'verify:1', phaseTitle: 'Verify', agentId: 'x3', state: 'done' },
        ],
      }),
    );
    const tree = await new ChildrenReader().read(transcript, opts);
    expect(flat(tree)).toEqual([
      'workflow:review-changes:done',
      '  phase:Review:failed',
      '    agent:review:bugs:done',
      '    agent:review:perf:failed',
      '  phase:Verify:done',
      '    agent:verify:1:done',
    ]);
    expect(tree[0].children[0].children[0].file).toBe(join(session, 'subagents', 'workflows', 'wf_1', 'agent-x1.jsonl'));
  });

  it('lists a running workflow from the agents written so far', async () => {
    await writeFile(transcript, use('w1', 'Workflow', { script: 'x' }) + result('w1', { status: 'async_launched', runId: 'wf_2', workflowName: 'impl' }));
    const agents = join(session, 'subagents', 'workflows', 'wf_2');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'agent-p.meta.json'), JSON.stringify({ description: 'implement:1', workflowPhase: 'Implement' }));
    await writeFile(join(agents, 'agent-p.jsonl'), reply('done'));
    await writeFile(join(agents, 'agent-q.meta.json'), JSON.stringify({ description: 'review:1', workflowPhase: 'Implement' }));
    await writeFile(join(agents, 'agent-q.jsonl'), use('r', 'Read', {}));
    expect(flat(await new ChildrenReader().read(transcript, opts))).toEqual([
      'workflow:impl:running',
      '  phase:Implement:running',
      '    agent:implement:1:done',
      '    agent:review:1:running',
    ]);
  });

  it('gives the same trees, keeping finished subtrees, as reading every file whole each time, while the transcripts grow', async () => {
    const sub = (id: string) => join(session, 'subagents', `agent-${id}.jsonl`);
    const fg = (id: string, agentId: string, description: string) =>
      use(id, 'Agent', { description, subagent_type: 'Explore', prompt: 'p' }) + result(id, { status: 'completed', agentId });
    const steps: (() => Promise<unknown>)[] = [
      () => writeFile(transcript, agentLaunch('t1', 'a1', 'Parent') + shellLaunch('t2', 'b2', 'Server')),
      () => writeFile(sub('a1'), agentLaunch('u1', 'a2', 'Child') + shellLaunch('u2', 'b3', 'Child tests')),
      () => writeFile(sub('a2'), use('r1', 'Read', {})),
      () => appendFile(sub('a2'), result('r1', {}) + reply('found it')),
      async () => {
        for (const n of [3, 4, 5, 6, 7]) {
          await writeFile(sub(`f${n}`), shellLaunch(`v${n}`, `c${n}`, `Inner ${n}`) + notify(`<tool-use-id>v${n}</tool-use-id><status>completed</status>`) + reply('ok'));
          await appendFile(transcript, fg(`t${n}`, `f${n}`, `Done ${n}`));
        }
      },
      () => appendFile(sub('a1'), notify('<tool-use-id>u2</tool-use-id><status>completed</status>') + reply('all done')),
      () => appendFile(transcript, notify('<tool-use-id>t2</tool-use-id><status>completed</status>')),
      () => writeFile(join(session, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ description: 'Parent', finished: true })),
      () => appendFile(transcript, use('w1', 'Workflow', { script: 'x' }) + result('w1', { status: 'async_launched', runId: 'wf_1', workflowName: 'impl' })),
      async () => {
        const agents = join(session, 'subagents', 'workflows', 'wf_1');
        await mkdir(agents, { recursive: true });
        await writeFile(join(agents, 'agent-p.meta.json'), JSON.stringify({ description: 'implement:1', workflowPhase: 'Implement' }));
        await writeFile(join(agents, 'agent-p.jsonl'), use('r', 'Read', {}));
      },
      async () => {
        await mkdir(join(session, 'workflows'), { recursive: true });
        await writeFile(
          join(session, 'workflows', 'wf_1.json'),
          JSON.stringify({ status: 'completed', workflowProgress: [{ type: 'workflow_agent', label: 'implement:1', phaseTitle: 'Implement', agentId: 'p', state: 'done' }] }),
        );
      },
      // The finished parent agent is resumed: its transcript grows again.
      () => appendFile(sub('a1'), shellLaunch('u3', 'b4', 'Resumed build')),
      () => appendFile(sub('a1'), notify('<tool-use-id>u3</tool-use-id><status>failed</status>') + reply('done again')),
      () => appendFile(transcript, notify('<tool-use-id>t1</tool-use-id><status>failed</status>')),
      () => appendFile(transcript, fg('t8', 'f8', 'Done 8')),
    ];
    const limits = [0, 1, 2, 10];
    const kept = new Map(limits.map((l) => [l, new ChildrenReader()]));
    for (const step of steps) {
      await step();
      for (const finishedLimit of limits) {
        for (const live of [true, false, true]) {
          const reader = kept.get(finishedLimit)!;
          const cached = await reader.read(transcript, { finishedLimit, live });
          reader.prune();
          expect(cached).toStrictEqual(await reference(transcript, { finishedLimit, live }));
          expect(await new ChildrenReader().read(transcript, { finishedLimit, live })).toStrictEqual(cached);
          // Read twice: the second read comes from what was kept.
          expect(await reader.read(transcript, { finishedLimit, live })).toStrictEqual(cached);
          reader.prune();
        }
      }
    }
    expect(flat(await kept.get(10)!.read(transcript, opts))).toContain('  shell:Resumed build:failed');
  });

  it('reads a finished subtree once, and a gone session once until its transcript grows', async () => {
    await writeFile(transcript, agentLaunch('t1', 'a1', 'Parent'));
    await writeFile(join(session, 'subagents', 'agent-a1.jsonl'), shellLaunch('u1', 'b1', 'Inner') + notify('<tool-use-id>u1</tool-use-id><status>completed</status>') + reply('done'));
    await appendFile(transcript, notify('<tool-use-id>t1</tool-use-id><status>completed</status>'));
    const reader = new ChildrenReader();
    const first = await reader.read(transcript, opts);
    expect(flat(first)).toEqual(['agent:Parent:done', '  shell:Inner:done']);
    expect((await reader.read(transcript, opts))[0]).toBe(first[0]);
    const gone = await reader.read(transcript, { ...opts, live: false });
    expect(await reader.read(transcript, { ...opts, live: false })).toBe(gone);
    await appendFile(transcript, shellLaunch('t2', 'b2', 'Later'));
    expect(flat(await reader.read(transcript, { ...opts, live: false }))).toEqual(['agent:Parent:done', '  shell:Inner:done', 'shell:Later:stopped']);
  });

  it('returns nothing for a missing transcript', async () => {
    expect(await new ChildrenReader().read(join(dir, 'gone.jsonl'), opts)).toEqual([]);
  });
});

describe('limitFinished', () => {
  const c = (id: string, state: SessionChild['state']): SessionChild => ({ id, kind: 'agent', label: id, state, background: true, children: [] });
  it('keeps running children and the latest finished ones', () => {
    const out = limitFinished([c('a', 'done'), c('b', 'running'), c('c', 'failed'), c('d', 'done')], 2);
    expect(out.map((x) => `${x.kind}:${x.label}`)).toEqual(['more:1 earlier finished', 'agent:b', 'agent:c', 'agent:d']);
  });
  it('leaves short lists alone', () => {
    const list = [c('a', 'done')];
    expect(limitFinished(list, 1)).toBe(list);
  });
});

describe('runningBackground', () => {
  const c = (id: string, kind: SessionChild['kind'], state: SessionChild['state'], background = true, children: SessionChild[] = []): SessionChild => ({ id, kind, label: id, state, background, children });
  it('finds running background work at any depth', () => {
    expect(runningBackground([c('a', 'agent', 'done'), c('w', 'workflow', 'running')])).toBe(true);
    expect(runningBackground([c('s', 'shell', 'running')])).toBe(true);
    expect(runningBackground([c('w', 'workflow', 'running', true, [c('p', 'phase', 'running', false, [c('x', 'agent', 'running', false)])])])).toBe(true);
  });
  it('ignores foreground children and finished work', () => {
    expect(runningBackground([c('f', 'agent', 'running', false), c('w', 'workflow', 'done'), c('m', 'more', 'done')])).toBe(false);
  });
});
