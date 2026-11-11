import { promptText, toolLine } from '../insights';
import { parseObject } from '../json';
import { truncate } from '../text';
import type { Turn } from './types';

/** A session's conversation as the page's Transcript tab shows it, from the end of its transcript. */

export const DETAIL_TURNS = 40;
/** How much of the transcript's end the detail reads. */
export const DETAIL_TAIL_BYTES = 262144;
const TEXT_MAX = 4000;

interface Entry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown };
}

/**
 * Main-chain user prompts (promptText, skipping isMeta and tool results), assistant text blocks, one 'tool' Turn per
 * tool_use; the last `max`. Each text capped at 4000 chars. Lines that are not JSON objects (the first, cut by the
 * tail read) are skipped.
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
  return turns.slice(-max);
}
