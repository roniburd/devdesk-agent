/** Reading what the tunnel command (`devdesk.web.tunnelCommand`) prints: its public URL, and its last error line. */

export const TUNNEL_URL_TIMEOUT_MS = 60_000;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
const stripAnsi = (s: string) => s.replace(ANSI, '');

/** The first https://… URL in `text` (up to whitespace, quotes or `>`), ANSI stripped; undefined when none. */
export function firstHttpsUrl(text: string): string | undefined {
  for (const m of stripAnsi(text).matchAll(/https:\/\/[^\s"'<>`]+/g)) {
    try {
      if (new URL(m[0]).hostname) return m[0];
    } catch {
      // not a URL: look further
    }
  }
  return undefined;
}

/** Lower-cased host[:port] of an https URL; undefined when not https (or it carries credentials). */
export function publicHostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return undefined;
    return u.host.toLowerCase();
  } catch {
    return undefined;
  }
}

const LINE_MAX = 500;

/** Keeps the last non-empty line of a stream fed in chunks (for tunnelError). */
export class LastLine {
  private partial = '';
  private last = '';

  push(chunk: string): void {
    const parts = (this.partial + chunk).split('\n');
    this.partial = (parts.pop() ?? '').slice(-LINE_MAX * 4);
    for (const p of parts) this.take(p);
  }

  /** The last non-empty line, the unfinished one included. */
  get value(): string {
    return clean(this.partial) || this.last;
  }

  private take(line: string): void {
    const c = clean(line);
    if (c) this.last = c;
  }
}

const clean = (line: string) => stripAnsi(line).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, LINE_MAX);
