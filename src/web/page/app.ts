// The web access page: the session list, a session's transcript and screen with a reply box or dialog keys, and New.
// Hash routes `#/`, `#/s/<id>`, `#/new`. It talks only to the daemon's JSON API (core/web/types.ts), with relative URLs.
// All data goes in as text (dom.ts, screen.ts), never as markup; no inline script or style (CSP `default-src 'self'`).
import type {
  CardsResponse,
  FoldersResponse,
  KeyRequest,
  NewSessionRequest,
  NewSessionResponse,
  OkResponse,
  SendRequest,
  SessionDetail,
  Turn,
  WebCard,
  WebFolder,
  WebGroup,
  WebKey,
} from '../../core/web/types';
import { api } from './api';
import { h, sentenceCase, sessionHref } from './dom';
import { renderScreen } from './screen';

/** Stream errors in a row before the list falls back to polling `api/sessions`. */
const STREAM_ERRORS = 3;
const FALLBACK_POLL_MS = 5000;
/** While polling, how often the page tries the event stream again. */
const STREAM_RETRY_MS = 30_000;
const DETAIL_POLL_MS = 2000;
const ENDED_BACK_MS = 2000;
const NEW_SESSION_WAIT_MS = 30_000;

// ---- The card feed: one event stream for every screen, or polling when the stream keeps failing. ----

type Link = 'connecting' | 'live' | 'polling';
const feed = {
  cards: undefined as WebCard[] | undefined,
  link: 'connecting' as Link,
  error: undefined as string | undefined,
  listeners: new Set<() => void>(),
};
let stream: EventSource | undefined;
let streamErrors = 0;
let pollTimer: number | undefined;
let retryTimer: number | undefined;

function notify(): void {
  for (const fn of [...feed.listeners]) fn();
}

function gotCards(r: CardsResponse | undefined): void {
  if (!r || !Array.isArray(r.cards)) return;
  feed.cards = r.cards;
  feed.error = undefined;
  notify();
}

function openStream(): void {
  if (stream) return;
  if (typeof EventSource === 'undefined') return startPolling();
  const es = new EventSource('api/events');
  stream = es;
  es.addEventListener('open', () => {
    streamErrors = 0;
    stopPolling();
    feed.link = 'live';
    notify();
  });
  es.addEventListener('cards', (e) => {
    streamErrors = 0;
    stopPolling();
    feed.link = 'live';
    try {
      gotCards(JSON.parse((e as MessageEvent<string>).data) as CardsResponse);
    } catch {
      // A garbled event: the next one replaces it.
    }
  });
  es.addEventListener('error', () => {
    streamErrors++;
    // The browser reconnects on its own unless the stream is closed (a 403, for one).
    if (streamErrors < STREAM_ERRORS && es.readyState !== 2) return;
    es.close();
    if (stream === es) stream = undefined;
    startPolling();
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(openStream, STREAM_RETRY_MS);
  });
}

async function pollOnce(): Promise<void> {
  const r = await api<CardsResponse>('GET', 'api/sessions');
  if (r.data) gotCards(r.data);
  else {
    feed.error = r.error;
    notify();
  }
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  feed.link = 'polling';
  notify();
  void pollOnce();
  pollTimer = window.setInterval(() => void pollOnce(), FALLBACK_POLL_MS);
}

function stopPolling(): void {
  if (pollTimer === undefined) return;
  window.clearInterval(pollTimer);
  pollTimer = undefined;
}

/** Each card's pane as last seen, so a session whose id changes (tmux:… to its session id) can be followed. */
const paneOf = new Map<string, string>();
feed.listeners.add(() => {
  for (const c of feed.cards ?? []) if (c.pane) paneOf.set(c.id, c.pane);
});

// ---- Views ----

interface View {
  el: HTMLElement;
  dispose(): void;
}

const GROUPS: ReadonlyArray<{ group: WebGroup; title: string }> = [
  { group: 'needs', title: 'Needs you' },
  { group: 'working', title: 'Working' },
  { group: 'rest', title: 'Other' },
];

const LINK_TEXT: Record<Link, string> = { connecting: 'Connecting', live: 'Live', polling: 'Reconnecting' };

/** The feed's state, updated in place. */
function showLink(badge: HTMLElement): void {
  badge.className = `link link-${feed.link}`;
  badge.textContent = LINK_TEXT[feed.link];
}

/** The state's glyph; a working state gets a small ring spinner (app.css) instead of a rotating text glyph. */
function stateGlyph(c: WebCard): HTMLElement {
  return c.spin
    ? h('span', { class: 'glyph spin', attrs: { 'aria-hidden': 'true' } })
    : h('span', { class: 'glyph', text: c.glyph, attrs: { 'aria-hidden': 'true' } });
}

function cardRow(c: WebCard): HTMLElement {
  return h(
    'a',
    { class: `card tone-${c.tone}`, attrs: { href: sessionHref(c.id) } },
    stateGlyph(c),
    h(
      'span',
      { class: 'body' },
      h('span', { class: 'top' }, h('span', { class: 'title', text: c.title }), c.ago ? h('span', { class: 'ago', text: c.ago }) : null),
      h('span', { class: 'meta' }, h('span', { class: 'label', text: sentenceCase(c.label) }), c.feature ? h('span', { class: 'feature', text: c.feature }) : null),
      c.line ? h('span', { class: 'line', text: c.line }) : null,
    ),
  );
}

function listView(): View {
  const badge = h('span', { attrs: { role: 'status' } });
  const body = h('div', { class: 'content list' });
  const el = h(
    'div',
    { class: 'view view-list' },
    h(
      'header',
      { class: 'bar' },
      h('h1', { class: 'heading', text: 'Claude sessions' }),
      badge,
      h('button', { class: 'button primary new', text: 'New session', attrs: { type: 'button' }, on: { click: () => go('#/new') } }),
    ),
    body,
  );
  const render = () => {
    showLink(badge);
    const cards = feed.cards;
    if (!cards) {
      body.replaceChildren(h('p', { class: feed.error ? 'notice error' : 'notice', text: feed.error ?? 'Loading sessions…' }));
      return;
    }
    if (cards.length === 0) {
      body.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          h('p', { text: 'No Claude sessions are running.' }),
          h('button', { class: 'button primary', text: 'Start a session', attrs: { type: 'button' }, on: { click: () => go('#/new') } }),
        ),
      );
      return;
    }
    const sections = GROUPS.map(({ group, title }) => {
      const mine = cards.filter((c) => c.group === group);
      if (mine.length === 0) return null;
      return h(
        'section',
        { class: `group group-${group}`, attrs: { 'data-group': group, 'aria-label': title } },
        h('h2', { class: 'group-title' }, title, h('span', { class: 'count', text: String(mine.length) })),
        h('div', { class: 'cards' }, ...mine.map(cardRow)),
      );
    });
    body.replaceChildren(...sections.filter((s): s is HTMLElement => s !== null));
    if (feed.error) body.prepend(h('p', { class: 'notice error', text: feed.error }));
  };
  feed.listeners.add(render);
  render();
  return { el, dispose: () => feed.listeners.delete(render) };
}

type Tab = 'transcript' | 'screen';

const TYPED_NOTE = "Text is already typed at Claude's prompt (see Screen): clear it in the session's terminal, then send.";

const KEYS: ReadonlyArray<{ key: WebKey; text: string; label: string; wide?: boolean }> = [
  { key: '1', text: '1', label: 'Option 1' },
  { key: '2', text: '2', label: 'Option 2' },
  { key: '3', text: '3', label: 'Option 3' },
  { key: 'Up', text: '↑', label: 'Up' },
  { key: 'Down', text: '↓', label: 'Down' },
  { key: 'Escape', text: 'Esc', label: 'Escape' },
  { key: 'Enter', text: 'Enter', label: 'Enter', wide: true },
];

function turnEl(t: Turn): HTMLElement {
  return h('li', { class: `turn turn-${t.kind}`, text: t.text, attrs: { 'data-kind': t.kind } });
}

function sessionView(id: string): View {
  let card: WebCard | undefined = feed.cards?.find((c) => c.id === id);
  let tab: Tab = 'transcript';
  let dialog = false;
  let ended = false;
  let lost = false;
  let loadFailed = false;
  let busy = false;
  let disposed = false;
  let timer: number | undefined;
  let turnsKey = '';
  let screenKey = '';

  const title = h('h1', { class: 'heading title', text: card?.title ?? 'Session' });
  const state = h('span', { class: 'state' });
  const tabButtons = {
    transcript: h('button', { class: 'tab', text: 'Transcript', attrs: { type: 'button', role: 'tab' }, on: { click: () => pick('transcript') } }),
    screen: h('button', { class: 'tab', text: 'Screen', attrs: { type: 'button', role: 'tab' }, on: { click: () => pick('screen') } }),
  };
  const turns = h('ol', { class: 'turns' });
  const screen = h('div', { class: 'term', attrs: { role: 'img', 'aria-label': 'Terminal screen' } });
  const panels = {
    transcript: h('section', { class: 'panel transcript', attrs: { role: 'tabpanel' } }, turns),
    screen: h('section', { class: 'panel screen', attrs: { role: 'tabpanel' } }, screen),
  };
  const notice = h('p', { class: 'notice', attrs: { 'aria-live': 'polite' }, text: '' });
  notice.hidden = true;

  const text = h('textarea', {
    class: 'reply-text',
    attrs: { rows: '2', placeholder: 'Reply to Claude', 'aria-label': 'Reply', autocomplete: 'off', autocapitalize: 'sentences' },
    on: {
      keydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      },
    },
  });
  const sendButton = h('button', { class: 'button primary send', text: 'Send', attrs: { type: 'submit' } });
  const interrupt = h(
    'button',
    { class: 'button interrupt', attrs: { type: 'button', 'data-key': 'Escape', 'aria-label': 'Interrupt (Esc)', hidden: '' }, on: { click: () => void key('Escape') } },
    h('span', { class: 'key-cap', text: 'Esc' }),
    h('span', { class: 'key-sub', text: 'Interrupt' }),
  );
  const reply = h(
    'form',
    {
      class: 'reply',
      on: {
        submit: (e) => {
          e.preventDefault();
          void send();
        },
      },
    },
    text,
    h('div', { class: 'reply-actions' }, interrupt, sendButton),
  );
  const keys = h(
    'div',
    { class: 'keys', attrs: { role: 'group', 'aria-label': 'Answer the dialog' } },
    ...KEYS.map((k) =>
      h('button', {
        class: `button key${k.wide ? ' wide' : ''}${k.key === 'Up' || k.key === 'Down' ? ' arrow' : ''}`,
        text: k.text,
        attrs: { type: 'button', 'data-key': k.key, 'aria-label': k.label },
        on: { click: () => void key(k.key) },
      }),
    ),
  );
  const endedBox = h('div', { class: 'ended', attrs: { role: 'status' } });
  endedBox.hidden = true;
  const dock = h('footer', { class: 'dock' }, notice, reply, keys, endedBox);
  keys.hidden = true;

  const el = h(
    'div',
    { class: 'view view-session' },
    h(
      'header',
      { class: 'bar' },
      h('a', { class: 'back', text: 'Sessions', attrs: { href: '#/', 'aria-label': 'Back to sessions' } }),
      h('div', { class: 'titles' }, title, state),
    ),
    h('nav', { class: 'tabs', attrs: { role: 'tablist' } }, tabButtons.transcript, tabButtons.screen),
    h('div', { class: 'content panels' }, panels.transcript, panels.screen),
    dock,
  );

  function say(message: string | undefined, error = true): void {
    notice.textContent = message ?? '';
    notice.hidden = !message;
    notice.classList.toggle('error', error);
  }

  function pick(t: Tab): void {
    tab = t;
    for (const k of ['transcript', 'screen'] as const) {
      panels[k].hidden = k !== t;
      tabButtons[k].setAttribute('aria-selected', String(k === t));
    }
    if (t === 'screen') scrollToEnd(panels.screen);
  }

  function showCard(c: WebCard): void {
    card = c;
    title.textContent = c.title;
    state.className = `state tone-${c.tone}`;
    state.replaceChildren(stateGlyph(c), sentenceCase(c.label));
  }

  function nearEnd(box: HTMLElement): boolean {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }
  function scrollToEnd(box: HTMLElement): void {
    box.scrollTop = box.scrollHeight;
  }

  function showDetail(d: SessionDetail): void {
    showCard(d.card);
    const tk = JSON.stringify(d.turns);
    if (tk !== turnsKey) {
      const stick = turnsKey === '' || nearEnd(panels.transcript);
      turnsKey = tk;
      turns.replaceChildren(...(d.turns.length ? d.turns.map(turnEl) : [h('li', { class: 'turn turn-none', text: 'Nothing said yet.' })]));
      if (stick) scrollToEnd(panels.transcript);
    }
    const sk = JSON.stringify(d.screen);
    if (sk !== screenKey) {
      const stick = screenKey === '' || nearEnd(panels.screen);
      screenKey = sk;
      if (d.screen.length) renderScreen(screen, d.screen);
      else screen.replaceChildren(h('div', { class: 'row', text: 'This session has no terminal screen.' }));
      if (stick) scrollToEnd(panels.screen);
    }
    const open = d.prompt.dialog;
    if (open && !dialog) pick('screen');
    dialog = open;
    reply.hidden = open;
    keys.hidden = !open;
    // The hooks know when a turn ends; the spinner on screen is only a fallback for sessions without hooks.
    interrupt.hidden = !(d.card.state === 'working' || (d.card.state === 'unknown' && d.prompt.working));
    text.disabled = !d.card.canSend;
    sendButton.disabled = busy || !d.card.canSend;
    if (!d.card.canSend) say('This session has no terminal to type into.', false);
    else {
      // Text already typed at Claude's prompt (not a dialog): sending is refused until it is cleared, so say why up front.
      const typed = !open && !d.prompt.empty && !d.prompt.inMode && !d.prompt.exited;
      if (typed) say(TYPED_NOTE, false);
      else if (notice.textContent === TYPED_NOTE) say(undefined);
    }
  }

  function end(message = 'Session ended'): void {
    if (ended) return;
    ended = true;
    window.clearTimeout(timer);
    reply.hidden = true;
    keys.hidden = true;
    say(undefined);
    endedBox.replaceChildren(h('strong', { text: message }), h('span', { text: 'Going back to your sessions…' }));
    endedBox.hidden = false;
    window.setTimeout(() => {
      if (!disposed) go('#/');
    }, ENDED_BACK_MS);
  }

  /** A 404: the card's id may have changed (tmux:… to the session id once its hooks report). Follow its pane. */
  function follow(): boolean {
    const pane = card?.pane ?? paneOf.get(id);
    const next = pane ? feed.cards?.find((c) => c.pane === pane && c.id !== id) : undefined;
    if (!next) return false;
    location.replace(sessionHref(next.id));
    return true;
  }

  async function load(): Promise<void> {
    window.clearTimeout(timer);
    if (disposed || ended) return;
    const r = await api<SessionDetail>('GET', `api/sessions/${encodeURIComponent(id)}`);
    if (disposed || ended) return;
    if (r.data) {
      lost = false;
      if (r.data.ended) return end();
      showDetail(r.data);
      // A failed load's message goes once a load works; an action's (a 409) stays until the next action.
      if (loadFailed) say(undefined);
      loadFailed = false;
    } else if (r.status === 404) {
      if (follow()) return;
      lost = true;
      loadFailed = true;
      say('Looking for this session… It may have ended.', false);
    } else if (r.status === 410) return end();
    else {
      loadFailed = true;
      say(r.error);
    }
    // Another load (an action's) may have run meanwhile and scheduled its own: keep one poll going.
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(), DETAIL_POLL_MS);
  }

  async function post<T>(path: string, body: unknown): Promise<boolean> {
    busy = true;
    sendButton.disabled = true;
    for (const b of keys.querySelectorAll('button')) b.disabled = true;
    interrupt.disabled = true;
    const r = await api<T>('POST', `api/sessions/${encodeURIComponent(id)}/${path}`, body);
    busy = false;
    sendButton.disabled = !(card?.canSend ?? true);
    for (const b of keys.querySelectorAll('button')) b.disabled = false;
    interrupt.disabled = false;
    if (disposed) return false;
    if (r.status === 410) {
      end();
      return false;
    }
    loadFailed = false;
    say(r.error);
    void load();
    return !r.error;
  }

  async function send(): Promise<void> {
    const value = text.value;
    if (busy || !value.trim()) return;
    const body: SendRequest = { text: value };
    if (await post<OkResponse>('send', body)) {
      // Only clear what was sent: anything typed while it went stays.
      if (text.value === value) text.value = '';
    }
  }

  async function key(k: WebKey): Promise<void> {
    if (busy) return;
    const body: KeyRequest = { key: k };
    await post<OkResponse>('key', body);
  }

  const onCards = () => {
    const c = feed.cards?.find((x) => x.id === id);
    if (c && !ended) showCard(c);
    if (lost) follow();
  };
  feed.listeners.add(onCards);
  if (card) showCard(card);
  pick('transcript');
  void load();
  return {
    el,
    dispose: () => {
      disposed = true;
      window.clearTimeout(timer);
      feed.listeners.delete(onCards);
    },
  };
}

function newView(): View {
  let disposed = false;
  let waiting: { tmuxSession: string; until: number } | undefined;
  let waitTimer: number | undefined;
  const notice = h('p', { class: 'notice', attrs: { 'aria-live': 'polite' } });
  notice.hidden = true;
  const list = h('div', { class: 'folders', attrs: { role: 'radiogroup', 'aria-label': 'Folder' } }, h('p', { class: 'hint', text: 'Loading folders…' }));
  const prompt = h('textarea', {
    class: 'prompt',
    attrs: { rows: '5', placeholder: 'What should Claude do? You can leave this empty.', 'aria-label': 'Prompt', autocapitalize: 'sentences' },
  });
  const start = h('button', { class: 'button primary start', text: 'Start session', attrs: { type: 'submit' } });
  start.disabled = true;

  const say = (message: string | undefined, error = true) => {
    notice.textContent = message ?? '';
    notice.hidden = !message;
    notice.classList.toggle('error', error);
  };

  const folderRow = (f: WebFolder, checked: boolean) =>
    h(
      'label',
      { class: f.isMain ? 'folder main' : 'folder' },
      (() => {
        const input = h('input', { attrs: { type: 'radio', name: 'dir', value: f.dir } });
        input.checked = checked;
        return input;
      })(),
      h('span', { class: 'folder-text' }, h('span', { class: 'folder-name' }, f.name, f.isMain ? h('span', { class: 'folder-tag', text: 'Main repo' }) : null), h('span', { class: 'folder-dir', text: f.dir })),
    );

  const form = h(
    'form',
    {
      class: 'content new-form',
      on: {
        submit: (e) => {
          e.preventDefault();
          void submit();
        },
      },
    },
    h('fieldset', { class: 'field' }, h('legend', { text: 'Folder' }), list),
    h('label', { class: 'field' }, h('span', { class: 'field-title', text: 'Prompt' }), prompt),
    notice,
    h('div', { class: 'form-actions' }, start),
  );

  const el = h(
    'div',
    { class: 'view view-new' },
    h('header', { class: 'bar' }, h('a', { class: 'back', text: 'Sessions', attrs: { href: '#/', 'aria-label': 'Back to sessions' } }), h('h1', { class: 'heading', text: 'New session' })),
    form,
  );

  async function loadFolders(): Promise<void> {
    const r = await api<FoldersResponse>('GET', 'api/folders');
    if (disposed) return;
    const folders = r.data?.folders ?? [];
    if (!r.data) {
      list.replaceChildren();
      say(r.error);
      return;
    }
    if (folders.length === 0) {
      list.replaceChildren(h('p', { class: 'hint', text: 'No folders are available to start a session in.' }));
      return;
    }
    const sorted = [...folders.filter((f) => f.isMain), ...folders.filter((f) => !f.isMain)];
    list.replaceChildren(...sorted.map((f, i) => folderRow(f, i === 0)));
    start.disabled = false;
  }

  function arrived(): void {
    if (!waiting || disposed) return;
    const c = feed.cards?.find((x) => x.tmuxSession === waiting!.tmuxSession);
    if (c) {
      const id = c.id;
      waiting = undefined;
      window.clearTimeout(waitTimer);
      go(sessionHref(id));
      return;
    }
    if (Date.now() > waiting.until) {
      say(`Started ${waiting.tmuxSession}, but it hasn't shown up yet. It will appear in your sessions once Claude is running.`, false);
      waiting = undefined;
      start.disabled = false;
      return;
    }
    // The stream normally brings the new card; ask too, in case it is slow or down. arrived() runs from the feed and
    // after each poll, so a poll already scheduled is replaced, never added to.
    window.clearTimeout(waitTimer);
    waitTimer = window.setTimeout(() => {
      void pollOnce().then(arrived);
    }, 2000);
  }

  async function submit(): Promise<void> {
    const dir = (list.querySelector('input[name="dir"]:checked') as HTMLInputElement | null)?.value;
    if (!dir || waiting) return;
    start.disabled = true;
    say(undefined);
    const body: NewSessionRequest = { dir, prompt: prompt.value };
    const r = await api<NewSessionResponse>('POST', 'api/sessions', body);
    if (disposed) return;
    if (!r.data) {
      say(r.error);
      start.disabled = false;
      return;
    }
    say('Starting Claude…', false);
    waiting = { tmuxSession: r.data.tmuxSession, until: Date.now() + NEW_SESSION_WAIT_MS };
    arrived();
  }

  feed.listeners.add(arrived);
  void loadFolders();
  return {
    el,
    dispose: () => {
      disposed = true;
      window.clearTimeout(waitTimer);
      feed.listeners.delete(arrived);
    },
  };
}

// ---- Routing ----

let current: View | undefined;

function go(hash: string): void {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route(): void {
  current?.dispose();
  const hash = location.hash || '#/';
  let view: View;
  if (hash.startsWith('#/s/')) {
    let id: string | undefined;
    try {
      id = decodeURIComponent(hash.slice(4));
    } catch {
      id = undefined;
    }
    view = id ? sessionView(id) : listView();
  } else if (hash === '#/new') view = newView();
  else view = listView();
  current = view;
  const root = document.getElementById('app') ?? document.body;
  root.replaceChildren(view.el);
  window.scrollTo?.(0, 0);
}

function startPage(): void {
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stream) openStream();
  });
  openStream();
  route();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPage);
else startPage();
