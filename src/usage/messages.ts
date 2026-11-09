import { parseScope, type ScopedPage, type UsageScope } from '../core/usageScope';
import type { CountProgress } from '../usageCount';

// The Claude Usage page's protocol. `media/usage.js` handles what the extension posts (`UsageHostMessage`); what it
// posts back is checked by `parseUsageMessage`.

/** How far a count has got, without the days it stored so far. */
export type CountState = Omit<CountProgress, 'stored'>;

/** Messages the extension posts to the page. */
export type UsageHostMessage =
  /** The page, counted to the end. */
  | { type: 'page'; page: ScopedPage }
  /** The days counted so far as a page, shown under how far the count has got until it ends. */
  | { type: 'partial'; page: ScopedPage; progress: CountState }
  /** How far the count has got, with no days stored yet. */
  | { type: 'progress'; progress: CountState }
  /** The count failed. */
  | { type: 'error'; message: string };

/**
 * Messages the page sends; anything else is ignored. `ready`: it loaded; `refresh`: its ↻ (count again); `settings`:
 * its ⚙; `setScope`: a project or worktree chosen in its selects.
 */
export type UsagePageMessage = { type: 'ready' } | { type: 'refresh' } | { type: 'settings' } | { type: 'setScope'; scope: UsageScope };

/** What the page sent, checked field by field; undefined for anything the page does not handle. */
export function parseUsageMessage(m: unknown): UsagePageMessage | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  if (o.type === 'ready' || o.type === 'refresh' || o.type === 'settings') return { type: o.type };
  if (o.type === 'setScope') {
    const scope = parseScope(o.scope);
    return scope ? { type: 'setScope', scope } : undefined;
  }
  return undefined;
}
