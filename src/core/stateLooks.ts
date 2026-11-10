import type { SessionLaneId } from './board';

/** A finer state for icons and labels: which kind of input, an error or a usage limit, stuck or crashed. */
export type StateLook =
  | 'question'
  | 'permission'
  | 'plan'
  | 'input'
  | 'limited'
  | 'error'
  | 'working'
  | 'stuck'
  | 'background'
  | 'done'
  | 'asked'
  | 'interrupted'
  | 'idle'
  | 'unknown'
  | 'crashed'
  | 'stopped'
  | 'parked';

/** How a look is drawn, everywhere a session shows. Each look has its own shape, so colour is never the only cue. */
export interface LookInfo {
  /** The Claude view row's codicon. */
  codicon: string;
  /** The codicon's theme colour; none for the default foreground. */
  themeColor?: string;
  /** The Claude Board card's glyph. */
  glyph: string;
  /** The glyph's classes on the board (its colour first, then `spin`), see media/board.css. */
  glyphClass: string;
  /** Tooltip and screen reader text. */
  label: string;
  /** Short state text for a Worktrees row. */
  text: string;
  /** The Claude Board lane its card goes in. */
  lane: SessionLaneId;
}

export const LOOKS: Readonly<Record<StateLook, Readonly<LookInfo>>> = {
  question: { codicon: 'question', themeColor: 'charts.yellow', glyph: '?', glyphClass: 'yellow', label: 'QUESTION FOR YOU', text: '? question', lane: 'needs' },
  permission: { codicon: 'shield', themeColor: 'charts.yellow', glyph: '🛡', glyphClass: 'yellow', label: 'NEEDS PERMISSION', text: '? needs permission', lane: 'needs' },
  plan: { codicon: 'checklist', themeColor: 'charts.yellow', glyph: '☑', glyphClass: 'yellow', label: 'PLAN TO REVIEW', text: '? plan to review', lane: 'needs' },
  input: { codicon: 'bell-dot', themeColor: 'charts.yellow', glyph: '🔔', glyphClass: 'yellow', label: 'NEEDS INPUT', text: '? needs input', lane: 'needs' },
  limited: { codicon: 'clock', themeColor: 'charts.orange', glyph: '◷', glyphClass: 'orange', label: 'USAGE LIMIT', text: '◷ usage limit', lane: 'review' },
  error: { codicon: 'error', themeColor: 'charts.red', glyph: '✕', glyphClass: 'red', label: 'BLOCKED', text: '✕ blocked', lane: 'review' },
  working: { codicon: 'loading~spin', themeColor: 'charts.blue', glyph: '⟳', glyphClass: 'blue spin', label: 'WORKING', text: '⟳ working', lane: 'working' },
  stuck: { codicon: 'watch', themeColor: 'charts.orange', glyph: '⌚', glyphClass: 'orange', label: 'NO PROGRESS (STUCK?)', text: '⟳ stuck?', lane: 'working' },
  background: {
    codicon: 'sync~spin',
    themeColor: 'charts.blue',
    glyph: '⟳',
    glyphClass: 'blue spin',
    label: 'WAITING ON BACKGROUND WORK',
    text: '⟳ background',
    lane: 'working',
  },
  done: { codicon: 'check', themeColor: 'charts.green', glyph: '✓', glyphClass: 'green', label: 'DONE', text: '✓ done', lane: 'review' },
  asked: { codicon: 'comment-discussion', themeColor: 'charts.green', glyph: '💬', glyphClass: 'green', label: 'DONE (ASKED YOU)', text: '✓ asked you', lane: 'review' },
  interrupted: {
    codicon: 'debug-stop',
    themeColor: 'charts.purple',
    glyph: '■',
    glyphClass: 'purple',
    label: 'DONE (INTERRUPTED)',
    text: '■ interrupted',
    lane: 'review',
  },
  idle: { codicon: 'circle-outline', themeColor: 'disabledForeground', glyph: '○', glyphClass: 'dim', label: 'READY', text: '○ ready', lane: 'review' },
  unknown: { codicon: 'circle-large-outline', glyph: '●', glyphClass: 'dim', label: 'NO STATUS', text: '● claude', lane: 'review' },
  crashed: { codicon: 'debug-disconnect', themeColor: 'charts.red', glyph: '⚡', glyphClass: 'red', label: 'CRASHED', text: '✕ crashed', lane: 'review' },
  stopped: { codicon: 'circle-slash', themeColor: 'disabledForeground', glyph: '⊘', glyphClass: 'dim', label: 'NOT RUNNING', text: '○ not running', lane: 'review' },
  parked: { codicon: 'debug-pause', themeColor: 'disabledForeground', glyph: '⏸', glyphClass: 'dim', label: 'PARKED (NOT RUNNING)', text: '⏸ parked', lane: 'review' },
};
