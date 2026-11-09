import { isFiniteNumber, parseObject, positiveNumber } from './json';
import { isInjectedPrompt, type SessionCard } from './sessions';

/**
 * DevDesk's Haiku insights: a small model reads the end of a session's transcript and says what Claude is doing, where
 * the work stands, and whether the finished turn waits for the user. Each session's latest answers live in
 * `<state dir>/insights/<session id>.json`, matched to the turn they are about by the hook record's turn times.
 */
export interface Insight {
  /** The turn (its `turnStartedAt`) the status is about. */
  statusFor?: number;
  status?: string;
  statusAt?: number;
  /** The finished turn (its `turnEndedAt`) `waitingForUser` is about. */
  doneFor?: number;
  waitingForUser?: boolean;
  summary?: string;
  summaryAt?: number;
  /** A short name for the session's task (a few words), for the board's cards. */
  title?: string;
  /** An answer came without a title: a finished turn is not asked again just for one. */
  untitled?: boolean;
  /** What the whole session sets out to do (its goal and tasks, across all prompts), in one short line. */
  objective?: string;
  /** An answer was asked for the objective (with or without one): a finished turn is not asked again just for it. */
  objectiveAsked?: boolean;
  /** The waiting record (its `updatedAt`) `ask` is about. */
  askFor?: number;
  /** What Claude waits for the user to answer or approve, in one short line. */
  ask?: string;
  /** The transcript's size when last read for a call. */
  bytes?: number;
}

export type InsightKind = 'status' | 'done' | 'ask';

/** When the card's finished turn ended; a record from an older hook script has no turn times, so its last update. */
export const turnEnd = (card: SessionCard): number | undefined => card.turnEndedAt ?? card.updatedAt;

const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

const STATUS_MAX = 80;
const SUMMARY_MAX = 200;
export const TITLE_MAX = 40;
export const OBJECTIVE_MAX = 70;
const ASK_MAX = 100;

export function parseInsight(raw: string): Insight | undefined {
  const o = parseObject(raw);
  if (!o) return undefined;
  const insight: Insight = {};
  if (isFiniteNumber(o.statusFor)) insight.statusFor = o.statusFor;
  const status = text(o.status, STATUS_MAX);
  if (status) insight.status = status;
  if (isFiniteNumber(o.statusAt)) insight.statusAt = o.statusAt;
  if (isFiniteNumber(o.doneFor)) insight.doneFor = o.doneFor;
  if (typeof o.waitingForUser === 'boolean') insight.waitingForUser = o.waitingForUser;
  const summary = text(o.summary, SUMMARY_MAX);
  if (summary) insight.summary = summary;
  if (isFiniteNumber(o.summaryAt)) insight.summaryAt = o.summaryAt;
  const title = text(o.title, TITLE_MAX);
  if (title) insight.title = title;
  if (o.untitled === true) insight.untitled = true;
  const objective = text(o.objective, OBJECTIVE_MAX);
  if (objective) insight.objective = objective;
  if (o.objectiveAsked === true) insight.objectiveAsked = true;
  if (isFiniteNumber(o.askFor)) insight.askFor = o.askFor;
  const ask = text(o.ask, ASK_MAX);
  if (ask) insight.ask = ask;
  if (isFiniteNumber(o.bytes)) insight.bytes = o.bytes;
  return insight;
}

/**
 * Puts what an insight says about the card's current turn on the card: the status only while that turn works, the
 * waiting-for-you answer (over the hook's `?` heuristic) only for the finished turn it read, what Claude asks only
 * while that same wait lasts, the summary and title always.
 */
export function applyInsight(card: SessionCard, insight: Insight | undefined): void {
  if (!insight) return;
  if (card.state === 'working' && insight.status && insight.statusFor !== undefined && insight.statusFor === card.turnStartedAt) {
    card.liveStatus = insight.status;
  }
  const finished = card.state === 'done' || (card.state === 'parked' && card.lastState === 'done');
  if (finished && insight.waitingForUser !== undefined && insight.doneFor !== undefined && insight.doneFor === turnEnd(card)) {
    if (insight.waitingForUser) card.asksQuestion = true;
    else delete card.asksQuestion;
  }
  if (insight.summary) {
    card.insightSummary = insight.summary;
    if (insight.summaryAt !== undefined) card.insightSummaryAt = insight.summaryAt;
  }
  if (insight.title) card.insightTitle = insight.title;
  if (insight.objective) card.insightObjective = insight.objective;
  if (card.state === 'waiting' && insight.ask && insight.askFor !== undefined && insight.askFor === card.updatedAt) card.askSummary = insight.ask;
}

/**
 * Whether a session needs a Haiku call now: a finished turn not yet answered (`done`); a wait for the user not yet
 * summarized (`ask`); a working turn with no status yet, or whose status is `refreshMs` old while the transcript grew
 * since (`status`).
 */
export function insightDue(card: SessionCard, insight: Insight | undefined, now: number, refreshMs: number, bytes: number): InsightKind | undefined {
  if (!card.sessionId || !card.transcriptPath) return undefined;
  const ended = turnEnd(card);
  // A turn answered before insights had titles (or objectives) is asked once more, for one.
  if (card.state === 'done' && ended !== undefined) {
    return insight?.doneFor === ended && (insight.title || insight.untitled) && insight.objectiveAsked ? undefined : 'done';
  }
  if (card.state === 'waiting' && card.updatedAt !== undefined) return insight?.askFor === card.updatedAt ? undefined : 'ask';
  if (card.state === 'working' && card.turnStartedAt !== undefined) {
    if (insight?.statusFor !== card.turnStartedAt) return 'status';
    const grew = bytes > (insight.bytes ?? 0);
    return grew && now - (insight.statusAt ?? 0) >= refreshMs ? 'status' : undefined;
  }
  return undefined;
}

/** The insight after a call's answer: `kind` says which turn time (or, for `ask`, which wait) the answer is for. */
export function mergeAnswer(
  prev: Insight | undefined,
  kind: InsightKind,
  turn: number,
  answer: InsightAnswer,
  now: number,
  bytes: number,
): Insight {
  const next: Insight = { ...prev, bytes };
  if (kind === 'status') {
    next.statusFor = turn;
    next.statusAt = now;
    if (answer.status) next.status = answer.status;
  } else if (kind === 'ask') {
    next.askFor = turn;
    if (answer.ask) next.ask = answer.ask;
    else delete next.ask;
  } else {
    next.doneFor = turn;
    next.waitingForUser = answer.waitingForUser;
  }
  if (answer.summary) {
    next.summary = answer.summary;
    next.summaryAt = now;
  }
  if (answer.title) {
    next.title = answer.title;
    delete next.untitled;
  } else if (!next.title) next.untitled = true;
  if (answer.objective) next.objective = answer.objective;
  next.objectiveAsked = true;
  return next;
}

export const INSIGHT_SYSTEM_PROMPT = [
  'You watch a Claude Code coding session for its user and report on it in a few words.',
  'You get the session\'s earlier prompts (when there are some), the latest task the user gave, the tools Claude used since (oldest first), and the end of its latest message.',
  'When Claude is WAITING for the user, the last tool listed is usually the one waiting for approval or asking the question.',
  'Answer with one JSON object only, no prose, no code fence:',
  `{"status": string (at most ${STATUS_MAX} characters, present tense, what Claude is doing right now, e.g. "Running the unit tests after fixing the parser"),`,
  ` "summary": string (at most ${SUMMARY_MAX} characters, where the work stands: what is done and what is left),`,
  ` "title": string (at most ${TITLE_MAX} characters, 2 to 6 words naming the session's task, no ending period, e.g. "Raise login timeout"; when a current title is given, repeat it unless the task changed),`,
  ` "objective": string (at most ${OBJECTIVE_MAX} characters, what the WHOLE session sets out to achieve: its overall goal and main tasks across all its prompts, not just the latest one, no ending period, e.g. "Add OAuth login and migrate session storage"; when a current objective is given, repeat it unless the session's goal changed or grew),`,
  ` "ask": string (at most ${ASK_MAX} characters; only when Claude waits for the user: what it needs answered or approved, in plain words, e.g. "Allow running npm uninstall aws-sdk?" or "Cursor-based or page-number pagination?"; else ""),`,
  ' "waitingForUser": boolean (true only when the turn is finished and its latest message asks the user to answer, choose, approve or do something before work can go on; false when it just reports results or only offers optional next steps)}',
].join('\n');

/** The parts of a transcript line the excerpt uses. */
interface Entry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown };
}

const TOOL_INPUT_KEYS = ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'prompt', 'skill'] as const;

function toolLine(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
  // AskUserQuestion: its questions are what the user is asked.
  if (Array.isArray(input.questions)) {
    const asked = input.questions
      .map((q) => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : ''))
      .filter(Boolean)
      .join(' / ');
    if (asked) return `- ${name} ${asked.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
  }
  const key = TOOL_INPUT_KEYS.find((k) => typeof input[k] === 'string' && (input[k] as string).trim());
  const arg = key ? ` ${(input[key] as string).replace(/\s+/g, ' ').trim().slice(0, 120)}` : '';
  return `- ${name}${arg}`;
}

/** The user's own words in a user line (not tool results, not slash command wrappers); empty otherwise. */
export function promptText(content: unknown): string {
  if (typeof content === 'string') return content.trim().startsWith('<') || isInjectedPrompt(content) ? '' : content.trim();
  if (!Array.isArray(content)) return '';
  if (content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result')) return '';
  const text = content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('\n')
    .trim();
  return isInjectedPrompt(text) ? '' : text;
}

/**
 * What the model reads, from the transcript's last lines: the latest prompt, the tools used since (the last 15), and
 * the end of the latest assistant text. A long turn pushes its prompt out of the lines read: `fallbackPrompt` (the hook
 * record's) stands in then. Empty when there is no prompt to report on.
 */
export function buildExcerpt(lines: readonly string[], fallbackPrompt = ''): string {
  let prompt = '';
  const tools: string[] = [];
  let reply = '';
  for (const line of lines) {
    const e = parseObject(line) as Entry | undefined;
    if (!e || e.isSidechain === true) continue;
    const content = e.message?.content;
    if (e.type === 'user' && e.isMeta !== true) {
      const p = promptText(content);
      if (p) {
        prompt = p;
        tools.length = 0;
        reply = '';
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        const block = b as Record<string, unknown>;
        if (block.type === 'tool_use') tools.push(toolLine(block));
        else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) reply = block.text.trim();
      }
    }
  }
  prompt ||= fallbackPrompt.trim();
  if (!prompt) return '';
  const head = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}…`);
  const tail = (s: string, max: number) => (s.length <= max ? s : `…${s.slice(-max)}`);
  return [
    `Task from the user:\n${head(prompt, 1500)}`,
    `Tools used since (oldest first):\n${tools.length ? tools.slice(-15).join('\n') : '(none)'}`,
    `End of Claude's latest message:\n${reply ? tail(reply, 2500) : '(none yet)'}`,
  ].join('\n\n');
}

/**
 * The session's first prompts (the user's own words, oldest first, at most `max`), from the transcript's first lines:
 * what the session set out to do, which a long session's tail no longer shows.
 */
export function firstPrompts(lines: readonly string[], max = 3): string[] {
  const prompts: string[] = [];
  for (const line of lines) {
    const e = parseObject(line) as Entry | undefined;
    if (!e || e.isSidechain === true || e.type !== 'user' || e.isMeta === true) continue;
    const p = promptText(e.message?.content);
    if (p && prompts.push(p.replace(/\s+/g, ' ').trim().slice(0, 600)) >= max) break;
  }
  return prompts;
}

/** The latest prompt in a transcript's lines (the user's own words); empty without one. */
export function latestPrompt(lines: readonly string[]): string {
  let prompt = '';
  for (const line of lines) {
    const e = parseObject(line) as Entry | undefined;
    if (!e || e.isSidechain === true || e.type !== 'user' || e.isMeta === true) continue;
    prompt = promptText(e.message?.content) || prompt;
  }
  return prompt;
}

/** The excerpt's part listing the session's earlier prompts, those not the latest one; empty without any. */
export function earlierPromptsPart(prompts: readonly string[], latest: string | undefined): string {
  const l = (latest ?? '').replace(/\s+/g, ' ').trim();
  const earlier = prompts.filter((p) => !l || !l.startsWith(p));
  return earlier.length ? `The session's first prompts (oldest first):\n${earlier.map((p) => `- ${p}`).join('\n')}` : '';
}

export interface InsightAnswer {
  status?: string;
  summary?: string;
  title?: string;
  objective?: string;
  ask?: string;
  waitingForUser: boolean;
}

export interface CallUsage {
  model?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  ms?: number;
}

export interface CallResult {
  answer?: InsightAnswer;
  usage?: CallUsage;
  /** Why there is no answer. */
  error?: string;
}

/** The model's JSON object in its reply text, tolerating a code fence or words around it. */
export function parseAnswer(reply: string): InsightAnswer | undefined {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  const o = parseObject(reply.slice(start, end + 1));
  if (!o) return undefined;
  const answer: InsightAnswer = { waitingForUser: o.waitingForUser === true };
  const status = text(o.status, STATUS_MAX);
  if (status) answer.status = status;
  const summary = text(o.summary, SUMMARY_MAX);
  if (summary) answer.summary = summary;
  const title = text(o.title, TITLE_MAX);
  if (title) answer.title = title.replace(/\.$/, '');
  const objective = text(o.objective, OBJECTIVE_MAX);
  if (objective) answer.objective = objective.replace(/\.$/, '');
  const ask = text(o.ask, ASK_MAX);
  if (ask) answer.ask = ask;
  return answer;
}

/** `claude -p --output-format json` output: the reply text and what the call used, or why there is none. */
export function unwrapCallOutput(stdout: string): { reply?: string; usage?: CallUsage; error?: string } {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  const o = parseObject(stdout.slice(start, end + 1));
  if (!o) return { error: 'no JSON result from claude' };
  const u = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>;
  const models = o.modelUsage && typeof o.modelUsage === 'object' ? Object.keys(o.modelUsage) : [];
  const usage: CallUsage = {
    input: positiveNumber(u.input_tokens),
    cacheRead: positiveNumber(u.cache_read_input_tokens),
    cacheWrite: positiveNumber(u.cache_creation_input_tokens),
    output: positiveNumber(u.output_tokens),
    ...(models[0] ? { model: models[0] } : {}),
    ...(isFiniteNumber(o.duration_ms) ? { ms: o.duration_ms } : {}),
  };
  if (o.is_error === true) return { usage, error: typeof o.result === 'string' && o.result ? o.result.slice(0, 200) : 'claude reported an error' };
  return typeof o.result === 'string' ? { reply: o.result, usage } : { usage, error: 'the reply is not the JSON asked for' };
}

/** `claude -p --output-format json` output: the answer and what the call used. */
export function parseCallOutput(stdout: string): CallResult {
  const { reply, usage, error } = unwrapCallOutput(stdout);
  if (error) return usage ? { usage, error } : { error };
  const answer = reply !== undefined ? parseAnswer(reply) : undefined;
  return answer ? { answer, usage } : { usage, error: 'the reply is not the JSON asked for' };
}

/** One line of `<state dir>/usage.jsonl`. */
export interface LedgerLine extends CallUsage {
  at: number;
  kind: InsightKind;
  sessionId: string;
  ok: boolean;
}

export function ledgerLine(at: number, kind: InsightKind, sessionId: string, result: CallResult): string {
  const line: LedgerLine = { at, kind, sessionId, ok: !!result.answer, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...result.usage };
  return `${JSON.stringify(line)}\n`;
}

/** A session's insight file name, or undefined for an id that is not a plain file name. */
export function insightFileName(sessionId: string, ext: 'json' | 'lock'): string | undefined {
  return /^[\w-]+$/.test(sessionId) ? `${sessionId}.${ext}` : undefined;
}
