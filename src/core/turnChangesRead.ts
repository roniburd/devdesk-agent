import { join } from 'node:path';
import { parseObject } from './json';
import { readLinesBackward } from './transcriptTail';
import { addAgentOps, mayMatter, promptOf, type Turn, TurnParser } from './turnChanges';

export interface TurnReadLimits {
  /** Turns to read, counted from the last. */
  turns: number;
  /** Bytes read at most from the end of a transcript (and of each subagent's). */
  maxBytes: number;
  /** A line longer than this is skipped (its turn is then marked partial). */
  maxLine: number;
  /** Bytes per read (tests use small ones). */
  chunkBytes?: number;
}

/** Nested subagents followed at most this deep. */
const MAX_DEPTH = 3;

/**
 * The last `limits.turns` turns of a session's transcript, oldest first, with the edits of the subagents each turn
 * started (from `<session>/subagents/agent-<id>.jsonl` beside the transcript). Reads backward from the end and stops
 * at the oldest turn's prompt or at `limits.maxBytes`, so a 100 MB transcript costs only its last turns. Undefined when
 * the transcript cannot be read.
 */
export async function readRecentTurns(transcriptPath: string, limits: TurnReadLimits): Promise<Turn[] | undefined> {
  const read = await readTranscript(transcriptPath, limits, false);
  if (!read) return undefined;
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '');
  for (const turn of read) await addAgents(turn, turn.agents, sessionDir, limits, 1);
  // Edits read before any prompt, when the read stopped mid-turn, belong to a turn that is not listed whole.
  return read.filter((t) => t.prompt !== '' || t.ops.length > 0);
}

async function addAgents(turn: Turn, agents: readonly string[], sessionDir: string, limits: TurnReadLimits, depth: number): Promise<void> {
  for (const id of agents) {
    if (!/^[\w-]+$/.test(id)) continue;
    const turns = await readTranscript(join(sessionDir, 'subagents', `agent-${id}.jsonl`), { ...limits, turns: Infinity }, true);
    const sub = turns?.[0];
    if (!sub) continue;
    addAgentOps(turn, sub.ops, sub.partial);
    if (depth < MAX_DEPTH) await addAgents(turn, sub.agents, sessionDir, limits, depth + 1);
  }
}

async function readTranscript(path: string, limits: TurnReadLimits, subagent: boolean): Promise<Turn[] | undefined> {
  /** The lines that matter, last first: parsed objects, or undefined for a line too long to read. */
  const lines: (Record<string, unknown> | undefined)[] = [];
  let prompts = 0;
  const read = await readLinesBackward(path, limits, (line) => {
    if (line === undefined) {
      lines.push(undefined);
      return true;
    }
    if (!mayMatter(line)) return true;
    const o = parseObject(line);
    if (!o) return true;
    lines.push(o);
    if (!subagent && promptOf(o) !== undefined) prompts++;
    return prompts < limits.turns;
  });
  if (!read) return undefined;
  const parser = new TurnParser(subagent);
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = lines[i];
    if (o) parser.object(o);
    else parser.skipped();
  }
  // A subagent's transcript not read from its start misses edits.
  if (subagent && !read.complete && parser.turns[0]) parser.turns[0].partial = true;
  return parser.turns;
}
