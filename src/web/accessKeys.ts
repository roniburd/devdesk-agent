import { type AccessKeys, accessCertsUrl, parseAccessCerts } from '../core/web/cfAccess';

/**
 * The Cloudflare Access team's signing keys, for `cloudflare` auth: fetched at start, every hour (Cloudflare rotates
 * them about every 6 weeks and keeps the old one for 7 days), and when a token names a key not fetched yet (at most
 * once every 30 s). Until a fetch succeeds there are no keys, and every request is denied.
 */

const REFRESH_MS = 60 * 60_000;
const MIN_GAP_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

export class AccessKeyCache {
  private keys: AccessKeys | undefined;
  private last = 0;
  private fetching: Promise<void> | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly team: string,
    private readonly log: (message: string) => void,
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetch,
  ) {
    this.timer = setInterval(() => void this.refresh(true), REFRESH_MS);
    this.timer.unref();
  }

  get current(): AccessKeys | undefined {
    return this.keys;
  }

  /** Fetches the keys again, unless the last try was under 30 s ago (`force`: the hourly refresh). */
  refresh(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    if (!force && Date.now() - this.last < MIN_GAP_MS) return Promise.resolve();
    this.last = Date.now();
    const url = accessCertsUrl(this.team);
    this.fetching = this.fetchJson(url)
      .then((raw) => {
        const keys = parseAccessCerts(raw);
        if (!keys.size) throw new Error('no RSA keys in the response');
        this.keys = keys;
      })
      .catch((err: unknown) => this.log(`cannot fetch the Cloudflare Access keys from ${url}: ${(err as Error).message}`))
      .finally(() => {
        this.fetching = undefined;
      });
    return this.fetching;
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

async function defaultFetch(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
