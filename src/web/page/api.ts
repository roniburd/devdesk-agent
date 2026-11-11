// The daemon's JSON API (core/web/types.ts). URLs are relative, so a proxy serving the page under a path prefix still
// works; the identity comes from the proxy, so requests carry only the same-origin credentials the browser has.
import type { ErrorCode, ErrorResponse } from '../../core/web/types';

export interface ApiResult<T> {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  data?: T;
  /** The daemon's message for a failed request, or one the page words. */
  error?: string;
  code?: ErrorCode;
}

const MESSAGES: Record<number, string> = {
  0: "Can't reach DevDesk. Check your connection; the page retries on its own.",
  401: 'Access denied: sign in through your proxy again, then reload.',
  403: 'Access denied: this proxy user is not allowed, or web access is not configured (see the DevDesk manual).',
};

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { status: 0, error: MESSAGES[0] };
  }
  let json: unknown;
  if ((res.headers.get('Content-Type') ?? '').includes('application/json')) {
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
  }
  if (res.ok) return { status: res.status, data: json as T };
  const err = json as Partial<ErrorResponse> | undefined;
  const error = typeof err?.error === 'string' && err.error ? err.error : (MESSAGES[res.status] ?? `DevDesk answered ${res.status}.`);
  return { status: res.status, error, code: err?.code };
}
