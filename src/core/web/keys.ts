import { isPaneId } from '../tmux';
import { WEB_KEYS, type WebKey } from './types';

/** The keys the page may press in a session's pane: a dialog's choices, Enter, Escape (also to interrupt) and arrows. */
export const isWebKey = (k: unknown): k is WebKey => typeof k === 'string' && (WEB_KEYS as readonly string[]).includes(k);

/** ['send-keys', '-t', target, key]; throws on a target that is not a pane id / `=session:` (as sendKeysArgs) or a key not in WEB_KEYS. */
export function keyArgs(target: string, key: WebKey): string[] {
  if (!isPaneId(target) && !/^=[^:;]+:$/.test(target)) throw new Error(`not a tmux pane target: ${target}`);
  if (!isWebKey(key)) throw new Error(`not a key web access sends: ${String(key)}`);
  return ['send-keys', '-t', target, key];
}
