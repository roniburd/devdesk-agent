// The Transcript tab's list: prompts and replies with who said them, and runs of tool calls folded into one line.

import type { Turn } from '../../core/web/types';
import { h } from './dom';
import { renderMarkdown } from './markdown';

// Who speaks is marked as in Claude Code's terminal: `>` before your prompts, `⏺` before Claude's replies.
const SPEAKER: Record<'user' | 'assistant', { mark: string; name: string }> = {
  user: { mark: '>', name: 'You' },
  assistant: { mark: '⏺', name: 'Claude' },
};

/** A tool call's line (`- Bash npm test`) without its dash. */
const toolText = (t: Turn) => t.text.replace(/^- /, '');

/**
 * The transcript as list items: one per prompt and reply (a reply's Markdown rendered), and one quiet "Ran 3 tools:
 * Bash, Read" line per run of tool calls, which opens to show the calls.
 */
export function turnEls(turns: readonly Turn[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let i = 0; i < turns.length; ) {
    const t = turns[i];
    if (t.kind === 'tool') {
      const run: Turn[] = [];
      while (i < turns.length && turns[i].kind === 'tool') run.push(turns[i++]);
      // An MCP tool (`mcp__playwright__browser_click`) by its own name (`browser_click`).
      const names = [...new Set(run.map((r) => toolText(r).split(' ')[0].replace(/^mcp__.+?__/, '')))];
      const summary = `Ran ${run.length === 1 ? 'a tool' : `${run.length} tools`}: ${names.join(', ')}`;
      out.push(
        h(
          'li',
          { class: 'turn turn-tool', attrs: { 'data-kind': 'tool' } },
          h('details', {}, h('summary', { text: summary }), h('ul', { class: 'tool-calls' }, ...run.map((r) => h('li', { text: toolText(r) })))),
        ),
      );
      continue;
    }
    i++;
    const who = SPEAKER[t.kind];
    const body = h('div', { class: 'turn-body' });
    if (t.kind === 'assistant') body.append(...renderMarkdown(t.text));
    else body.textContent = t.text;
    out.push(
      h(
        'li',
        { class: `turn turn-${t.kind}`, attrs: { 'data-kind': t.kind, 'aria-label': who.name } },
        h('span', { class: 'turn-mark', text: who.mark, attrs: { 'aria-hidden': 'true' } }),
        body,
      ),
    );
  }
  return out;
}
