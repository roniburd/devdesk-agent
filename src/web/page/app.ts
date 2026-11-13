// The web access page: the session list with a prompt box on top that starts a session, and a session's transcript and
// screen with a reply box (with a `/` menu) or dialog keys. On a phone the list and a session take turns; from 900 px
// wide (app.css) they sit side by side, the list on the left. Hash routes `#/`, `#/s/<id>`, `#/settings` (and `#/new`,
// which focuses the prompt box). When this browser (or devdesk.web.sessionView) chose the experimental terminal, the
// Screen tab is a Terminal tab instead: the live terminal (termView.ts). It talks only to the daemon's JSON API
// (core/web/types.ts), with relative URLs.
// All data goes in as text (dom.ts, screen.ts, markdown.ts), never as markup; no inline script or style (CSP `default-src 'self'`).
import type {
  CardsResponse,
  ComposerResponse,
  FoldersResponse,
  KeyRequest,
  NewSessionRequest,
  NewSessionResponse,
  OkResponse,
  SendRequest,
  SessionDetail,
  SessionView,
  SettingsResponse,
  WebCard,
  WebFolder,
  WebGroup,
  WebKey,
} from '../../core/web/types';
import { api } from './api';
import { h, sentenceCase, sessionHref } from './dom';
import { turnEls } from './turns';
import { renderScreen } from './screen';
import { termPanel } from './termView';
import { isSessionView } from '../../core/web/types';
import { DEFAULT_CHOICE } from '../../core/composer';
import { boxAction, replyAction, replyMenu } from '../../core/web/promptBox';
import { promptTools } from './promptTools';

/** Stream errors in a row before the list falls back to polling `api/sessions`. */
const STREAM_ERRORS = 3;
const FALLBACK_POLL_MS = 5000;
/** While polling, how often the page tries the event stream again. */
const STREAM_RETRY_MS = 30_000;
const DETAIL_POLL_MS = 2000;
const ENDED_BACK_MS = 2000;
const NEW_SESSION_WAIT_MS = 30_000;
/** While the Claude CLI is still listing a folder's commands and models, a prompt box asks again this often, this many times. */
const COMPOSER_RETRY_MS = 3000;
const COMPOSER_RETRIES = 10;

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

// ---- Settings: this browser's choice (localStorage), else the daemon's default (devdesk.web.sessionView). ----

const VIEW_KEY = 'devdesk.web.sessionView';
let defaultView: SessionView = 'transcript';

function storedView(): SessionView | undefined {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return isSessionView(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function storeView(v: SessionView | undefined): void {
  try {
    if (v) localStorage.setItem(VIEW_KEY, v);
    else localStorage.removeItem(VIEW_KEY);
  } catch {
    // Private mode without storage: the choice lasts until the page reloads.
  }
}

const viewNow = (): SessionView => storedView() ?? defaultView;

async function loadSettings(): Promise<void> {
  const r = await api<SettingsResponse>('GET', 'api/settings');
  if (r.data && isSessionView(r.data.sessionView)) defaultView = r.data.sessionView;
}

const VIEW_NAMES: Record<SessionView, string> = { transcript: 'Transcript', 'terminal-experimental': 'Terminal (experimental)' };

function gear(): HTMLElement {
  return h('a', { class: 'button gear', text: '⚙', attrs: { href: '#/settings', 'aria-label': 'Settings', title: 'Settings' } });
}

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

interface ListView extends View {
  /** Marks the open session's card (the list stays on screen beside it on a wide screen). */
  select(id: string | undefined): void;
  focusPrompt(): void;
}

function listView(): ListView {
  let selected: string | undefined;
  const badge = h('span', { attrs: { role: 'status' } });
  const body = h('div', { class: 'content list' });
  const start = composer();
  const el = h('div', { class: 'view view-list' }, h('header', { class: 'bar' }, h('h1', { class: 'heading', text: 'Claude sessions' }), badge, gear()), start.el, body);
  const render = () => {
    showLink(badge);
    const cards = feed.cards;
    if (!cards) {
      body.replaceChildren(h('p', { class: feed.error ? 'notice error' : 'notice', text: feed.error ?? 'Loading sessions…' }));
      return;
    }
    if (cards.length === 0) {
      body.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'No Claude sessions are running.' }), h('p', { class: 'hint', text: 'Type a prompt above to start one.' })));
      return;
    }
    const sections = GROUPS.map(({ group, title }) => {
      const mine = cards.filter((c) => c.group === group);
      if (mine.length === 0) return null;
      return h(
        'section',
        { class: `group group-${group}`, attrs: { 'data-group': group, 'aria-label': title } },
        h('h2', { class: 'group-title' }, title, h('span', { class: 'count', text: String(mine.length) })),
        h(
          'div',
          { class: 'cards' },
          ...mine.map((c) => {
            const row = cardRow(c);
            if (c.id === selected) row.setAttribute('aria-current', 'page');
            return row;
          }),
        ),
      );
    });
    body.replaceChildren(...sections.filter((s): s is HTMLElement => s !== null));
    if (feed.error) body.prepend(h('p', { class: 'notice error', text: feed.error }));
  };
  feed.listeners.add(render);
  render();
  return {
    el,
    select: (id) => {
      if (id === selected) return;
      selected = id;
      render();
    },
    focusPrompt: () => start.focus(),
    dispose: () => {
      feed.listeners.delete(render);
      start.dispose();
    },
  };
}

type Tab = 'transcript' | 'screen';

const typedNote = (where: string) => `Text is already typed at Claude's prompt (see ${where}): clear it in the session's terminal, then send.`;

const KEYS: ReadonlyArray<{ key: WebKey; text: string; label: string; wide?: boolean }> = [
  { key: '1', text: '1', label: 'Option 1' },
  { key: '2', text: '2', label: 'Option 2' },
  { key: '3', text: '3', label: 'Option 3' },
  { key: 'Up', text: '↑', label: 'Up' },
  { key: 'Down', text: '↓', label: 'Down' },
  { key: 'Escape', text: 'Esc', label: 'Escape' },
  { key: 'Enter', text: 'Enter', label: 'Enter', wide: true },
];


/**
 * A session: the Transcript tab and the Screen tab (a snapshot of the pane), or, in the experimental terminal view, a
 * Terminal tab (the live terminal, connected only while it shows). The dock under them has the reply box (with the `/`
 * menu of what runs in a session) or the dialog keys, and the terminal's key bar on the Terminal tab.
 */
function sessionView(id: string): View {
  let card: WebCard | undefined = feed.cards?.find((c) => c.id === id);
  let tab: Tab = 'transcript';
  let dir: string | undefined;
  let infoTimer: number | undefined;
  let dialog = false;
  let ended = false;
  let lost = false;
  let loadFailed = false;
  let busy = false;
  let disposed = false;
  let timer: number | undefined;
  let turnsKey = '';
  let screenKey = '';
  const terminal = viewNow() === 'terminal-experimental' ? termPanel(id, { follow: () => follow() }) : undefined;
  const screenName = terminal ? 'Terminal' : 'Screen';
  const TYPED_NOTE = typedNote(screenName);

  const title = h('h1', { class: 'heading title', text: card?.title ?? 'Session' });
  const state = h('span', { class: 'state' });
  const tabButtons = {
    transcript: h('button', { class: 'tab', text: 'Transcript', attrs: { type: 'button', role: 'tab' }, on: { click: () => pick('transcript') } }),
    screen: h('button', { class: 'tab', text: screenName, attrs: { type: 'button', role: 'tab' }, on: { click: () => pick('screen') } }),
  };
  const turns = h('ol', { class: 'turns' });
  // Under the last turn while Claude works, so a quiet transcript still shows the session is busy.
  const working = h('div', { class: 'working', attrs: { role: 'status' } }, h('span', { class: 'glyph spin', attrs: { 'aria-hidden': 'true' } }), 'Working…');
  working.hidden = true;
  const screen = h('div', { class: 'term', attrs: { role: 'img', 'aria-label': 'Terminal screen' } });
  const panels = {
    transcript: h('section', { class: 'panel transcript', attrs: { role: 'tabpanel' } }, turns, working),
    screen: terminal?.panel ?? h('section', { class: 'panel screen', attrs: { role: 'tabpanel' } }, screen),
  };
  const notice = h('p', { class: 'notice', attrs: { 'aria-live': 'polite' }, text: '' });
  notice.hidden = true;

  const text = h('textarea', {
    class: 'reply-text',
    attrs: {
      rows: '2',
      placeholder: 'Reply to Claude, / for commands',
      'aria-label': 'Reply',
      autocomplete: 'off',
      autocapitalize: 'sentences',
      role: 'combobox',
      'aria-expanded': 'false',
    },
    on: {
      input: () => tools.update(),
      click: () => tools.update(),
      keyup: (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') tools.update();
      },
      blur: () => tools.close(),
      keydown: (e) => {
        if (tools.key(e)) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      },
    },
  });
  const tools = promptTools(text, { run: () => void send(), changed: () => {}, rows: replyMenu, pills: false, id: 'reply-slash' });
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
    tools.menu,
    h('div', { class: 'reply-actions' }, tools.bar, interrupt, sendButton),
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
  const talk = h('div', { class: 'dock-talk' }, notice, reply, keys);
  const dock = h('footer', { class: 'dock' }, talk, terminal?.keys ?? null, endedBox);
  keys.hidden = true;

  const el = h(
    'div',
    { class: 'view view-session' },
    h(
      'header',
      { class: 'bar' },
      h('a', { class: 'back', text: 'Sessions', attrs: { href: '#/', 'aria-label': 'Back to sessions' } }),
      h('div', { class: 'titles' }, title, state),
      gear(),
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
    if (terminal) {
      // The Terminal tab types into the terminal: its key bar replaces the reply box.
      const live = t === 'screen' && !ended;
      talk.hidden = live;
      terminal.keys.hidden = !live;
      dock.classList.toggle('term-dock', live);
      if (live) terminal.show();
      else terminal.hide();
    } else if (t === 'screen') scrollToEnd(panels.screen);
  }

  /** What the reply box's `/` menu offers: the commands of the session's folder, asked for again while the CLI lists them. */
  async function loadInfo(tries = 0): Promise<void> {
    window.clearTimeout(infoTimer);
    if (!dir || disposed) return;
    const asked = dir;
    const r = await api<ComposerResponse>('GET', `api/composer?dir=${encodeURIComponent(asked)}`);
    if (disposed || dir !== asked || !r.data) return;
    tools.setInfo(r.data);
    if (r.data.listing && tries < COMPOSER_RETRIES) infoTimer = window.setTimeout(() => void loadInfo(tries + 1), COMPOSER_RETRY_MS);
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
    if (d.dir && d.dir !== dir) {
      dir = d.dir;
      void loadInfo();
    }
    // The hooks know when a turn ends; the spinner on screen is only a fallback for sessions without hooks.
    const isWorking = d.card.state === 'working' || (d.card.state === 'unknown' && d.prompt.working);
    const tk = JSON.stringify(d.turns);
    if (tk !== turnsKey || working.hidden === isWorking) {
      const stick = turnsKey === '' || nearEnd(panels.transcript);
      if (tk !== turnsKey) turns.replaceChildren(...(d.turns.length ? turnEls(d.turns) : [h('li', { class: 'turn turn-none', text: 'Nothing said yet.' })]));
      turnsKey = tk;
      working.hidden = !isWorking;
      if (stick) scrollToEnd(panels.transcript);
    }
    const sk = JSON.stringify(d.screen);
    if (!terminal && sk !== screenKey) {
      const stick = screenKey === '' || nearEnd(panels.screen);
      screenKey = sk;
      if (d.screen.length) renderScreen(screen, d.screen);
      else screen.replaceChildren(h('div', { class: 'row', text: 'This session has no terminal screen.' }));
      if (stick) scrollToEnd(panels.screen);
    }
    const open = d.prompt.dialog;
    // The Screen tab shows the dialog; the Terminal tab is not opened for it, as it would size the desktop's window.
    if (open && !dialog && !terminal) pick('screen');
    dialog = open;
    reply.hidden = open;
    keys.hidden = !open;
    if (open) tools.close();
    interrupt.hidden = !isWorking;
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
    if (terminal) {
      terminal.hide();
      terminal.keys.hidden = true;
      talk.hidden = false;
      dock.classList.remove('term-dock');
    }
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
    tools.close();
    const action = replyAction(value, tools.info()?.commands ?? []);
    if (action.kind === 'notice') return say(action.text, false);
    const body: SendRequest = { text: action.text };
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
      window.clearTimeout(infoTimer);
      feed.listeners.delete(onCards);
      terminal?.dispose();
    },
  };
}

function settingsView(): View {
  const choice = storedView();
  const option = (value: SessionView | '', name: string, hint: string) => {
    const input = h('input', { attrs: { type: 'radio', name: 'view', value } });
    input.checked = (choice ?? '') === value;
    input.addEventListener('change', () => {
      storeView(value || undefined);
      saved.hidden = false;
    });
    return h('label', { class: 'setting-option' }, input, h('span', { class: 'setting-text' }, h('span', { class: 'setting-name', text: name }), h('span', { class: 'setting-hint', text: hint })));
  };
  const saved = h('p', { class: 'notice', text: 'Saved for this browser.', attrs: { role: 'status' } });
  saved.hidden = true;
  const ok = h('button', { class: 'button primary', text: 'OK', attrs: { type: 'button' } });
  ok.addEventListener('click', () => go(beforeSettings));
  const el = h(
    'div',
    { class: 'view view-settings' },
    h('header', { class: 'bar' }, h('a', { class: 'back', text: 'Sessions', attrs: { href: '#/', 'aria-label': 'Back to sessions' } }), h('h1', { class: 'heading', text: 'Settings' })),
    h(
      'div',
      { class: 'content settings-form' },
      h(
        'fieldset',
        { class: 'setting' },
        h('legend', { class: 'setting-label', text: 'Open sessions as' }),
        h(
          'div',
          { class: 'setting-options', attrs: { role: 'radiogroup', 'aria-label': 'Open sessions as' } },
          option('', `Default: ${VIEW_NAMES[defaultView]}`, 'What devdesk.web.sessionView says on your desktop.'),
          option('transcript', VIEW_NAMES.transcript, 'The conversation, the screen, and a reply box.'),
          option(
            'terminal-experimental',
            VIEW_NAMES['terminal-experimental'],
            "The conversation and a reply box, and a Terminal tab with the session's live terminal and a key bar. While the Terminal tab shows, the session's window takes this screen's size; your desktop takes it back when you type there.",
          ),
        ),
      ),
      saved,
      h('div', { class: 'settings-actions' }, ok),
    ),
  );
  return { el, dispose: () => {} };
}

/** The folders a session can start in, asked for once. */
let foldersLoad: Promise<{ folders?: WebFolder[]; error?: string }> | undefined;
function loadFolders(): Promise<{ folders?: WebFolder[]; error?: string }> {
  foldersLoad ??= api<FoldersResponse>('GET', 'api/folders').then((r) => {
    if (!r.data) foldersLoad = undefined; // Ask again next time.
    return r.data ? { folders: r.data.folders ?? [] } : { error: r.error };
  });
  return foldersLoad;
}

/** Rows the prompt box shows: one line until it is used, then up to 8 as you type. */
const PROMPT_ROWS = { idle: 1, open: 3, max: 8 };

/**
 * The prompt box at the top of the list: type (with a `/` menu of skills and commands), pick the mode, model and effort
 * pills and a folder (main is picked), Start. It opens the new session.
 */
function composer(): View & { focus(): void } {
  let disposed = false;
  let waiting: { tmuxSession: string; until: number; from: string } | undefined;
  let waitTimer: number | undefined;
  let infoTimer: number | undefined;
  /** The text a notice asked to confirm (an unknown command): Start again with it sends it anyway. */
  let confirming: string | undefined;
  const notice = h('p', { class: 'notice', attrs: { 'aria-live': 'polite' } });
  notice.hidden = true;
  const prompt = h('textarea', {
    class: 'prompt',
    attrs: {
      rows: String(PROMPT_ROWS.idle),
      placeholder: 'What should Claude do? / for commands',
      'aria-label': 'Prompt for a new session',
      autocapitalize: 'sentences',
      role: 'combobox',
      'aria-expanded': 'false',
    },
    on: {
      input: () => {
        fit();
        tools.update();
      },
      click: () => tools.update(),
      keyup: (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') tools.update();
      },
      focus: () => fit(),
      blur: () => {
        tools.close();
        fit();
      },
      keydown: (e) => {
        if (tools.key(e)) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      },
    },
  });
  const tools = promptTools(prompt, { run: () => void submit(), changed: () => fit() });
  const folder = h('select', { class: 'folder-pick', attrs: { name: 'dir', 'aria-label': 'Folder' } }, h('option', { text: 'Loading folders…', attrs: { value: '' } }));
  folder.disabled = true;
  folder.addEventListener('change', () => void loadInfo(folder.value));
  const start = h('button', { class: 'button primary start', text: 'Start', attrs: { type: 'submit' } });
  start.disabled = true;

  function fit(): void {
    const used = document.activeElement === prompt || prompt.value !== '';
    const lines = prompt.value.split('\n').length;
    prompt.rows = used ? Math.min(PROMPT_ROWS.max, Math.max(PROMPT_ROWS.open, lines)) : PROMPT_ROWS.idle;
    el.classList.toggle('open', used || tools.custom());
  }

  const say = (message: string | undefined, error = true) => {
    notice.textContent = message ?? '';
    notice.hidden = !message;
    notice.classList.toggle('error', error);
  };

  const el = h(
    'form',
    {
      class: 'composer',
      attrs: { 'aria-label': 'Start a session' },
      on: {
        submit: (e) => {
          e.preventDefault();
          void submit();
        },
      },
    },
    prompt,
    tools.menu,
    tools.bar,
    h('div', { class: 'composer-row' }, h('label', { class: 'folder-chip', attrs: { title: 'Folder the session starts in' } }, folder), start),
    notice,
  );

  /** What the box offers for `dir`; again in a few seconds while the CLI is still listing it. */
  async function loadInfo(dir: string, tries = 0): Promise<void> {
    window.clearTimeout(infoTimer);
    if (!dir) return;
    const r = await api<ComposerResponse>('GET', `api/composer?dir=${encodeURIComponent(dir)}`);
    if (disposed || folder.value !== dir || !r.data) return;
    tools.setInfo(r.data);
    fit();
    if (r.data.listing && tries < COMPOSER_RETRIES) infoTimer = window.setTimeout(() => void loadInfo(dir, tries + 1), COMPOSER_RETRY_MS);
  }

  async function fill(): Promise<void> {
    const r = await loadFolders();
    if (disposed) return;
    const folders = r.folders ?? [];
    if (!r.folders) {
      folder.replaceChildren(h('option', { text: 'No folders', attrs: { value: '' } }));
      say(r.error);
      return;
    }
    if (folders.length === 0) {
      folder.replaceChildren(h('option', { text: 'No folders to start in', attrs: { value: '' } }));
      return;
    }
    const sorted = [...folders.filter((f) => f.isMain), ...folders.filter((f) => !f.isMain)];
    folder.replaceChildren(...sorted.map((f) => h('option', { text: f.isMain ? `${f.name} (main repo)` : f.name, attrs: { value: f.dir, title: f.dir } })));
    folder.value = sorted[0].dir;
    folder.disabled = false;
    start.disabled = false;
    void loadInfo(folder.value);
  }

  function arrived(): void {
    if (!waiting || disposed) return;
    const c = feed.cards?.find((x) => x.tmuxSession === waiting!.tmuxSession);
    if (c) {
      const from = waiting.from;
      waiting = undefined;
      window.clearTimeout(waitTimer);
      start.disabled = false;
      say(undefined);
      // Open it, unless another session was opened meanwhile: then it just shows up in the list.
      if ((location.hash || '#/') === from) go(sessionHref(c.id));
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
    const dir = folder.value;
    if (!dir || waiting || start.disabled) return;
    tools.close();
    const text = prompt.value;
    const info = tools.info();
    const choice = tools.choice();
    const action = boxAction(text, {
      commands: info?.commands ?? [],
      models: info?.models ?? [],
      ...(info?.planMode ? { planMode: info.planMode } : {}),
      choice,
      confirmed: confirming === text,
    });
    confirming = undefined;
    if (action.kind === 'notice') {
      if (action.confirm) confirming = text;
      return say(action.text, false);
    }
    if (action.kind === 'clear' || action.kind === 'set') {
      if (action.kind === 'set') tools.set({ ...(action.model ? { model: action.model } : {}), ...(action.effort ? { effort: action.effort } : {}) });
      prompt.value = '';
      fit();
      return say(action.kind === 'set' ? action.note : undefined, false);
    }
    start.disabled = true;
    say(undefined);
    // Only what is off the defaults: the daemon starts the default mode, Claude's own model and effort otherwise.
    const mode = action.mode ?? (info && choice.mode !== info.defaultMode ? choice.mode : undefined);
    const body: NewSessionRequest = {
      dir,
      prompt: action.prompt,
      ...(mode ? { mode } : {}),
      ...(choice.model !== DEFAULT_CHOICE ? { model: choice.model } : {}),
      ...(choice.effort !== DEFAULT_CHOICE ? { effort: choice.effort } : {}),
    };
    const r = await api<NewSessionResponse>('POST', 'api/sessions', body);
    if (disposed) return;
    if (!r.data) {
      say(r.error);
      start.disabled = false;
      return;
    }
    // Only clear what was sent: anything typed while it went stays.
    if (prompt.value === text) prompt.value = '';
    fit();
    say('Starting Claude…', false);
    waiting = { tmuxSession: r.data.tmuxSession, until: Date.now() + NEW_SESSION_WAIT_MS, from: location.hash || '#/' };
    arrived();
  }

  feed.listeners.add(arrived);
  void fill();
  return {
    el,
    focus: () => {
      prompt.focus();
      fit();
    },
    dispose: () => {
      disposed = true;
      window.clearTimeout(waitTimer);
      window.clearTimeout(infoTimer);
      feed.listeners.delete(arrived);
    },
  };
}

// ---- Routing ----

// The list is made once and stays, so its scroll, the prompt being typed and a session being started survive opening a
// session. `.shell.has-session` (app.css) shows the list or the session on a phone, and both side by side when wide.
let list: ListView | undefined;
let detail: View | undefined;
let listScroll = 0;
const shell = { el: h('div', { class: 'shell' }), list: h('div', { class: 'pane pane-list' }), detail: h('div', { class: 'pane pane-detail' }) };
shell.el.append(shell.list, shell.detail);

function placeholder(): View {
  return { el: h('div', { class: 'view view-pick' }, h('p', { class: 'hint', text: 'Pick a session, or type a prompt to start one.' })), dispose: () => {} };
}

/** The page shown before Settings opened, where its OK button goes back to. */
let beforeSettings = '#/';

function go(hash: string): void {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route(): void {
  const hash = location.hash || '#/';
  let id: string | undefined;
  if (hash.startsWith('#/s/')) {
    try {
      id = decodeURIComponent(hash.slice(4));
    } catch {
      id = undefined;
    }
  }
  const settings = hash === '#/settings';
  if (!settings && hash !== '#/new') beforeSettings = hash;
  const open = !!id || settings;
  const wasSession = shell.el.classList.contains('has-session');
  if (open && !wasSession) listScroll = window.scrollY ?? 0;
  detail?.dispose();
  detail = id ? sessionView(id) : settings ? settingsView() : placeholder();
  shell.detail.replaceChildren(detail.el);
  shell.el.classList.toggle('has-session', open);
  list!.select(id);
  if (open) window.scrollTo?.(0, 0);
  else if (wasSession) window.scrollTo?.(0, listScroll);
  if (hash === '#/new') {
    history.replaceState(null, '', '#/');
    list!.focusPrompt();
  }
}

function startPage(): void {
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stream) openStream();
  });
  openStream();
  list = listView();
  shell.list.append(list.el);
  (document.getElementById('app') ?? document.body).replaceChildren(shell.el);
  route();
  // The default view comes from the daemon: a session opened before it answered opens again if the view differs.
  const shown = viewNow();
  void loadSettings().then(() => {
    if (viewNow() !== shown && (location.hash || '').startsWith('#/s/')) route();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPage);
else startPage();
