// The experimental terminal view (`devdesk.web.sessionView: terminal-experimental`): the session's live tmux pane in
// xterm.js. Output comes on `api/sessions/<id>/term` (an event stream of base64 bytes, opened at this page's size);
// what is typed goes to …/term/input and size changes to …/term/resize. A key bar gives the keys a phone keyboard
// lacks. The stream closes when the page is hidden, so the session's window goes back to the desktop's size.
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { OkResponse, TermInputRequest, TermResizeRequest } from '../../core/web/types';
import { api } from './api';
import { h } from './dom';

export interface TermViewDeps {
  /** The session's title now, and its state element (kept up to date by the caller). */
  title: HTMLElement;
  state: HTMLElement;
  /** The settings gear. */
  gear: HTMLElement;
  /** A 404: follow the card if its id changed; true when it navigated away. */
  follow(): boolean;
}

const RESIZE_DEBOUNCE_MS = 120;

/** Loads term.js and term.css once. */
let assets: Promise<void> | undefined;
function loadAssets(): Promise<void> {
  assets ??= new Promise<void>((resolve, reject) => {
    const css = h('link', { attrs: { rel: 'stylesheet', href: 'term.css' } });
    document.head.append(css);
    const js = h('script', { attrs: { src: 'term.js' } });
    js.addEventListener('load', () => resolve());
    js.addEventListener('error', () => {
      assets = undefined;
      js.remove();
      reject(new Error('Could not load the terminal. Check your connection and try again.'));
    });
    document.head.append(js);
  });
  return assets;
}

/**
 * xterm.js styles itself with `<style>` elements it writes (theme colours, cell size), which the page's CSP
 * (`default-src 'self'`) blocks. Their text goes into constructed stylesheets instead (document.adoptedStyleSheets):
 * the CSSOM is not subject to the CSP, so the page keeps its policy.
 */
export function mirrorStyles(root: HTMLElement): { stop(): void } {
  const sheets = new Map<HTMLStyleElement, { sheet: CSSStyleSheet; text: string }>();
  const canAdopt = typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in document;
  const sync = () => {
    if (!canAdopt) return;
    const now = new Set(root.querySelectorAll('style'));
    for (const [el, s] of sheets) {
      if (now.has(el)) continue;
      sheets.delete(el);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s.sheet);
    }
    for (const el of now) {
      const text = el.textContent ?? '';
      let s = sheets.get(el);
      if (!s) {
        s = { sheet: new CSSStyleSheet(), text: '' };
        sheets.set(el, s);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, s.sheet];
      }
      if (s.text !== text) {
        s.sheet.replaceSync(text);
        s.text = text;
      }
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  sync();
  return {
    stop: () => {
      observer.disconnect();
      const mine = new Set([...sheets.values()].map((s) => s.sheet));
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => !mine.has(x));
      sheets.clear();
    },
  };
}

function base64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The key bar: what each button types. `ctrl` arms Ctrl for the next key typed. */
const KEYS: ReadonlyArray<{ label: string; aria: string; seq?: string; ctrl?: true; wide?: true }> = [
  { label: 'Esc', aria: 'Escape', seq: '\x1b' },
  { label: 'Tab', aria: 'Tab', seq: '\t' },
  { label: '⇧Tab', aria: 'Shift Tab (mode)', seq: '\x1b[Z' },
  { label: 'Ctrl', aria: 'Control, for the next key', ctrl: true },
  { label: '^C', aria: 'Control C', seq: '\x03' },
  { label: '←', aria: 'Left', seq: '\x1b[D' },
  { label: '↑', aria: 'Up', seq: '\x1b[A' },
  { label: '↓', aria: 'Down', seq: '\x1b[B' },
  { label: '→', aria: 'Right', seq: '\x1b[C' },
  { label: 'Enter', aria: 'Enter', seq: '\r', wide: true },
];

/** A printable key typed with Ctrl armed, as the control character it makes (Ctrl+A = 0x01 …); else the key itself. */
export function withCtrl(d: string): string {
  if (d.length !== 1) return d;
  const c = d.toUpperCase().charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f);
  if (d === ' ') return '\x00';
  return d;
}

export function termView(id: string, deps: TermViewDeps): { el: HTMLElement; dispose(): void } {
  let disposed = false;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let es: EventSource | undefined;
  let termId: string | undefined;
  let ctrl = false;
  let queue = '';
  let sending = false;
  let resizeTimer: number | undefined;
  let sent = { cols: 0, rows: 0 };
  let styles: { stop(): void } | undefined;
  const path = (p: string) => `api/sessions/${encodeURIComponent(id)}/${p}`;

  const host = h('div', { class: 'xterm-host', attrs: { 'aria-label': 'Terminal' } });
  const notice = h('p', { class: 'notice term-notice', attrs: { 'aria-live': 'polite' } });
  notice.hidden = true;
  const reconnect = h('button', { class: 'button primary', text: 'Reconnect', attrs: { type: 'button' }, on: { click: () => connect() } });
  reconnect.hidden = true;
  const status = h('div', { class: 'term-status' }, notice, reconnect);
  const ctrlButton = h('button', { class: 'button tkey', text: 'Ctrl', attrs: { type: 'button', 'aria-label': 'Control, for the next key', 'aria-pressed': 'false' } });
  const keyBar = h(
    'div',
    { class: 'term-keys', attrs: { role: 'group', 'aria-label': 'Keys' } },
    ...KEYS.map((k) => {
      const b = k.ctrl ? ctrlButton : h('button', { class: `button tkey${k.wide ? ' wide' : ''}`, text: k.label, attrs: { type: 'button', 'aria-label': k.aria } });
      // Keep the keyboard up: a tap on a key must not take focus from xterm's text area.
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (k.ctrl) return setCtrl(!ctrl);
        type(k.seq ?? '');
        term?.focus();
      });
      return b;
    }),
  );

  const el = h(
    'div',
    { class: 'view view-session view-term' },
    h(
      'header',
      { class: 'bar' },
      h('a', { class: 'back', text: 'Sessions', attrs: { href: '#/', 'aria-label': 'Back to sessions' } }),
      h('div', { class: 'titles' }, deps.title, deps.state),
      deps.gear,
    ),
    h('div', { class: 'content term-panel' }, host, status),
    h('footer', { class: 'dock term-dock' }, keyBar),
  );

  function say(message: string | undefined, offerReconnect = false, error = false): void {
    notice.textContent = message ?? '';
    notice.hidden = !message;
    notice.classList.toggle('error', error);
    reconnect.hidden = !offerReconnect;
    status.hidden = !message && !offerReconnect;
  }

  function setCtrl(on: boolean): void {
    ctrl = on;
    ctrlButton.classList.toggle('on', on);
    ctrlButton.setAttribute('aria-pressed', String(on));
  }

  function type(d: string): void {
    if (!d) return;
    if (ctrl) {
      d = withCtrl(d);
      setCtrl(false);
    }
    queue += d;
    void flush();
  }

  /** One input request at a time; keys typed meanwhile go together in the next. */
  async function flush(): Promise<void> {
    if (sending || !queue || !termId) return;
    sending = true;
    const data = queue;
    queue = '';
    const body: TermInputRequest = { term: termId, data };
    const r = await api<OkResponse>('POST', path('term/input'), body);
    sending = false;
    if (disposed) return;
    if (r.status === 404 && deps.follow()) return;
    if (r.status === 410) {
      closeStream();
      say(r.error ?? 'The terminal is closed.', true);
      return;
    }
    if (r.error) say(r.error, false, true);
    void flush();
  }

  function sendSize(): void {
    if (!term || !fit || disposed) return;
    fit.fit();
    if (!termId || (term.cols === sent.cols && term.rows === sent.rows)) return;
    sent = { cols: term.cols, rows: term.rows };
    const body: TermResizeRequest = { term: termId, cols: term.cols, rows: term.rows };
    void api<OkResponse>('POST', path('term/resize'), body);
  }
  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
  };
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : undefined;

  function closeStream(): void {
    es?.close();
    es = undefined;
    termId = undefined;
  }

  function connect(): void {
    if (disposed || !term || !fit) return;
    closeStream();
    say('Connecting…');
    fit.fit();
    const opened = new EventSource(`${path('term')}?cols=${term.cols}&rows=${term.rows}`);
    es = opened;
    opened.addEventListener('data', (e) => {
      if (es !== opened) return;
      term?.write(base64Bytes((e as MessageEvent<string>).data));
    });
    opened.addEventListener('hello', (e) => {
      if (es !== opened) return;
      try {
        termId = (JSON.parse((e as MessageEvent<string>).data) as { term: string }).term;
      } catch {
        return;
      }
      sent = { cols: term?.cols ?? 0, rows: term?.rows ?? 0 };
      say(undefined);
      // The page may have changed size while connecting.
      sendSize();
      void flush();
    });
    opened.addEventListener('end', (e) => {
      if (es !== opened) return;
      let reason = 'The terminal closed.';
      try {
        reason = (JSON.parse((e as MessageEvent<string>).data) as { reason: string }).reason || reason;
      } catch {
        // keep the default
      }
      closeStream();
      say(reason, true);
    });
    opened.addEventListener('error', () => {
      if (es !== opened) return;
      // A 4xx (the session is gone, access denied) closes the stream for good; anything else the browser retries,
      // and the retry opens a new terminal that says hello again.
      termId = undefined;
      if (opened.readyState === 2) {
        closeStream();
        if (!deps.follow()) say("Can't open this session's terminal. It may have ended.", true, true);
      } else say('Reconnecting…');
    });
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // Hidden (phone locked, another app): give the window back to the desktop.
      closeStream();
      say('Paused while the page was hidden.', true);
    } else if (!es) connect();
  };

  void loadAssets().then(
    () => {
      if (disposed) return;
      const x = window.DevdeskXterm;
      if (!x) return say('Could not start the terminal.', false, true);
      const css = getComputedStyle(document.documentElement);
      const v = (n: string) => css.getPropertyValue(n).trim() || undefined;
      term = new x.Terminal({
        fontFamily: v('--mono'),
        fontSize: 13,
        cursorBlink: true,
        scrollback: 2000,
        theme: {
          background: v('--screen-bg'),
          foreground: v('--screen-fg'),
          black: v('--ansi-0'),
          red: v('--ansi-1'),
          green: v('--ansi-2'),
          yellow: v('--ansi-3'),
          blue: v('--ansi-4'),
          magenta: v('--ansi-5'),
          cyan: v('--ansi-6'),
          white: v('--ansi-7'),
          brightBlack: v('--ansi-8'),
          brightRed: v('--ansi-9'),
          brightGreen: v('--ansi-10'),
          brightYellow: v('--ansi-11'),
          brightBlue: v('--ansi-12'),
          brightMagenta: v('--ansi-13'),
          brightCyan: v('--ansi-14'),
          brightWhite: v('--ansi-15'),
        },
      });
      fit = new x.FitAddon();
      term.loadAddon(fit);
      styles = mirrorStyles(host);
      term.open(host);
      term.onData(type);
      resizeObserver?.observe(host);
      window.visualViewport?.addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVisibility);
      connect();
      term.focus();
    },
    (err: Error) => {
      if (!disposed) say(err.message, false, true);
    },
  );

  return {
    el,
    dispose: () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      closeStream();
      resizeObserver?.disconnect();
      window.visualViewport?.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      term?.dispose();
      styles?.stop();
    },
  };
}
