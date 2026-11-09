import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildrenReader, limitFinished, runningCount, type SessionChild, TranscriptScan } from '../src/core/sessionChildren';

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
