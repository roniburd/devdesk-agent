import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionCard } from '../core/sessions';
import { type ActionDeps, type ActionResult, pressKey, sendText, sessionDetail, startSession } from '../core/web/actions';
import { answeredPublicHost, authorize, deniedPage, hostAllowed, mutationCheck, SECURITY_HEADERS } from '../core/web/auth';
import { webCards, webFolders, type WebView } from '../core/web/cards';
import { readFile } from 'node:fs/promises';
import type { DaemonConfig } from '../core/web/config';
import { pollLoop } from '../core/web/pollLoop';
import { isMutating, MAX_BODY_BYTES, parseKeyBody, parseNewSessionBody, parseRoute, parseSendBody, type Route } from '../core/web/routes';
import type { SessionSnapshot } from '../core/web/snapshot';
import { parseWebSeen, webSeenPath, webUnread } from '../core/web/webState';
import type { CardsResponse, ErrorCode, ErrorResponse } from '../core/web/types';
import type { PageAssets } from './pageAssets';

/**
 * The web access HTTP server: `node:http` on 127.0.0.1 only, wired to the web core. Every request, the page's assets
 * and the event stream included, goes through the same gates in this order: Host, auth, route, then for POSTs
 * Content-Type and Origin, then the body size. Everything the routes do is the core's (actions.ts, cards.ts).
 */

/** The only address the daemon listens on. There is no setting, flag or variable for it. */
export const LOOPBACK = '127.0.0.1';

export interface WebServerOptions {
  config: DaemonConfig;
  snapshot: Pick<SessionSnapshot, 'cards' | 'features' | 'sessionNames'>;
  actions: ActionDeps;
  page: PageAssets;
  /** config.publicHost || the tunnel's. */
  publicHost: () => string;
  log: (line: string) => void;
}

export interface WebServer {
  /** Always on LOOPBACK. Rejects with node's error (`EADDRINUSE`). */
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  /** SSE clients (the poll runs while > 0). */
  readonly clients: number;
}

/** A comment line on the event stream this often keeps proxies from closing it. */
const PING_MS = 15_000;

const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const ASSET_TYPES = { html: HTML_TYPE, js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' } as const;

const CODES: Readonly<Record<number, ErrorCode>> = {
  400: 'bad-request',
  403: 'forbidden',
  404: 'not-found',
  405: 'not-found',
  409: 'blocked',
  410: 'ended',
  413: 'too-large',
  415: 'unsupported-type',
  502: 'tmux',
};

class BodyTooLarge extends Error {}

/** The request body, at most MAX_BODY_BYTES (BodyTooLarge past that, before reading the rest). */
function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return Promise.reject(new BodyTooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createWebServer(o: WebServerOptions): WebServer {
  const { config, snapshot, actions, page, log } = o;
  const sse = new Set<ServerResponse>();
  let lastSent: string | undefined;
  let ping: NodeJS.Timeout | undefined;
  let cached: { at: number; cards: SessionCard[] } | undefined;

  /** Cards for GETs: a snapshot at most pollMs old (Decision 6). */
  const recentCards = async () => {
    const now = Date.now();
    if (cached && now - cached.at < config.pollMs) return cached.cards;
    const cards = await snapshot.cards();
    cached = { at: Date.now(), cards };
    return cards;
  };
  /** Cards for actions: a fresh snapshot, so an action only reaches a session that is live and in scope now. */
  const freshCards = async () => {
    const cards = await snapshot.cards();
    cached = { at: Date.now(), cards };
    return cards;
  };
  /** What the Claude view goes by: its read marks (seen.json, from the extension) and the idle and stuck limits. */
  const view = async (cards: readonly SessionCard[]): Promise<WebView> => {
    const seen = parseWebSeen(await readFile(webSeenPath(config.webDir), 'utf8').catch(() => ''));
    return { now: Date.now(), stuckMs: config.stuckMs, idleMs: config.idleMs, unread: webUnread(seen, cards) };
  };
  const cardsResponse = async (cards: readonly SessionCard[]): Promise<CardsResponse> => {
    const v = await view(cards);
    return { cards: webCards(cards, v), at: v.now };
  };
  const serverOf = (card: SessionCard) => card.tmuxServer ?? config.tmux.server;

  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON_TYPE, JSON.stringify(body));
  const sendError = (res: ServerResponse, status: number, error: string, extra?: Record<string, string>) =>
    send(res, status, JSON_TYPE, JSON.stringify({ error, code: CODES[status] ?? 'bad-request' } satisfies ErrorResponse), extra);
  const sendResult = (res: ServerResponse, r: ActionResult<unknown>) => sendJson(res, r.status, r.body);

  // The event stream: every client gets the cards at connect; while any is connected the snapshot is read every
  // pollMs and sent to all of them when the cards changed.
  const event = (body: CardsResponse) => `event: cards\ndata: ${JSON.stringify(body)}\n\n`;
  const broadcast = (text: string) => {
    for (const res of sse) res.write(text);
  };
  // One poll chain however clients come and go, even while a tick waits on tmux (pollLoop).
  const poll = pollLoop(async () => {
    try {
      const cards = await freshCards();
      if (!sse.size) return;
      const body = await cardsResponse(cards);
      const key = JSON.stringify(body.cards);
      if (key !== lastSent) {
        lastSent = key;
        broadcast(event(body));
      }
    } catch (err) {
      log(`poll failed: ${(err as Error).message}`);
    }
  }, config.pollMs);
  const startLoop = () => {
    poll.start();
    ping ??= setInterval(() => broadcast(': ping\n\n'), PING_MS);
  };
  const stopLoop = () => {
    poll.stop();
    clearInterval(ping);
    ping = undefined;
    lastSent = undefined;
  };
  const openEvents = async (res: ServerResponse) => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    sse.add(res);
    res.on('close', () => {
      sse.delete(res);
      if (!sse.size) stopLoop();
    });
    startLoop();
    const body = await cardsResponse(await recentCards());
    if (!sse.has(res)) return;
    lastSent ??= JSON.stringify(body.cards);
    res.write(event(body));
  };

  /** The card `id` among the live cards in scope, else a 404 sent. */
  const cardFor = async (res: ServerResponse, id: string) => {
    const card = (await freshCards()).find((c) => c.id === id);
    if (!card) sendError(res, 404, 'There is no such session.');
    return card;
  };

  const run = async (req: IncomingMessage, res: ServerResponse, route: Route): Promise<void> => {
    switch (route.kind) {
      case 'page':
        return send(res, 200, ASSET_TYPES[route.asset], page[route.asset]);
      case 'cards':
        return sendJson(res, 200, await cardsResponse(await recentCards()));
      case 'events':
        return openEvents(res);
      case 'folders':
        return sendJson(res, 200, { folders: webFolders(await snapshot.features()) });
      case 'detail': {
        const card = await cardFor(res, route.id);
        if (card) sendResult(res, await sessionDetail(card, { ...(await view(await recentCards())), server: serverOf(card) }, actions));
        return;
      }
      default:
        return mutate(req, res, route);
    }
  };

  /** A POST that passed the request checks: its body read (capped) and parsed, then the action. */
  const mutate = async (req: IncomingMessage, res: ServerResponse, route: Route): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch (err) {
      if (err instanceof BodyTooLarge) return sendError(res, 413, `The request is over ${MAX_BODY_BYTES / 1024} KiB.`, { Connection: 'close' });
      return sendError(res, 400, 'The request body is not JSON.');
    }
    if (route.kind === 'send') {
      const body = parseSendBody(raw);
      if ('status' in body) return sendError(res, body.status, body.error);
      const card = await cardFor(res, route.id);
      if (card) sendResult(res, await sendText(card, body.text, serverOf(card), actions));
    } else if (route.kind === 'key') {
      const body = parseKeyBody(raw);
      if ('status' in body) return sendError(res, body.status, body.error);
      const card = await cardFor(res, route.id);
      if (card) sendResult(res, await pressKey(card, body.key, serverOf(card), actions));
    } else if (route.kind === 'start') {
      const body = parseNewSessionBody(raw);
      if ('status' in body) return sendError(res, body.status, body.error);
      const [features, names] = await Promise.all([snapshot.features(), snapshot.sessionNames()]);
      sendResult(res, await startSession(body, features, names, config, actions));
      cached = undefined;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const api = path.startsWith('/api/');
    const publicHost = answeredPublicHost(config, o.publicHost());
    const deny = (html: string, message: string) => (api ? sendError(res, 403, message) : send(res, 403, HTML_TYPE, html));

    if (!hostAllowed(req.headers.host, config.port, publicHost)) return deny(deniedPage({ reason: 'host' }), 'This host is not allowed.');
    const auth = authorize(req.headers, config);
    if (!auth.ok) return deny(deniedPage(auth), 'Access denied.');
    const route = parseRoute(method, path);
    if ('status' in route) {
      return route.status === 405 ? sendError(res, 405, 'Method not allowed.', { Allow: 'GET, POST' }) : sendError(res, 404, 'Not found.');
    }
    if (!isMutating(route)) return run(req, res, route);
    const check = mutationCheck(req.headers, config.port, publicHost);
    if (!check.ok) {
      sendError(res, check.status, check.message);
    } else {
      await run(req, res, route);
    }
    // One line per action: what, how it went and who; never the text typed.
    const id = 'id' in route ? ` ${route.id}` : '';
    log(`${method} ${route.kind}${id} ${res.statusCode}${auth.user !== undefined ? ` user=${auth.user}` : ''}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`${req.method} ${req.url} failed: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) sendError(res, 500, 'Something went wrong in DevDesk.');
      else res.end();
    });
  });
  // Clients that never finish sending a request are dropped (the event stream is a response, so it stays open).
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: config.port, host: LOOPBACK, exclusive: true }, () => {
          server.off('error', reject);
          const addr = server.address();
          resolve({ port: typeof addr === 'object' && addr ? addr.port : config.port });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        stopLoop();
        for (const res of sse) res.end();
        sse.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    get clients() {
      return sse.size;
    },
  };
}
