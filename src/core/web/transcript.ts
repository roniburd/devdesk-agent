import { promptText, toolLine } from '../insights';
import { parseObject } from '../json';
import { truncate } from '../text';
import type { Turn } from './types';

/** A session's conversation as the page's Transcript tab shows it, from the end of its transcript. */

/** How many prompts and replies the detail gives (with the tool calls between them, which don't count). */
export const DETAIL_TURNS = 40;
/** How much of the transcript's end the detail reads. */
export const DETAIL_TAIL_BYTES = 262144;
/** How far back the detail reads at most, when tool output leaves too few messages in the first read. */
export const DETAIL_MAX_TAIL_BYTES = 4194304;
// A reply's tables and lists run long: cap it well past a phone screen, not mid-table.
const TEXT_MAX = 8000;

interface Entry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown };
}

/**
 * Main-chain user prompts (promptText, skipping isMeta and tool results), assistant text blocks, one 'tool' Turn per
 * tool_use; the last `max` prompts and replies, with the tool calls among them. Each text capped at 8000 chars. Lines
 * that are not JSON objects (the first, cut by the tail read) are skipped.
 */
export function transcriptTurns(lines: readonly string[], max = DETAIL_TURNS): Turn[] {
  const turns: Turn[] = [];
  const add = (kind: Turn['kind'], text: string) => turns.push({ kind, text: truncate(text, TEXT_MAX) });
  for (const line of lines) {
    const e = parseObject(line) as Entry | undefined;
    if (!e || e.isSidechain === true) continue;
    const content = e.message?.content;
    if (e.type === 'user' && e.isMeta !== true) {
      const p = promptText(content);
      if (p) add('user', p);
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        const block = b as Record<string, unknown>;
        if (block.type === 'tool_use') add('tool', toolLine(block));
        else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) add('assistant', block.text.trim());
      }
    }
  }
  // Back to the max-th message from the end: the tool calls before it go with the earlier messages.
  let start = turns.length;
  for (let said = 0; start > 0 && said < max; ) if (turns[--start].kind !== 'tool') said++;
  return turns.slice(start);
}
