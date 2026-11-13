import { isWebKey } from './keys';
import { MAX_TERM_INPUT_BYTES, termSizeOf } from './terminal';
import type { KeyRequest, NewSessionRequest, SendRequest, TermInputRequest, TermResizeRequest } from './types';

/** The web access routes (see the table in the plan): which request is which, and their bodies checked. */
export type Route =
  | { kind: 'page'; asset: 'html' | 'js' | 'css' | 'termJs' | 'termCss' }
  | { kind: 'settings' }
  | { kind: 'term'; id: string }
  | { kind: 'term-input'; id: string }
  | { kind: 'term-resize'; id: string }
  | { kind: 'cards' }
  | { kind: 'events' }
  | { kind: 'folders' }
  | { kind: 'composer' }
  | { kind: 'detail'; id: string }
  | { kind: 'send'; id: string }
  | { kind: 'key'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'start' };

export const isMutating = (r: Route) =>
  r.kind === 'send' || r.kind === 'key' || r.kind === 'resume' || r.kind === 'start' || r.kind === 'term-input' || r.kind === 'term-resize';

/** Request bodies over this many bytes get 413 before parsing. */
export const MAX_BODY_BYTES = 131072;
/** Text typed into a session, or a new session's prompt, is at most this many UTF-8 bytes. */
export const MAX_TEXT_BYTES = 65536;

const FIXED: Readonly<Record<string, { GET?: Route; POST?: Route }>> = {
  '/': { GET: { kind: 'page', asset: 'html' } },
  '/app.js': { GET: { kind: 'page', asset: 'js' } },
  '/app.css': { GET: { kind: 'page', asset: 'css' } },
  '/term.js': { GET: { kind: 'page', asset: 'termJs' } },
  '/term.css': { GET: { kind: 'page', asset: 'termCss' } },
  '/api/settings': { GET: { kind: 'settings' } },
  '/api/sessions': { GET: { kind: 'cards' }, POST: { kind: 'start' } },
  '/api/events': { GET: { kind: 'events' } },
  '/api/folders': { GET: { kind: 'folders' } },
  '/api/composer': { GET: { kind: 'composer' } },
};

const decode = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/** `path` without the query; ids are decodeURIComponent'd (a malformed escape, `.`, `..` or a `/` in one is 404). */
export function parseRoute(method: string, path: string): Route | { status: 404 | 405 } {
  const p = path.split('?')[0];
  const by = (routes: { GET?: Route; POST?: Route }) => (method === 'GET' || method === 'POST' ? routes[method] : undefined) ?? { status: 405 as const };
  if (Object.hasOwn(FIXED, p)) return by(FIXED[p]);
  const m = /^\/api\/sessions\/([^/]+)(?:\/(send|key|resume|term|term\/input|term\/resize))?$/.exec(p);
  if (!m) return { status: 404 };
  const id = decode(m[1]);
  if (!id || id === '.' || id === '..' || id.includes('/')) return { status: 404 };
  if (!m[2]) return by({ GET: { kind: 'detail', id } });
  if (m[2] === 'term') return by({ GET: { kind: 'term', id } });
  if (m[2] === 'term/input') return by({ POST: { kind: 'term-input', id } });
  if (m[2] === 'term/resize') return by({ POST: { kind: 'term-resize', id } });
  if (m[2] === 'resume') return by({ POST: { kind: 'resume', id } });
  return by({ POST: m[2] === 'send' ? { kind: 'send', id } : { kind: 'key', id } });
}

type BodyError = { status: 400 | 413; error: string };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tooLong = (s: string) => Buffer.byteLength(s, 'utf8') > MAX_TEXT_BYTES;

export function parseSendBody(raw: unknown): SendRequest | BodyError {
  if (!isObject(raw) || typeof raw.text !== 'string') return { status: 400, error: 'Send {"text": "…"}.' };
  if (!raw.text.trim()) return { status: 400, error: 'There is nothing to send.' };
  if (tooLong(raw.text)) return { status: 413, error: `The text is over ${MAX_TEXT_BYTES / 1024} KiB.` };
  return { text: raw.text };
}

export function parseKeyBody(raw: unknown): KeyRequest | { status: 400; error: string } {
  if (!isObject(raw) || !isWebKey(raw.key)) return { status: 400, error: 'Not a key web access can press.' };
  return { key: raw.key };
}

export function parseNewSessionBody(raw: unknown): NewSessionRequest | BodyError {
  if (!isObject(raw) || typeof raw.dir !== 'string' || !raw.dir) return { status: 400, error: 'Send {"dir": "…", "prompt": "…"}.' };
  const prompt = raw.prompt === undefined ? '' : raw.prompt;
  if (typeof prompt !== 'string') return { status: 400, error: 'The prompt must be text.' };
  if (tooLong(prompt)) return { status: 413, error: `The prompt is over ${MAX_TEXT_BYTES / 1024} KiB.` };
  const out: NewSessionRequest = { dir: raw.dir, prompt };
  for (const k of ['mode', 'model', 'effort'] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 512) return { status: 400, error: `The ${k} must be a name.` };
    out[k] = v;
  }
  return out;
}

/** A terminal id as the stream's `hello` gives it. */
const isTermId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

export function parseTermInputBody(raw: unknown): TermInputRequest | BodyError {
  if (!isObject(raw) || !isTermId(raw.term) || typeof raw.data !== 'string') return { status: 400, error: 'Send {"term": "…", "data": "…"}.' };
  if (!raw.data) return { status: 400, error: 'There is nothing to send.' };
  if (Buffer.byteLength(raw.data, 'utf8') > MAX_TERM_INPUT_BYTES) return { status: 413, error: `The input is over ${MAX_TERM_INPUT_BYTES / 1024} KiB.` };
  return { term: raw.term, data: raw.data };
}

export function parseTermResizeBody(raw: unknown): TermResizeRequest | BodyError {
  const size = isObject(raw) ? termSizeOf(raw.cols, raw.rows) : undefined;
  if (!isObject(raw) || !isTermId(raw.term) || !size) return { status: 400, error: 'Send {"term": "…", "cols": N, "rows": N}.' };
  return { term: raw.term, ...size };
}
