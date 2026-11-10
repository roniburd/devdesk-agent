import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GrowingFiles, LineScan, parseObject, readJson } from './json';

/**
 * What a Claude session spun off, read from its transcript: subagents (and theirs), background shell commands and
 * workflows (with their phases and agents). Claude Code writes a session's transcript to `<dir>/<session>.jsonl`, its
 * subagents to `<dir>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`), workflow agents to
 * `.../subagents/workflows/<runId>/` and a finished workflow's summary to `<dir>/<session>/workflows/<runId>.json`.
 */
export type ChildKind = 'agent' | 'shell' | 'workflow' | 'phase' | 'more';
export type ChildState = 'running' | 'done' | 'failed' | 'stopped';

export interface SessionChild {
  /** Unique within the session (the launching tool use id, or derived from it). */
  id: string;
  kind: ChildKind;
  label: string;
  /** Agent type, shell command, workflow name. */
  detail?: string;
  state: ChildState;
  startedAt?: number;
  background: boolean;
  /** The agent's transcript, the shell's output file, or the workflow's summary or script. */
  file?: string;
  children: SessionChild[];
}

/** A tool call that started a child, as seen in the transcript so far. */
interface Launch {
  id: string;
  kind: 'agent' | 'shell' | 'workflow';
  label: string;
  detail?: string;
  startedAt?: number;
  background: boolean;
  state: ChildState;
  agentId?: string;
  taskId?: string;
  runId?: string;
  outputPath?: string;
  scriptPath?: string;
}

/** What one transcript says so far; fed incrementally since transcripts only grow. */
export class TranscriptScan extends LineScan {
  readonly launches = new Map<string, Launch>();
  /** Notification statuses by tool use id or task id (a notification can name only task ids). */
  private readonly statuses = new Map<string, ChildState>();
  /** TaskStop (KillShell, KillBash in older versions) calls by tool use id, with the task they stop; no notification follows them. */
  private readonly stops = new Map<string, string>();
  /** The transcript shows its (sub)agent finished: a SubagentStop hook, or a final reply after the last tool call. */
  finished = false;
  /** The last `!` command typed, until its output line arrives. */
  private bangCommand?: { command: string; startedAt?: number };

  /** The launches with their final states, in transcript order. */
  list(): Launch[] {
    return [...this.launches.values()].map((l) => {
      const status = this.statuses.get(l.id) ?? (l.taskId ? this.statuses.get(l.taskId) : undefined);
      return status && l.state === 'running' ? { ...l, state: status } : l;
    });
  }

  protected line(line: string): void {
    const o = parseObject(line);
    if (!o) return;
    const message = o.message as { content?: unknown } | undefined;
    const content = message?.content;
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : undefined;
    if (o.type === 'assistant') {
      let calls = false;
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type !== 'tool_use') continue;
        calls = true;
        this.launch(c as ToolUse, Number.isFinite(at) ? at : undefined);
      }
      // Claude Code writes one content block per line: a reply after the last tool call means the agent finished.
      if (calls) this.finished = false;
      else if (Array.isArray(content) && content.some((c) => c?.type === 'text')) this.finished = true;
      return;
    }
    const attachment = o.attachment as { type?: unknown; hookEvent?: unknown; prompt?: unknown } | undefined;
    if (attachment?.hookEvent === 'SubagentStop') this.finished = true;
    if (typeof attachment?.prompt === 'string') this.notifications(attachment.prompt);
    if (o.type === 'queue-operation' && typeof o.content === 'string') this.notifications(o.content);
    if (o.type !== 'user') return;
    if (typeof content === 'string') {
      this.bang(content, Number.isFinite(at) ? at : undefined);
      this.notifications(content);
      return;
    }
    for (const c of Array.isArray(content) ? content : []) {
      if (c?.type === 'text' && typeof c.text === 'string') this.notifications(c.text);
      if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') this.result(c as ToolResult, o.toolUseResult);
    }
  }

  private launch(c: ToolUse, startedAt: number | undefined): void {
    const input = (c.input ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    if (c.name === 'Agent' || c.name === 'Task') {
      this.launches.set(c.id, {
        id: c.id,
        kind: 'agent',
        label: str(input.description) ?? 'Agent',
        detail: str(input.subagent_type) ?? 'general-purpose',
        startedAt,
        background: input.run_in_background === true,
        state: 'running',
      });
    } else if (c.name === 'Bash' && input.run_in_background === true) {
      const command = str(input.command);
      this.launches.set(c.id, { id: c.id, kind: 'shell', label: str(input.description) ?? command ?? 'Shell', detail: command, startedAt, background: true, state: 'running' });
    } else if (c.name === 'Workflow') {
      this.launches.set(c.id, { id: c.id, kind: 'workflow', label: str(input.name) ?? 'Workflow', startedAt, background: true, state: 'running' });
    } else if (STOP_TOOLS.has(c.name)) {
      const task = str(input.task_id) ?? str(input.shell_id) ?? str(input.bash_id);
      if (task) this.stops.set(c.id, task);
    }
  }

  /**
   * A `!` command the user typed: `<bash-input>` then `<bash-stdout>`. It is a child only once it has moved to the
   * background (it ran past the Bash timeout, or the user backgrounded it); its notification names the task id.
   */
  private bang(content: string, at: number | undefined): void {
    const input = BASH_INPUT.exec(content)?.[1]?.trim();
    if (input !== undefined) {
      this.bangCommand = { command: input, startedAt: at };
      return;
    }
    if (!content.startsWith('<bash-stdout>')) return;
    const taskId = BACKGROUNDED.exec(content)?.[1];
    const { command, startedAt } = this.bangCommand ?? {};
    this.bangCommand = undefined;
    if (!taskId) return;
    const id = `bang:${taskId}`;
    const label = command || 'Shell';
    const outputPath = OUTPUT_PATH.exec(content)?.[1];
    this.launches.set(id, { id, kind: 'shell', label, detail: command, startedAt: startedAt ?? at, background: true, state: 'running', taskId, outputPath });
  }

  private result(c: ToolResult, raw: unknown): void {
    const stopped = this.stops.get(c.tool_use_id);
    if (stopped) {
      this.stops.delete(c.tool_use_id);
      if (!c.is_error) this.statuses.set(stopped, 'stopped');
      return;
    }
    const l = this.launches.get(c.tool_use_id);
    if (!l) return;
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    if (l.kind === 'shell') {
      l.taskId = str(r.backgroundTaskId);
      l.outputPath = OUTPUT_PATH.exec(resultText(c))?.[1];
      // Not backgrounded after all (for example it was rejected): nothing keeps running.
      if (!l.taskId) l.state = c.is_error ? 'failed' : 'done';
      return;
    }
    if (l.kind === 'agent') {
      l.agentId = str(r.agentId) ?? l.agentId;
      if (r.status === 'async_launched') l.background = true;
      else l.state = c.is_error ? 'failed' : 'done';
      return;
    }
    l.runId = str(r.runId);
    l.taskId = str(r.taskId);
    l.label = str(r.workflowName) ?? l.label;
    l.detail = str(r.summary);
    l.scriptPath = str(r.scriptPath);
    if (r.status !== 'async_launched') l.state = c.is_error ? 'failed' : 'done';
  }

  private notifications(text: string): void {
    if (!text.includes('<task-notification>')) return;
    for (const m of text.matchAll(NOTIFICATION)) {
      const body = m[1];
      const state = NOTIFIED_STATES[STATUS.exec(body)?.[1] ?? ''];
      if (!state) continue;
      const toolUse = TOOL_USE_ID.exec(body)?.[1];
      if (toolUse) this.statuses.set(toolUse, state);
      for (const t of body.matchAll(TASK_ID)) this.statuses.set(t[1], state);
    }
  }
}

interface ToolUse {
  id: string;
  name: string;
  input?: unknown;
}
interface ToolResult {
  tool_use_id: string;
  is_error?: boolean;
  content?: unknown;
}

const STOP_TOOLS: ReadonlySet<string> = new Set(['TaskStop', 'KillShell', 'KillBash']);
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const STATUS = /<status>([a-z_]+)<\/status>/;
const TOOL_USE_ID = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;
const TASK_ID = /<task-id>([^<\s]+)<\/task-id>/g;
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/;
const BACKGROUNDED = /moved to the background \(ID: ([^)\s]+)\)/;
const OUTPUT_PATH =/Output is being written to: (\S+?)\.?(?:\s|$)/;
const NOTIFIED_STATES: Record<string, ChildState> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' };

function resultText(c: ToolResult): string {
  if (typeof c.content === 'string') return c.content;
  if (!Array.isArray(c.content)) return '';
  return c.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
}

const WORKFLOW_STATES: Record<string, ChildState> = {
  completed: 'done',
  done: 'done',
  failed: 'failed',
  error: 'failed',
  cancelled: 'stopped',
  canceled: 'stopped',
  stopped: 'stopped',
  killed: 'stopped',
  running: 'running',
  queued: 'running',
};

export interface ChildrenOptions {
  /** Finished children shown per level (running ones are always shown); the rest collapse into one "more" row. */
  finishedLimit: number;
  /** False when the session's Claude process is gone: nothing it started can still be running. */
  live: boolean;
  /**
   * When the running Claude process started the session (a resume, or a /clear): what started before ran in an earlier
   * process, which is gone, so it cannot still be running either.
   */
  since?: number;
}

/** A child whose subtree can no longer change, kept so later refreshes skip its files (`ChildrenReader.final`). */
interface FinalChild {
  /** The launch as the transcript showed it (JSON), so a later change to it reads the child again. */
  launch: string;
  finishedLimit: number;
  depth: number;
  node: SessionChild;
  /** An agent's transcript size and mtime when it was read: it grows again if the agent is resumed. */
  size?: number;
  mtimeMs?: number;
}

/** Transcripts scanned so far, by path. Reuse one across refreshes so each refresh reads only what was appended. */
export class ChildrenReader {
  private readonly scans = new GrowingFiles(() => new TranscriptScan());
  /**
   * Finished children whose subtree can no longer change (nothing in it runs, an agent's transcript says it finished, a
   * workflow's summary says it ended), by transcript and launch id. Each refresh then stats an agent's transcript
   * instead of reading it, its meta file and everything under it again.
   */
  private final = new Map<string, FinalChild>();
  /** Summaries of ended workflows, by path: written once when the workflow ends. */
  private summaries = new Map<string, Record<string, unknown>>();
  /** The tree of a session whose Claude process is gone, by transcript: it changes only if the transcript does. */
  private stopped = new Map<string, { scan: TranscriptScan; offset: number; finishedLimit: number; tree: SessionChild[] }>();
  private touched = { final: new Set<string>(), summaries: new Set<string>(), stopped: new Set<string>() };

  /** The tree under a session, from its transcript (`<dir>/<session>.jsonl`). */
  async read(transcriptPath: string, options: ChildrenOptions): Promise<SessionChild[]> {
    const sessionDir = transcriptPath.replace(/\.jsonl$/, '');
    if (options.live) return this.under(transcriptPath, sessionDir, options, 0);
    this.touched.stopped.add(transcriptPath);
    const scan = await this.scans.read(transcriptPath);
    const kept = this.stopped.get(transcriptPath);
    if (scan && kept && kept.scan === scan && kept.offset === scan.offset && kept.finishedLimit === options.finishedLimit) return kept.tree;
    const tree = await this.under(transcriptPath, sessionDir, options, 0, scan);
    if (scan) this.stopped.set(transcriptPath, { scan, offset: scan.offset, finishedLimit: options.finishedLimit, tree });
    else this.stopped.delete(transcriptPath);
    return tree;
  }

  /** Forgets transcripts not read since the last call (sessions that went away). */
  prune(): void {
    this.scans.prune();
    const keep = <V>(map: Map<string, V>, touched: Set<string>) => {
      for (const key of map.keys()) if (!touched.has(key)) map.delete(key);
      touched.clear();
    };
    keep(this.final, this.touched.final);
    keep(this.summaries, this.touched.summaries);
    keep(this.stopped, this.touched.stopped);
  }

  private async under(transcript: string, sessionDir: string, options: ChildrenOptions, depth: number, read?: TranscriptScan): Promise<SessionChild[]> {
    const scan = read ?? (await this.scans.read(transcript));
    if (!scan) return [];
    const launches = scan.list();
    // A launch the transcript shows finished stays finished (as does every one once the session is gone): when at least
    // `finishedLimit` of those follow it, limitFinished folds it into the "more" row whatever its subtree is, so it is
    // not read.
    const folded = new Array<boolean>(launches.length).fill(false);
    for (let i = launches.length - 1, after = 0; i >= 0; i--) {
      if (options.live && launches[i].state === 'running') continue;
      folded[i] = after >= options.finishedLimit;
      after++;
    }
    const children = await Promise.all(
      launches.map((l, i) => (folded[i] ? Promise.resolve(foldedChild(l)) : this.child(l, transcript, sessionDir, options, depth))),
    );
    return limitFinished(children, options.finishedLimit);
  }

  private async child(l: Launch, transcript: string, sessionDir: string, options: ChildrenOptions, depth: number): Promise<SessionChild> {
    const cacheable = options.live && ((l.kind === 'agent' && !!l.agentId) || (l.kind === 'workflow' && !!l.runId));
    const key = `${transcript}\0${l.id}`;
    const launch = cacheable ? JSON.stringify(l) : '';
    if (cacheable) {
      this.touched.final.add(key);
      const kept = this.final.get(key);
      if (kept && kept.launch === launch && kept.finishedLimit === options.finishedLimit && kept.depth === depth && (await this.unchanged(kept))) return kept.node;
      this.final.delete(key);
    }
    const base: SessionChild = { id: l.id, kind: l.kind, label: l.label, detail: l.detail, state: l.state, startedAt: l.startedAt, background: l.background, children: [] };
    let ended = false;
    if (l.kind === 'shell') {
      base.file = l.outputPath;
    } else if (l.kind === 'agent' && l.agentId) {
      const file = join(sessionDir, 'subagents', `agent-${l.agentId}.jsonl`);
      base.file = file;
      if (depth < MAX_DEPTH) base.children = await this.under(file, sessionDir, options, depth + 1);
      if (base.state === 'running') {
        ended = await this.agentFinished(file);
        if (ended) base.state = 'done';
      } else if (cacheable && !anyRunning(base.children)) {
        ended = await this.agentFinished(file);
      }
    } else if (l.kind === 'workflow' && l.runId) {
      ended = await this.workflow(base, l, sessionDir, options);
    }
    if (cacheable && ended && base.state !== 'running' && !anyRunning(base.children)) {
      const kept: FinalChild = { launch, finishedLimit: options.finishedLimit, depth, node: base };
      if (l.kind === 'agent') {
        const info = await stat(base.file as string).catch(() => undefined);
        kept.size = info?.size;
        kept.mtimeMs = info?.mtimeMs;
      }
      this.final.set(key, kept);
    }
    if (!options.live || (options.since !== undefined && l.startedAt !== undefined && l.startedAt < options.since)) stopAll(base);
    return base;
  }

  /** Whether a kept agent's transcript is as it was when read (a resumed agent writes to it again). */
  private async unchanged(kept: FinalChild): Promise<boolean> {
    if (kept.node.kind !== 'agent') return true;
    const info = await stat(kept.node.file as string).catch(() => undefined);
    return info?.size === kept.size && info?.mtimeMs === kept.mtimeMs;
  }

  private async agentFinished(file: string): Promise<boolean> {
    const meta = await readJson(file.replace(/\.jsonl$/, '.meta.json'));
    if (meta?.finished === true) return true;
    return this.scans.peek(file)?.finished === true;
  }

  /** A workflow's summary once it has one; kept once it says the workflow ended. */
  private async summary(path: string): Promise<Record<string, unknown> | undefined> {
    this.touched.summaries.add(path);
    const kept = this.summaries.get(path);
    if (kept) return kept;
    const summary = await readJson(path);
    if (summary && workflowEnded(summary)) this.summaries.set(path, summary);
    return summary;
  }

  /**
   * A workflow's phases and agents: from its summary once finished, else from the agents written so far. True when the
   * summary says the workflow ended.
   */
  private async workflow(node: SessionChild, l: Launch, sessionDir: string, options: ChildrenOptions): Promise<boolean> {
    const runId = l.runId as string;
    const agentsDir = join(sessionDir, 'subagents', 'workflows', runId);
    const summary = await this.summary(join(sessionDir, 'workflows', `${runId}.json`));
    if (summary) {
      node.file = join(sessionDir, 'workflows', `${runId}.json`);
      if (node.state === 'running') node.state = WORKFLOW_STATES[String(summary.status)] ?? 'running';
      const progress = Array.isArray(summary.workflowProgress) ? (summary.workflowProgress as Record<string, unknown>[]) : [];
      const agents = progress
        .filter((p) => p && p.type === 'workflow_agent')
        .map((p) => ({
          agentId: typeof p.agentId === 'string' ? p.agentId : undefined,
          label: String(p.label ?? 'agent'),
          phase: String(p.phaseTitle ?? ''),
          state: WORKFLOW_STATES[String(p.state)] ?? (node.state === 'running' ? 'running' : 'stopped'),
          startedAt: typeof p.startedAt === 'number' ? p.startedAt : undefined,
        }));
      node.children = byPhase(node.id, agents, agentsDir, options.finishedLimit);
      return workflowEnded(summary);
    }
    node.file = l.scriptPath;
    let names: string[];
    try {
      names = await readdir(agentsDir);
    } catch {
      return false;
    }
    const agents = await Promise.all(
      names
        .filter((n) => n.endsWith('.meta.json'))
        .map(async (n) => {
          const agentId = n.slice('agent-'.length, -'.meta.json'.length);
          const file = join(agentsDir, `agent-${agentId}.jsonl`);
          const [meta, scan, info] = await Promise.all([readJson(join(agentsDir, n)), this.scans.read(file), stat(file).catch(() => undefined)]);
          const finished = meta?.finished === true || scan?.finished === true;
          return {
            agentId,
            label: typeof meta?.description === 'string' ? meta.description : agentId,
            phase: typeof meta?.workflowPhase === 'string' ? meta.workflowPhase : '',
            state: (finished ? 'done' : 'running') as ChildState,
            startedAt: info?.birthtimeMs,
          };
        }),
    );
    agents.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    node.children = byPhase(node.id, agents, agentsDir, options.finishedLimit);
    return false;
  }
}

/** Whether a workflow summary's status is a final one. */
function workflowEnded(summary: Record<string, unknown>): boolean {
  const state = WORKFLOW_STATES[String(summary.status)];
  return state !== undefined && state !== 'running';
}

/** A finished launch that limitFinished folds into the "more" row: only its id and (finished) state are used. */
function foldedChild(l: Launch): SessionChild {
  return { id: l.id, kind: l.kind, label: l.label, detail: l.detail, state: l.state === 'running' ? 'stopped' : l.state, startedAt: l.startedAt, background: l.background, children: [] };
}

function anyRunning(children: readonly SessionChild[]): boolean {
  return children.some((c) => c.state === 'running' || anyRunning(c.children));
}

/** How deep agents of agents are followed. */
const MAX_DEPTH = 4;

function stopAll(node: SessionChild): void {
  if (node.state === 'running') node.state = 'stopped';
  node.children.forEach(stopAll);
}

interface WorkflowAgent {
  agentId?: string;
  label: string;
  phase: string;
  state: ChildState;
  startedAt?: number;
}

/** Workflow agents grouped under their phases, in order; a phase is running while any agent in it is. */
function byPhase(workflowId: string, agents: WorkflowAgent[], agentsDir: string, finishedLimit: number): SessionChild[] {
  const phases = new Map<string, SessionChild>();
  for (const a of agents) {
    let phase = phases.get(a.phase);
    if (!phase) {
      phase = { id: `${workflowId}/phase:${a.phase}`, kind: 'phase', label: a.phase || 'Agents', state: 'done', background: true, children: [] };
      phases.set(a.phase, phase);
    }
    phase.children.push({
      id: `${workflowId}/agent:${a.agentId ?? a.label}`,
      kind: 'agent',
      label: a.label,
      detail: 'workflow agent',
      state: a.state,
      startedAt: a.startedAt,
      background: true,
      file: a.agentId ? join(agentsDir, `agent-${a.agentId}.jsonl`) : undefined,
      children: [],
    });
  }
  for (const p of phases.values()) {
    p.state = aggregate(p.children);
    p.children = limitFinished(p.children, finishedLimit);
  }
  return [...phases.values()];
}

function aggregate(children: readonly SessionChild[]): ChildState {
  if (children.some((c) => c.state === 'running')) return 'running';
  if (children.some((c) => c.state === 'failed')) return 'failed';
  if (children.some((c) => c.state === 'stopped')) return 'stopped';
  return 'done';
}

/** Keeps every running child and the `limit` most recent finished ones (in their order); the rest become one row. */
export function limitFinished(children: SessionChild[], limit: number): SessionChild[] {
  const finished = children.filter((c) => c.state !== 'running');
  if (finished.length <= limit) return children;
  const keep = new Set(finished.slice(finished.length - limit));
  const hidden = finished.length - limit;
  const shown = children.filter((c) => c.state === 'running' || keep.has(c));
  return [
    { id: `${children[0].id}/more`, kind: 'more', label: `${hidden} earlier finished`, state: 'done', background: false, children: [] },
    ...shown,
  ];
}

/** How many children (at any depth, not counting phases or "more" rows) are running. */
export function runningCount(children: readonly SessionChild[]): number {
  return children.reduce((n, c) => n + (c.state === 'running' && c.kind !== 'phase' && c.kind !== 'more' ? 1 : 0) + runningCount(c.children), 0);
}

/** Some background child (or a child of one) still runs; a foreground one left running by an interrupted turn does not count. */
export function runningBackground(children: readonly SessionChild[]): boolean {
  return children.some((c) => c.background && runningCount([c]) > 0);
}
