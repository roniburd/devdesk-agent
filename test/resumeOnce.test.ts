import { describe, expect, it } from 'vitest';
import { runningCopy } from '../src/core/sessions';
import type { SessionCard } from '../src/core/sessions';
import type { RegistryEntry } from '../src/core/sessionInfo';

const card = (id: string, over: Partial<SessionCard> = {}): SessionCard => ({ id, state: 'idle', detail: '', attached: false, ...over });
const parked = card('s1', { sessionId: 's1', state: 'parked', cwd: '/w' });
const alive = (pid: number) => pid !== 999;

describe('runningCopy', () => {
  it('finds nothing when no Claude runs the conversation', () => {
    expect(runningCopy([parked], [], 's1', alive)).toBeUndefined();
  });

  it('finds the card of a hooked session with the same id, in tmux and running', () => {
    const live = card('s1-live', { sessionId: 's1', state: 'done', tmuxSession: 'cc-a', tmuxPane: '%3', pid: 10 });
    expect(runningCopy([parked, live], [], 's1', alive)).toBe(live);
  });

  it('finds a hookless pane whose Claude process the registry says runs the conversation', () => {
    const pane = card('tmux:devdesk:%8', { state: 'unknown', tmuxSession: 'cc-main-2', tmuxPane: '%8', pid: 26612 });
    const registry: RegistryEntry[] = [{ pid: 26612, sessionId: 's1' }];
    expect(runningCopy([parked, pane], registry, 's1', alive)).toBe(pane);
  });

  it('says "elsewhere" when a live process runs it but no tmux card shows it', () => {
    expect(runningCopy([parked], [{ pid: 42, sessionId: 's1' }], 's1', alive)).toBe('elsewhere');
  });

  it('ignores registry entries of dead processes, stopped panes and other conversations', () => {
    const stopped = card('tmux:devdesk:%9', { state: 'stopped', tmuxSession: 'cc-x', tmuxPane: '%9', sessionId: 's1' });
    const other = card('s2', { sessionId: 's2', state: 'idle', tmuxSession: 'cc-b', tmuxPane: '%2', pid: 20 });
    const registry: RegistryEntry[] = [{ pid: 999, sessionId: 's1' }, { pid: 20, sessionId: 's2' }];
    expect(runningCopy([parked, stopped, other], registry, 's1', alive)).toBeUndefined();
  });
});
