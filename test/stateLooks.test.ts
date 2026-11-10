import { describe, expect, it } from 'vitest';
import { LOOKS, type StateLook } from '../src/core/stateLooks';

/** The look tables as they were before `LOOKS` held them all: one table must say the same. */
const ICONS: Record<StateLook, { icon: string; color?: string }> = {
  question: { icon: 'question', color: 'charts.yellow' },
  permission: { icon: 'shield', color: 'charts.yellow' },
  plan: { icon: 'checklist', color: 'charts.yellow' },
  input: { icon: 'bell-dot', color: 'charts.yellow' },
  limited: { icon: 'clock', color: 'charts.orange' },
  error: { icon: 'error', color: 'charts.red' },
  working: { icon: 'loading~spin', color: 'charts.blue' },
  stuck: { icon: 'watch', color: 'charts.orange' },
  background: { icon: 'sync~spin', color: 'charts.blue' },
  done: { icon: 'check', color: 'charts.green' },
  asked: { icon: 'comment-discussion', color: 'charts.green' },
  interrupted: { icon: 'debug-stop', color: 'charts.purple' },
  idle: { icon: 'circle-outline', color: 'disabledForeground' },
  unknown: { icon: 'circle-large-outline' },
  crashed: { icon: 'debug-disconnect', color: 'charts.red' },
  stopped: { icon: 'circle-slash', color: 'disabledForeground' },
  parked: { icon: 'debug-pause', color: 'disabledForeground' },
};

const LABELS: Record<StateLook, string> = {
  question: 'QUESTION FOR YOU',
  permission: 'NEEDS PERMISSION',
  plan: 'PLAN TO REVIEW',
  input: 'NEEDS INPUT',
  limited: 'USAGE LIMIT',
  error: 'BLOCKED',
  working: 'WORKING',
  stuck: 'NO PROGRESS (STUCK?)',
  background: 'WAITING ON BACKGROUND WORK',
  done: 'DONE',
  asked: 'DONE (ASKED YOU)',
  interrupted: 'DONE (INTERRUPTED)',
  idle: 'READY',
  unknown: 'NO STATUS',
  crashed: 'CRASHED',
  stopped: 'NOT RUNNING',
  parked: 'PARKED (NOT RUNNING)',
};

const TEXT: Record<StateLook, string> = {
  question: '? question',
  permission: '? needs permission',
  plan: '? plan to review',
  input: '? needs input',
  limited: '◷ usage limit',
  error: '✕ blocked',
  working: '⟳ working',
  stuck: '⟳ stuck?',
  background: '⟳ background',
  done: '✓ done',
  asked: '✓ asked you',
  interrupted: '■ interrupted',
  idle: '○ ready',
  unknown: '● claude',
  crashed: '✕ crashed',
  stopped: '○ not running',
  parked: '⏸ parked',
};

const LANES: Record<StateLook, string> = {
  question: 'needs',
  permission: 'needs',
  plan: 'needs',
  input: 'needs',
  working: 'working',
  stuck: 'working',
  background: 'working',
  done: 'review',
  asked: 'review',
  interrupted: 'review',
  error: 'review',
  limited: 'review',
  crashed: 'review',
  idle: 'review',
  stopped: 'review',
  parked: 'review',
  unknown: 'review',
};

/** media/board.js's glyph and colour classes. */
const BOARD: Record<StateLook, [string, string]> = {
  question: ['?', 'yellow'],
  permission: ['🛡', 'yellow'],
  plan: ['☑', 'yellow'],
  input: ['🔔', 'yellow'],
  limited: ['◷', 'orange'],
  error: ['✕', 'red'],
  working: ['⟳', 'blue spin'],
  stuck: ['⌚', 'orange'],
  background: ['⟳', 'blue spin'],
  done: ['✓', 'green'],
  asked: ['💬', 'green'],
  interrupted: ['■', 'purple'],
  idle: ['○', 'dim'],
  unknown: ['●', 'dim'],
  crashed: ['⚡', 'red'],
  stopped: ['⊘', 'dim'],
  parked: ['⏸', 'dim'],
};

describe('LOOKS', () => {
  it('draws every look as before', () => {
    const looks = Object.keys(LABELS) as StateLook[];
    expect(Object.keys(LOOKS).sort()).toEqual([...looks].sort());
    for (const look of looks) {
      const l = LOOKS[look];
      expect({ icon: l.codicon, ...(l.themeColor ? { color: l.themeColor } : {}) }, look).toEqual(ICONS[look]);
      expect(l.label, look).toBe(LABELS[look]);
      expect(l.text, look).toBe(TEXT[look]);
      expect(l.lane, look).toBe(LANES[look]);
      expect([l.glyph, l.glyphClass], look).toEqual(BOARD[look]);
    }
  });
});
