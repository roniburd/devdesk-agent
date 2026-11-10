// @ts-check
// The Claude Board webview: renders the board the extension posts, and the composer that starts new sessions. Builds
// the DOM with textContent only (session prompts and details are untrusted text), and sends back only messages the
// extension validates: { type, id } actions, compose requests that name the posted choices, completion queries.
import { matchesQuery, parseQuery } from '../src/core/boardQuery';
import { slashWord } from '../src/core/slashTrigger';
import { countHead, timeLeftText } from '../src/core/usageProgress';

/** @typedef {import('../src/board/messages').PanelMessage} PanelMessage What the extension posts. */
/** @typedef {import('../src/board/messages').BoardMessage} BoardMessage What this script posts back. */
/** @typedef {import('../src/board/messages').BoardPost} BoardPost */
(function () {
  const vscode = acquireVsCodeApi();
  /** The model and effort choice meaning "no --model / --effort" (`DEFAULT_CHOICE` in src/core/composer.ts). */
  const DEFAULT = 'Default';
  /** Earlier prompts kept for ⌥↑. */
  const HISTORY_MAX = 50;
  /**
   * What the box keeps for this project folder: the extension saves it (`keep` messages, in its `workspaceState`) and
   * posts it back when the webview loads (`restore`), so it outlasts the tab, a reload and the webview. Until then (and
   * for what this project has not saved), the defaults: the posted default mode, the first model row, Default effort.
   * @type {{ filter: string, query: string, mode?: string, model?: string, effort?: string, ultracode: boolean, history: string[], draft: string }}
   */
  const state = {
    filter: '',
    query: '',
    mode: undefined,
    model: undefined,
    effort: undefined,
    ultracode: false,
    history: [],
    /** The text typed in the box and not sent yet, so the box opened again (a reload, the tab closed) shows it again. */
    draft: '',
  };
  /**
   * What versions before kept in the webview's own state (lost with the tab): taken once, for what this project folder
   * has not saved yet, then forgotten.
   */
  const legacy = vscode.getState() || {};
  /** The remembered choices while a prompt for later's own are in the composer (being edited): what is saved. */
  let beforeEdit;
  /** Saves `fields` for this project folder (`keep`, see `parseKeep` in src/core/boardKept.ts). */
  const keep = (fields) => send('keep', fields);
  /** Alt+Enter saves for later; Macs call the key Option. */
  const ALT_ENTER = /Mac/.test(navigator.platform) ? '⌥⏎' : 'Alt+⏎';
  /** An element of the page, by id (src/board/html.ts has them all). */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const lanesEl = $('lanes');
  const filterEl = /** @type {HTMLSelectElement} */ ($('filter'));
  const needsEl = $('needs');
  const workingEl = $('working');

  const LANE_GLYPHS = { needs: ['●', 'yellow'], working: ['⟳', 'blue'], review: ['✓', 'green'] };

  /** @type {BoardPost | undefined} The board last posted. */
  let last;

  /** `o`'s fields named in `keys` that are set. */
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  /**
   * Posts `{ type, ...fields }` to the extension (`parseBoardMessage` in src/board/messages.ts checks it).
   * @param {BoardMessage['type']} type
   * @param {object} [fields]
   */
  const send = (type, fields) => vscode.postMessage({ type, ...fields });
  /** The prompt box sits above the lanes (devdesk.board.promptPlacement). */
  const placedOnTop = () => document.body.dataset.placement === 'top';
  /** A key pressed without modifiers. */
  const plain = (ev) => !(ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(cls, text, onClick) {
    const b = el('button', cls, text);
    b.addEventListener('click', onClick);
    return b;
  }

  /** Names an icon-like control for hover and for screen readers alike. */
  function labelled(node, label) {
    node.title = label;
    node.setAttribute('aria-label', label);
    return node;
  }

  /** A focusable card; render() puts the focus back on the card with the same `key`. */
  function cardEl(cls, key, label) {
    const card = el('article', cls);
    card.tabIndex = 0;
    card.dataset.key = key;
    card.setAttribute('aria-label', label);
    return card;
  }

  /** A small stroke icon (24×24 paths), built as DOM so no markup is parsed. */
  function icon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ico');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  const ICONS = {
    plus: ['M12 5v14', 'M5 12h14'],
    slash: ['M4 4h16v16H4z', 'M14.5 7.5l-5 9'],
    send: ['M12 19V5', 'M6 11l6-6 6 6'],
    folder: ['M3 7h6l2 2h10v10H3z'],
    branch: ['M6 4v12', 'M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 8c0 5-6 4-11 8'],
    chevron: ['M7 10l5 5 5-5'],
    hand: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V12', 'M11 11V4.5a1.5 1.5 0 0 1 3 0V12', 'M14 11V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-12 0v-2.5a1.5 1.5 0 0 1 3 0'],
    edits: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
    plan: ['M5 5h14', 'M5 12h14', 'M5 19h9'],
    danger: ['M12 3l9 16H3z', 'M12 10v4', 'M12 17h.01'],
    later: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
    terminal: ['M4 5h16v14H4z', 'M7.5 9.5l3 2.5-3 2.5', 'M12.5 15h4'],
    cardline: ['M4 5h16v14H4z', 'M7.5 10h9', 'M7.5 14h6'],
    cardlineOff: ['M4 5h16v14H4z', 'M7.5 10h9', 'M7.5 14h6', 'M3 3l18 18'],
    gear: [
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    ],
  };
  const TONE_ICONS = { default: 'hand', edits: 'edits', plan: 'plan', danger: 'danger' };

  function action(label, type, id, primary, disabled) {
    const b = button(primary ? 'act primary' : 'act', label, (ev) => {
      ev.stopPropagation();
      send(type, { id });
    });
    b.dataset.key = `${type}:${id}`;
    b.disabled = !!disabled;
    return b;
  }

  /** Resumes past session `id`: running, it is a board session, so a ✨ answer's lane lets it go. */
  function resumeHistory(id) {
    send('resumeHistory', { id });
    search.resumed(id);
  }

  /** An excerpt of a past session (`ex`: its text and the matches' spans), the matches in `mark`s, as text only. */
  function excerptEl(cls, ex) {
    const line = el('div', cls);
    let at = 0;
    for (const [a, b] of ex.spans || []) {
      // Spans in order, non-empty and inside the text; one overlapping an earlier one is skipped.
      // Checked here although the host sends them so: the webview does not trust the host's data.
      if (a < at || b <= a || b > ex.text.length) continue;
      line.append(document.createTextNode(ex.text.slice(at, a)), el('mark', '', ex.text.slice(a, b)));
      at = b;
    }
    line.append(document.createTextNode(ex.text.slice(at)));
    return line;
  }

  /** A past session found by the search: its title, where and when, the matching excerpt (matches marked), Resume. */
  function historyCard(h) {
    const card = cardEl('card history', `history:${h.id}`, `${h.title}, past session in ${h.worktree}`);
    card.dataset.history = h.id;
    card.append(el('div', 'title', h.title), el('div', 'meta', `${h.worktree} · ${h.ago}`));
    const ex = (h.excerpts || [])[0];
    if (ex) card.append(excerptEl('excerpt', ex));
    if (h.reason) card.append(el('div', 'reason', `✨ ${h.reason}`));
    const acts = el('div', 'acts');
    const resume = button('act primary', '▶ Resume', (ev) => {
      ev.stopPropagation();
      resumeHistory(h.id);
    });
    resume.dataset.key = `resumeHistory:${h.id}`;
    acts.append(resume, action('Fork', 'forkHistory', h.id), action('Copy id', 'copyHistoryId', h.id));
    card.append(acts);
    return card;
  }

  /** A line across a lane with `text` in it, between its cards. */
  function laneDivider(text) {
    const d = el('div', 'divider', text);
    d.setAttribute('role', 'separator');
    return d;
  }

  /**
   * A lane: its heading (`glyph`, the title, the count, then `extra`) over its `cards`.
   * @param {string} cls
   * @param {string} title
   * @param {string | number} count
   * @param {Node[]} cards
   * @param {{ glyph?: string[], extra?: Node }} [_]
   */
  function laneSection(cls, title, count, cards, { glyph, extra } = {}) {
    const section = el('section', cls);
    section.setAttribute('aria-label', title);
    const h = el('h2');
    if (glyph) h.append(el('span', `glyph ${glyph[1]}`, glyph[0]));
    h.append(el('span', 'lane-title', title), el('span', 'count', count));
    if (extra) h.append(extra);
    const body = el('div', 'body');
    body.append(...cards);
    section.append(h, body);
    return section;
  }

    /** Cards built (not left as shown) by the current render, for the `rendered` report. */
  let rebuiltCards = 0;
  /** Each card's signature: the session data it was drawn from (`sessionCard`); `morph` leaves a card whose signature is the same. */
  const sigs = new WeakMap();
  /** Stand-ins for cards shown unchanged, with how to build the card in full should no shown card match it (`morphChildren`). */
  const standIns = new WeakMap();

  /**
   * A session's card; `shown` has the cards on screen by key. One shown from the same data is not built again: an empty
   * card with its key and signature stands for it, and `morph` keeps the shown one as is.
   */
  function sessionCard(s, shown) {
    const key = `card:${s.id}`;
    const reason = search.found()?.get(s.id);
    // Shown only because its transcript has the query's words: where they are.
    const textHit = search.textHit(s);
    const showLine = !last || last.cardLine !== false;
    const readStyle = /** @type {Partial<BoardPost['readStyle']>} */ ((last && last.readStyle) || {});
    // What the card draws: the search fields only filter the lanes.
    const { search: _fields, ...drawn } = s;
    const sig = JSON.stringify([drawn, readStyle, showLine, reason, textHit]);
    const live = shown.get(key);
    if (live && sigs.get(live) === sig) {
      const same = el('article');
      same.dataset.key = key;
      sigs.set(same, sig);
      standIns.set(same, () => sessionCard(s, new Map()));
      return same;
    }
    // The look's glyph and colour class (`LOOKS` in src/core/stateLooks.ts).
    const glyph = s.glyph || '●';
    const color = s.glyphClass || 'dim';
    rebuiltCards++;
    const card = cardEl(`card look-${color.split(' ')[0]}${s.canOpen ? ' clickable' : ''}`, key, `${s.lookLabel}${s.unread ? ', unread' : ''}: ${s.title}, ${s.worktree}`);
    sigs.set(card, sig);
    card.dataset.session = s.id;
    // Right-click: See Diff, Mark as Read / Unread and the Color submenu (the webview/context menu in package.json).
    card.dataset.vscodeContext = JSON.stringify({ webviewSection: 'session', sessionId: s.id, sessionUnread: !!s.unread, sessionColor: s.color || '', preventDefaultContextMenuItems: true });
    // A color given by hand draws the title in it, over a read card's grey (as in the Claude view).
    if (s.color) card.classList.add(`color-${s.color}`);
    // The hover is the board's own (showHover below): quick, and laid out; screen readers get it as the description.
    const hover = (s.hoverParts || []).map((p) => (p.label ? `${p.label}: ${p.text}` : p.text)).join('\n\n');
    if (hover) card.setAttribute('aria-description', hover);
    // Unread titles are bold; like the Claude view, a dot marks unread cards and read ones are greyed (devdesk.sessions.unreadBadge, dimRead).
    if (!s.unread && readStyle.dimRead) card.classList.add('read');
    // Its Claude terminal is the active one (the Claude view selects its row too).
    if (s.focused) card.classList.add('focused');
    const title = el('div', s.unread ? 'title unread' : 'title', s.title);
    if (s.unread && readStyle.badge) {
      const dot = el('span', 'unread-dot', '\u25CF');
      dot.setAttribute('aria-hidden', 'true');
      title.append(dot);
    }
    card.append(title);
    // devdesk.board.cardTitle `objective`: the title is the session's objective, and this what its latest prompt is about.
    if (s.latest) card.append(el('div', 'latest', s.latest));
    if (reason) card.append(el('div', 'reason', `✨ ${reason}`));
    if (textHit) card.append(excerptEl('excerpt', textHit));
    // One line under the title (devdesk.board.cardLine, the ☰ button): what Claude asks in Needs you, what it is doing in Working.
    const ask = showLine ? s.ask : '';
    if (showLine && s.doing) card.append(el('div', 'doing', s.doing));
    // Needs you: what Claude asks, in one line, under what kind of ask it is.
    if (ask) {
      const box = el('div', 'ask');
      const kind = el('div', `ask-kind ${color}`);
      kind.append(el('span', 'glyph', glyph), document.createTextNode(` ${s.lookLabel}`));
      box.append(kind, el('div', 'ask-text', ask));
      card.append(box);
    }
    const meta = el('div', 'meta');
    const wt = el('span', 'wt');
    wt.append(icon(ICONS.branch), document.createTextNode(s.worktree));
    meta.append(wt);
    // The model the board started it with (not Default).
    if (s.model) meta.append(el('span', 'model', s.model));
    const right = el('span', ask ? `when ${color}` : 'when');
    if (!ask) {
      // The lane says the state; the glyph tells apart the looks a lane shares (done, error, crashed, parked…).
      const g = el('span', `glyph ${color}`, glyph);
      g.setAttribute('aria-hidden', 'true');
      right.append(g);
    }
    if (s.ago) right.append(document.createTextNode(ask ? `waiting ${s.ago === 'just now' ? 'just now' : s.ago}` : ` ${s.ago}`));
    meta.append(right);
    card.append(meta);
    const acts = el('div', 'acts');
    if (s.canFork) acts.append(action('Fork', 'fork', s.id));
    if (s.canEnd) acts.append(action(s.parked ? 'Remove' : 'End', 'end', s.id));
    if (acts.childElementCount) card.append(acts);
    // Opening (double-click, Enter) is handled on the lanes (below), so a card updated in place keeps working.
    return card;
  }

  /**
   * The cards' hover: shows a card's title, where the work stands (Haiku), Claude's recap, the last prompt and what
   * Claude is doing, `HOVER_DELAY_MS` after the pointer (or the keyboard focus) rests on it.
   */
  const HOVER_DELAY_MS = 120;
  const hoverEl = el('div', 'hovercard');
  hoverEl.setAttribute('role', 'tooltip');
  hoverEl.setAttribute('aria-hidden', 'true');
  hoverEl.hidden = true;
  document.body.append(hoverEl);
  let hoverFor;
  let hoverTimer;
  /** A hover's key: the card's own (`card:<id>` for a board session, `history:<id>` for a past one). */
  const hoverKey = (card) => card.dataset.key;
  const HOVER_CARDS = '.card[data-session], .card[data-history]';
  const HOVERED_CARD = HOVER_CARDS.split(',').map((sel) => `${sel.trim()}:hover`).join(', ');
  function historyHover(h) {
    /** @type {{ label?: string, text?: string, excerpts?: any[] }[]} */
    const parts = [{ text: h.title }];
    // Each excerpt on a line of its own, its matches marked as on the card.
    const excerpts = (h.excerpts || []).slice(0, 3);
    if (excerpts.length) parts.push({ label: 'Matches', excerpts });
    const files = (h.files || []).map((f) => f.split('/').pop());
    if (files.length) parts.push({ label: 'Files', text: files.join(', ') });
    return { hoverParts: parts };
  }
  const sessionById = (id) => last && last.board.lanes.flatMap((l) => l.sessions).find((x) => x.id === id);
  /** What the card's hover shows: its board session's, or its past session's. */
  const hoverOf = (card) => {
    if (card.dataset.session) return sessionById(card.dataset.session);
    const h = search.historyById(card.dataset.history);
    return h && historyHover(h);
  };
  function fillHover(s) {
    hoverEl.replaceChildren();
    // When and where it runs go on one quiet footer line, without labels.
    const FOOTER = new Set(['Times', 'Where']);
    const footer = [];
    for (const [i, part] of (s.hoverParts || []).entries()) {
      if (i === 0 && !part.label) {
        hoverEl.append(el('div', 'hc-title', part.text));
      } else if (FOOTER.has(part.label)) {
        footer.push(part.text);
      } else {
        const row = el('div', 'hc-row');
        row.append(el('div', 'hc-label', part.label));
        if (part.excerpts) row.append(...part.excerpts.map((x) => excerptEl('hc-text hc-excerpt', x)));
        else row.append(el('div', 'hc-text', part.text));
        hoverEl.append(row);
      }
    }
    if (footer.length) hoverEl.append(el('div', 'hc-foot', footer.join(' · ')));
  }
  function placeHover(card) {
    const r = card.getBoundingClientRect();
    const w = hoverEl.offsetWidth;
    const h = hoverEl.offsetHeight;
    const gap = 6;
    let x = r.right + gap;
    if (x + w > window.innerWidth - 4) x = r.left - gap - w;
    if (x < 4) x = Math.max(4, Math.min(r.left, window.innerWidth - w - 4));
    let y = x === r.right + gap || x === r.left - gap - w ? r.top : r.bottom + gap;
    if (y + h > window.innerHeight - 4) y = Math.max(4, window.innerHeight - h - 4);
    hoverEl.style.left = `${Math.round(x)}px`;
    hoverEl.style.top = `${Math.round(y)}px`;
  }
  function showHover(card) {
    const s = hoverOf(card);
    if (!s || !(s.hoverParts || []).length) return hideHover();
    hoverFor = hoverKey(card);
    fillHover(s);
    hoverEl.hidden = false;
    placeHover(card);
  }
  function hideHover() {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
    hoverFor = undefined;
    hoverEl.hidden = true;
  }
  function hoverSoon(card) {
    clearTimeout(hoverTimer);
    if (hoverFor === hoverKey(card) && !hoverEl.hidden) return;
    hoverTimer = setTimeout(() => card.isConnected && showHover(card), hoverFor ? 0 : HOVER_DELAY_MS);
  }
  const sessionCardOf = (node) => node && node.closest && node.closest(HOVER_CARDS);
  lanesEl.addEventListener('pointerover', (ev) => {
    const card = sessionCardOf(ev.target);
    if (card) hoverSoon(card);
  });
  lanesEl.addEventListener('pointerout', (ev) => {
    const from = sessionCardOf(ev.target);
    if (from && !from.contains(ev.relatedTarget)) {
      clearTimeout(hoverTimer);
      // Moving straight onto another card keeps the hover up (no second delay); leaving the cards hides it.
      hoverTimer = setTimeout(() => !sessionCardOf(document.querySelector(HOVERED_CARD)) && hideHover(), 60);
    }
  });
  lanesEl.addEventListener('focusin', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    if (t.matches && t.matches(HOVER_CARDS)) hoverSoon(t);
  });
  lanesEl.addEventListener('focusout', (ev) => {
    if (!sessionCardOf(ev.relatedTarget)) hideHover();
  });
  for (const type of ['pointerdown', 'wheel', 'blur']) window.addEventListener(type, hideHover, { passive: true, capture: true });
  document.addEventListener('keydown', (ev) => ev.key === 'Escape' && hideHover());
  /** After the board updates: the open hover shows its session's latest, or goes when the card did. */
  function refreshHover() {
    if (!hoverFor || hoverEl.hidden) return;
    const card = [...lanesEl.querySelectorAll(HOVER_CARDS)].find((c) => hoverKey(c) === hoverFor);
    if (card) showHover(card);
    else hideHover();
  }

  /** The openable session card `node` is in. */
  const openableCard = (node) => node.closest && node.closest('.card.clickable[data-session]');
  lanesEl.addEventListener('dblclick', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const card = openableCard(t);
    if (card && !t.closest('button')) send('open', { id: card.dataset.session });
    const past = /** @type {HTMLElement | null} */ (t.closest && t.closest('.card[data-history]'));
    if (past && !t.closest('button')) resumeHistory(past.dataset.history);
  });
  lanesEl.addEventListener('keydown', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    if (ev.key === 'Enter' && t === openableCard(t)) send('open', { id: t.dataset.session });
    else if (ev.key === 'Enter' && t.matches && t.matches('.card[data-history]')) resumeHistory(t.dataset.history);
  });

  /** Whether `have` (shown) can be updated to look like `want` (just built): the same kind of node with the same key. */
  function sameNode(have, want) {
    if (have.nodeType !== want.nodeType || have.nodeName !== want.nodeName) return false;
    return have.nodeType !== Node.ELEMENT_NODE || (have.dataset.key || '') === (want.dataset.key || '');
  }

  /**
   * Makes the children of `have` look like those of `want`, reusing the nodes already shown (by `data-key`, else by
   * position) instead of replacing them. A card the pointer is on stays the same element while its session updates, so
   * a click or double-click on it is not lost to a refresh. Listeners are not compared: the board's only listeners on
   * reused nodes are its buttons', which do the same for the same key, and the lanes' own (opening a card).
   */
  function morphChildren(have, want) {
    const shown = [...have.childNodes];
    const byKey = new Map();
    for (const n of shown) if (n.nodeType === Node.ELEMENT_NODE && n.dataset.key) byKey.set(n.dataset.key, n);
    const used = new Set();
    const next = [...want.childNodes].map((n, i) => {
      const key = n.nodeType === Node.ELEMENT_NODE ? n.dataset.key : undefined;
      const old = key ? byKey.get(key) : shown[i];
      if (!old || used.has(old) || !sameNode(old, n)) return standIns.get(n)?.() ?? n;
      used.add(old);
      morph(old, n);
      return old;
    });
    if (next.length !== shown.length || next.some((n, i) => n !== shown[i])) have.replaceChildren(...next);
  }

  /**
   * Makes `have` look like `want` (same kind of node): its text, or its attributes and children. Nodes drawn from the
   * same data (the same signature in `sigs`) already look alike.
   */
  function morph(have, want) {
    const sig = sigs.get(want);
    if (sig !== undefined && sig === sigs.get(have)) return;
    if (sig !== undefined) sigs.set(have, sig);
    if (have.nodeType !== Node.ELEMENT_NODE) {
      if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
      return;
    }
    for (const a of [...have.attributes]) if (!want.hasAttribute(a.name)) have.removeAttribute(a.name);
    for (const a of [...want.attributes]) if (have.getAttribute(a.name) !== a.value) have.setAttribute(a.name, a.value);
    morphChildren(have, want);
  }

  function taskCard(t) {
    rebuiltCards++;
    const card = cardEl(`card task${t.starting ? ' starting' : ''}`, `task:${t.id}`, `Prompt for later: ${t.prompt.split('\n')[0]}`);
    card.append(el('div', 'prompt', t.prompt));
    const meta = el('div', 'meta');
    for (const c of t.chips) meta.append(el('span', 'wt', c));
    meta.append(el('span', 'ago', t.starting ? 'starting…' : `added ${t.ago === 'just now' ? 'just now' : `${t.ago} ago`}`));
    card.append(meta);
    const acts = el('div', 'acts');
    const off = t.starting;
    const start = action('▶ Start', 'start', t.id, true, off);
    start.title = 'Start it as saved';
    const plan = action('Plan', 'plan', t.id, false, off);
    plan.title = 'Start it in plan mode: Claude explores and presents a plan before changing anything';
    const spec = action('Spec', 'spec', t.id, false, off);
    spec.title = 'Start it with a design spec first (devdesk.board.specPrompt)';
    acts.append(start, plan, spec, action('Edit', 'edit', t.id, false, off), action('Delete', 'delete', t.id, false, off));
    card.append(acts);
    return card;
  }

  function render() {
    if (!last) return;
    const { board, loaded } = last;
    // Rebuilding replaces every element: put the focus back on the one that had it (same data-key).
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focused = active && lanesEl.contains(active) ? active : undefined;
    const focusKey = focused?.dataset.key;
    // A focused card that goes away (its session ended) leaves the focus on its lane's neighbour, so the keys still work.
    const laneEls = () => [...lanesEl.querySelectorAll('.lane')];
    const focusLane = focused?.classList.contains('card') ? laneEls().findIndex((l) => l.contains(focused)) : -1;
    const focusAt = focusLane >= 0 ? [...laneEls()[focusLane].querySelectorAll('.card')].indexOf(/** @type {HTMLElement} */ (focused)) : -1;
    // Keep the filter's options in sync (only when they changed, so an open dropdown stays open), keeping a chosen
    // worktree that has no cards right now.
    const names = new Set(board.worktrees);
    if (state.filter) names.add(state.filter);
    const options = ['', ...names];
    if ([...filterEl.options].map((o) => o.value).join('\n') !== options.join('\n')) {
      filterEl.replaceChildren(...options.map((n) => {
        const o = el('option', '', n || 'All');
        o.value = n;
        return o;
      }));
    }
    filterEl.value = state.filter;

    // The Worktree filter, then the search: the query's matches (hidden parked ones too), in the lane's order.
    const terms = search.terms();
    const byWorktree = (list) => (state.filter ? list.filter((s) => s.worktree === state.filter) : list);
    const found = search.found();
    const shown = (lane) => {
      if (found) return byWorktree([...lane.sessions, ...(lane.hidden || [])]).filter((s) => found.has(s.id));
      if (!terms.length) return byWorktree(lane.sessions);
      return byWorktree([...lane.sessions, ...(lane.hidden || [])]).filter((s) => search.matches(s));
    };
    const searching = terms.length > 0 || !!found;
    const count = (id) => shown(board.lanes.find((l) => l.id === id) || { sessions: [] }).length;
    const needYou = count('needs');
    const working = count('working');
    needsEl.hidden = !needYou;
    needsEl.textContent = `${needYou} need${needYou === 1 ? 's' : ''} you`;
    workingEl.hidden = !working;
    workingEl.textContent = `${working} working`;

    // The cards each lane shows, by key: a card stands in for one shown in the same lane only, which it is morphed into.
    const shownLanes = laneEls().map((l) => new Map(/** @type {HTMLElement[]} */ ([...l.querySelectorAll('.card[data-session]')]).map((c) => [c.dataset.key, c])));
    const lanes = board.lanes.map((lane, i) => {
      if (lane.id === 'backlog') {
        const plus = labelled(button('plus', '+', () => composer.focus({ later: true })), 'Write a prompt for later');
        plus.dataset.key = 'plus';
        const add = button('addcard', '+ Prompt for later…', () => composer.focus({ later: true }));
        add.dataset.key = 'addcard';
        return laneSection('lane', lane.title, String(lane.tasks.length), [...lane.tasks.map(taskCard), add], { glyph: LANE_GLYPHS[lane.id], extra: plus });
      }
      const sessions = shown(lane);
      const body = sessions.map((s) => sessionCard(s, shownLanes[i] || new Map()));
      // The Done / idle lane's divider, above its first idle card, when cards to review are above it.
      const firstIdle = lane.divider ? sessions.findIndex((s) => s.idle) : -1;
      if (firstIdle > 0) body.splice(firstIdle, 0, laneDivider(lane.divider));
      if (lane.more && !state.filter && !searching) body.push(el('div', 'more', `⋯ ${lane.more} more parked (Claude view)`));
      // A query that leaves the lane empty folds it to its heading, so the lanes that match (and the history lane) fit.
      if (searching && loaded && !sessions.length) return laneSection('lane collapsed', lane.title, '0', [], { glyph: LANE_GLYPHS[lane.id] });
      if (!sessions.length) body.push(el('p', 'empty', loaded ? 'Nothing here' : '…'));
      return laneSection('lane', lane.title, String(sessions.length), body, { glyph: LANE_GLYPHS[lane.id] });
    });
    const past = search.historyOn() ? search.history() : undefined;
    const pastCards = past ? byWorktree(past.results).sort((a, b) => b.at - a.at) : [];
    if (past) {
      // Asked, with nothing to show yet: it is searching.
      const searchingPast = past.phase === 'asked' && !pastCards.length && !past.indexing;
      const body = [];
      if (past.indexing) body.push(el('div', 'indexing', `Indexing history… (${past.indexing.indexed} of ${past.indexing.total} sessions)`));
      body.push(...pastCards.map(historyCard));
      if (searchingPast) body.push(el('p', 'empty', 'Searching history…'));
      else if (!pastCards.length && !past.indexing) body.push(el('p', 'empty', 'No past sessions match'));
      lanes.push(laneSection('lane history', 'Found in history', searchingPast ? '' : String(pastCards.length), body));
    }
    const built = el('div');
    built.append(...lanes);
    morphChildren(lanesEl, built);
    search.paint(board.lanes.reduce((n, l) => n + (l.id === 'backlog' ? 0 : shown(l).length), 0), pastCards.length, !!past?.indexing);
    refreshHover();
    composer.hints();
    // A card that stayed in place keeps the focus; one that moved (or went away) gets it back.
    if (focusKey && document.activeElement !== focused) {
      const again = /** @type {HTMLButtonElement[]} */ ([...lanesEl.querySelectorAll('[data-key]')]).find((e) => e.dataset.key === focusKey);
      if (again && !again.disabled) again.focus({ preventScroll: true });
      else if (focusLane >= 0) {
        const left = /** @type {HTMLElement[]} */ ([...laneEls()[focusLane].querySelectorAll('.card')]);
        if (left.length) left[Math.min(focusAt, left.length - 1)].focus({ preventScroll: true });
        else composer.refocus();
      }
    }
  }

  // ---- Keyboard: arrow keys between the prompt box, the cards and the Claude view ---------------------------------

  const nav = (function () {
    /** The card that last had the focus, to come back to from the prompt box. */
    let lastKey;
    const top = placedOnTop;
    /** The cards shown, per lane that has any, left to right. */
    const lanes = () => [...lanesEl.querySelectorAll('.lane')].map((l) => /** @type {HTMLElement[]} */ ([...l.querySelectorAll('.card')])).filter((c) => c.length);

    function focusCard(card) {
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    /** The card of `lane` nearest `from` up and down. */
    function nearest(lane, from) {
      const y = from.getBoundingClientRect().top;
      const dist = (c) => Math.abs(c.getBoundingClientRect().top - y);
      return lane.reduce((best, c) => (dist(c) < dist(best) ? c : best));
    }

    /**
     * A plain key in the empty prompt box: ← goes to the Claude view; ↑ (↓ with the box above the lanes) to the card
     * that had the focus last, else the first session (else prompt for later). False when the key stays in the box.
     */
    function leavePrompt(key) {
      if (key === 'ArrowLeft') {
        send('sidebar');
        return true;
      }
      if (key !== (top() ? 'ArrowDown' : 'ArrowUp')) return false;
      const all = lanes();
      if (!all.length) return false;
      const again = lastKey && all.flat().find((c) => c.dataset.key === lastKey);
      const sessions = all.find((l) => l[0].dataset.session);
      focusCard(again || (sessions || all[0])[0]);
      return true;
    }

    lanesEl.addEventListener('focusin', (ev) => {
      const t = /** @type {HTMLElement} */ (ev.target);
      if (!t.classList.contains('card')) return;
      lastKey = t.dataset.key;
      // A popup left open in the prompt box (the focus came from the Claude view, with no mousedown to close it) would
      // take the card's keys: Enter would run its highlighted row, the arrows would move its highlight.
      if (popup.isOpen) popup.close();
    });
    lanesEl.addEventListener('keydown', (ev) => {
      const card = /** @type {HTMLElement} */ (ev.target);
      if (!card.classList.contains('card') || !plain(ev) || popup.isOpen) return;
      const all = lanes();
      const li = all.findIndex((l) => l.includes(card));
      if (li < 0) return;
      const lane = all[li];
      const ci = lane.indexOf(card);
      let next;
      switch (ev.key) {
        case 'ArrowUp':
          next = ci === 0 && top() ? 'prompt' : lane[ci - 1];
          break;
        case 'ArrowDown':
          next = ci === lane.length - 1 && !top() ? 'prompt' : lane[ci + 1];
          break;
        case 'ArrowLeft':
          next = li === 0 ? 'sidebar' : nearest(all[li - 1], card);
          break;
        case 'ArrowRight':
          if (li < all.length - 1) next = nearest(all[li + 1], card);
          break;
        case 'Home':
          next = lane[0];
          break;
        case 'End':
          next = lane[lane.length - 1];
          break;
        case 'Escape':
          next = 'prompt';
          break;
        default:
          return;
      }
      ev.preventDefault();
      if (next === 'prompt') composer.refocus();
      // Out of the leftmost lane: the Claude view, on this session's row.
      else if (next === 'sidebar') send('sidebar', { id: card.dataset.session });
      else if (next) focusCard(next);
    });

    /** How long after `enter` the box takes the focus back from wherever it lands. */
    const ENTER_MS = 1500;
    /** Ends the current `enter`'s watch, if one runs. */
    let endEnter = () => {};

    /**
     * → from the Claude view, devdesk.board.focusPrompt: the prompt box (↑, or ↓ with the box on top, goes on to the
     * card that had the focus). The message can arrive before VS Code gives the webview the focus (over Remote-SSH it
     * often does), and taking the focus the webview puts it back on the element it last had, or on nothing. So for a
     * moment the box takes it back whenever it lands on that element or on nothing, until a key or click of yours.
     */
    function enter() {
      endEnter();
      const box = document.getElementById('prompt');
      const before = document.activeElement;
      const go = () => {
        const at = document.activeElement;
        if (at !== box && (!at || at === document.body || at === before)) composer.refocus();
      };
      composer.refocus();
      const timer = setInterval(go, 50);
      const onFocus = () => setTimeout(go);
      const end = () => {
        clearInterval(timer);
        clearTimeout(stop);
        window.removeEventListener('focus', onFocus);
        for (const t of ['keydown', 'pointerdown']) window.removeEventListener(t, end, true);
        endEnter = () => {};
      };
      const stop = setTimeout(end, ENTER_MS);
      window.addEventListener('focus', onFocus);
      for (const t of ['keydown', 'pointerdown']) window.addEventListener(t, end, true);
      endEnter = end;
    }

    /** Cards to go to with ↑ from the prompt box. */
    const hasCards = () => lanes().length > 0;

    return { leavePrompt, enter, hasCards };
  })();

  // ---- Popup: one listbox under a footer control, for +, /, @, where, model and mode -------------------------------

  /** How a `/` row's badge (core/commandMenu.ts `Badge`) shows: a word, or an icon, with what it means on hover. */
  const BADGES = {
    board: { title: 'Done by the board itself: nothing is sent to Claude' },
    session: { title: 'Sent to a running session you pick' },
    terminal: { icon: 'terminal', title: 'Opens a panel in the session, which is opened so you can answer it' },
    unavailable: { title: 'Not available from the board: it says why if you send it' },
  };

  const popup = (function () {
    const box = $('popup');
    let rows = [];
    let active = -1;
    let onClose;
    /** The footer control the open popup is under (none for the `/` and `@` lists). */
    let openAnchor;

    function close() {
      if (box.hidden) return;
      box.hidden = true;
      openAnchor = undefined;
      box.replaceChildren();
      rows = [];
      active = -1;
      prompt.setAttribute('aria-expanded', 'false');
      prompt.removeAttribute('aria-activedescendant');
      const done = onClose;
      onClose = undefined;
      if (done) done();
    }

    /** Whether the open popup is the one under `anchor`. */
    const isOpenAt = (anchor) => !box.hidden && openAnchor === anchor;

    function highlight(i) {
      if (!rows.length) return;
      active = (i + rows.length) % rows.length;
      rows.forEach((r, j) => r.node.classList.toggle('active', j === active));
      rows[active].node.scrollIntoView({ block: 'nearest' });
      prompt.setAttribute('aria-activedescendant', rows[active].node.id);
    }

    /**
     * Opens the popup under `anchor` (the whole box when none) with `items` ({ label, detail?, description?, checked?,
     * badge?, pick, enter?, keep? } or { section }); `header` and `hint` go on top, `empty` shows when there are no
     * items, `active` is the row to highlight (else the checked one). `pick` runs on Tab, and on Enter or click unless
     * the item has `enter`; the popup closes unless the item says `keep`.
     * @param {{ anchor?: HTMLElement, header?: string, hint?: string, items: any[], empty?: string, close?: () => void, active?: number }} _
     */
    function open({ anchor, header, hint, items, empty, close: closed, active: start }) {
      box.classList.toggle('anchored', !!anchor);
      openAnchor = anchor;
      box.style.left = '';
      box.replaceChildren();
      rows = [];
      active = -1;
      onClose = closed;
      if (header || hint) {
        const h = el('div', 'pop-head');
        if (header) h.append(el('span', 'pop-title', header));
        if (hint) h.append(el('span', 'pop-hint', hint));
        box.append(h);
      }
      items.forEach((item, i) => {
        if (item.section) {
          box.append(el('div', 'pop-section', item.section));
          return;
        }
        const row = el('div', 'pop-row');
        row.id = `pop-${i}`;
        // A built-in's category (A–E; see core/builtins.ts), for styling and for what Enter does.
        if (item.category) row.dataset.category = item.category;
        row.setAttribute('role', 'option');
        if (item.checked !== undefined) row.setAttribute('aria-selected', String(!!item.checked));
        const main = el('div', 'pop-main');
        main.append(el('span', 'pop-label', item.label));
        if (item.detail) main.append(el('span', 'pop-detail', item.detail));
        const badge = item.badge && BADGES[item.badge];
        if (badge) {
          const b = el('span', 'pop-badge', badge.icon ? '' : item.badge);
          b.dataset.badge = item.badge;
          b.title = badge.title;
          if (badge.icon) {
            b.append(icon(ICONS[badge.icon]));
            b.setAttribute('role', 'img');
            b.setAttribute('aria-label', badge.title);
          }
          main.append(b);
        }
        row.append(main);
        if (item.description) {
          row.append(el('div', 'pop-desc', item.description));
          row.title = item.description;
        }
        if (item.checked) row.append(el('span', 'pop-check', '✓'));
        const r = { node: row, item };
        const at = rows.push(r) - 1;
        row.addEventListener('mousedown', (ev) => ev.preventDefault());
        row.addEventListener('click', () => pick(r, true));
        row.addEventListener('mousemove', () => at !== active && highlight(at));
        box.append(row);
      });
      if (!rows.length && empty) box.append(el('div', 'pop-empty', empty));
      box.hidden = false;
      prompt.setAttribute('aria-expanded', 'true');
      if (anchor) {
        // Under (or, at the bottom, over) its control, kept inside the composer, so a menu from the right-hand mode
        // button opens leftwards.
        const room = composerEl.clientWidth - box.offsetWidth - 6;
        box.style.left = `${Math.max(6, Math.min(anchor.offsetLeft, room))}px`;
      }
      // It fits in the room it opens into: above the box at the bottom, below it on top.
      const rect = composerEl.getBoundingClientRect();
      const fits = placedOnTop() ? window.innerHeight - rect.bottom - 12 : rect.top - 12;
      box.style.maxHeight = `${Math.max(120, Math.min(320, fits))}px`;
      highlight(start ?? Math.max(0, rows.findIndex((r) => r.item.checked)));
    }

    /** Runs the row's `pick` (Tab), or its `enter` when there is one (`enter`: Enter or a click). */
    function pick(r, enter) {
      ((enter && r.item.enter) || r.item.pick)();
      if (!r.item.keep) close();
    }

    /** Arrow keys, Enter, Tab and Escape while the popup is open; true when the key was used. */
    function key(ev) {
      if (box.hidden) return false;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        highlight(active + (ev.key === 'ArrowDown' ? 1 : -1));
        return true;
      }
      if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.shiftKey && !ev.altKey && rows[active]) {
        pick(rows[active], ev.key === 'Enter');
        return true;
      }
      // Alt+Enter on a row that can be saved for later (a `/` or `@` completion) saves it completed, not what was typed.
      if (ev.key === 'Enter' && ev.altKey && !ev.shiftKey && rows[active] && rows[active].item.later) {
        rows[active].item.later();
        close();
        return true;
      }
      // Tab with nothing to pick (an empty list, such as "No matching skills or commands") keeps the focus in place.
      if (ev.key === 'Tab' && !ev.shiftKey && !ev.altKey) return true;
      if (ev.key === 'Escape') {
        close();
        return true;
      }
      return false;
    }

    // A popup opened from a footer button keeps the keyboard on that button: arrows, Enter and Escape still drive it.
    document.addEventListener('keydown', (ev) => {
      if (ev.target === prompt || ev.target === nameInput || ev.target === $('search') || box.hidden) return;
      if (key(ev)) ev.preventDefault();
    });
    document.addEventListener('mousedown', (ev) => {
      const t = /** @type {HTMLElement} */ (ev.target);
      if (!box.hidden && !box.contains(t) && !t.closest('.composer .footer')) close();
    });
    return {
      open,
      close,
      key,
      isOpenAt,
      get isOpen() {
        return !box.hidden;
      },
      /** The highlighted row's item, if any. */
      get current() {
        return rows[active] && rows[active].item;
      },
    };
  })();

  // ---- Composer ----------------------------------------------------------------------------------------------------

  const composerEl = $('composer');
  const prompt = /** @type {HTMLTextAreaElement} */ ($('prompt'));
  const whereBtn = $('where');
  const nameInput = /** @type {HTMLInputElement} */ ($('wtname'));
  const modelBtn = $('model');
  const modeBtn = $('mode');
  const laterBtn = /** @type {HTMLButtonElement} */ ($('later'));
  const sendBtn = /** @type {HTMLButtonElement} */ ($('send'));
  const errorEl = $('cerror');
  const editingEl = $('editing');
  const noticeEl = $('notice');
  const addDirsEl = $('adddirs');
  const paneEl = $('pane');
  const argHintEl = $('arghint');

  const composer = (function () {
    /** @type {import('../src/boardComposer').ComposerInfo} The composer's choices, from the last board posted. */
    let info = /** @type {any} */ ({ notReady: '', modes: [], defaultMode: '', models: [{ value: DEFAULT, label: DEFAULT, description: '', efforts: [] }], worktrees: [] });
    let where = 'main';
    let later = false;
    let busy = false;
    let editing;
    /** While a prompt for later is edited: the text typed in the box before, put back when the edit ends. */
    let draftBeforeEdit;
    /** Why the last send failed, shown until the prompt changes. */
    let failure = '';
    let historyAt = -1;
    /** The `/` or `@` being completed: where it starts in the prompt, and the latest query's sequence number. */
    let completing;
    /**
     * When the `/` or `@` was typed (or put by its footer button) in front of text, how many characters at the end of the
     * box are that text: a completion replaces the word typed after the trigger, never the text it was put in front of.
     */
    let kept;
    /** The `/` or `@` (kind and start) that `kept` was counted for: it holds until a different one is completed. */
    let keptFor;
    let seq = 0;
    let completeTimer;
    /** The command a `/` row put in the box (`/name `) and its argument hint, shown under the box until an argument is typed. */
    let argHint;
    /** The latest query asks again for the same text (the `/` list changed), so the highlighted row stays. */
    let relisting = false;
    /** The `/` or `@` word the popup's rows answer (kind, start and query), until the next answer comes. */
    let shown;
    /** Whether `a` and `b` are the same `/` or `@` word (its trigger at the same place), whatever follows it. */
    const sameWord = (a, b) => !!a && !!b && a.kind === b.kind && a.start === b.start;

    const mode = () => info.modes.find((m) => m.name === state.mode) || info.modes.find((m) => m.name === info.defaultMode) || info.modes[0];
    /**
     * The chosen model pill row ({ value, label, description, efforts }), else the first (Default). While the CLI's
     * models are not listed yet (a reload, or its settings changed), a remembered model it may list is kept, with
     * Default's efforts: Enter starts on it (the extension waits for the list), not on Default. One of Claude's aliases
     * (picked from the alias rows before the CLI listed its models) stays chosen without a row.
     */
    const modelRow = () =>
      info.models.find((r) => r.value === state.model) ||
      (info.aliases || []).find((r) => r.value === state.model) ||
      (info.modelsListing && state.model && state.model !== DEFAULT
        ? { value: state.model, label: state.model, description: 'Not listed yet', efforts: info.models[0].efforts }
        : info.models[0]);
    const model = () => modelRow().value;
    /** The chosen model's effort choices: Default, then its levels (none for a model without effort). */
    const efforts = () => [DEFAULT, ...(modelRow().efforts || [])];
    const effort = () => /** @type {string} */ (efforts().includes(/** @type {string} */ (state.effort)) ? state.effort : DEFAULT);
    const modelLabel = (r) => (r.value === DEFAULT ? 'Default model' : r.label);
    const worktree = () => info.worktrees.find((w) => w.dir === where);

    /** Ends the `/` or `@` completion in progress and closes its menu. */
    function stopCompleting() {
      if (!completing) return;
      completing = undefined;
      popup.close();
    }

    function update(next) {
      // The `/` list changed (late MCP and plugin commands): an open `/` menu asks again.
      const relist = completing && completing.kind === '/' && next.commandsVersion !== info.commandsVersion;
      info = next;
      if (relist) ask({ ...completing, relist: true });
      if ((where !== 'main' && where !== 'new' && !worktree()) || (where === 'new' && info.noWorktrees)) where = 'main';
      // devdesk.board.promptPlacement changes take effect at once (the box keeps its text and focus).
      if (info.placement && document.body.dataset.placement !== info.placement) {
        popup.close();
        document.body.dataset.placement = info.placement;
      }
      paint();
    }

    /**
     * Changes remembered choices (mode, model, effort, Ultracode) and repaints. A new model keeps the effort only when it
     * offers it, else Default (a model without effort has none). A model with no row yet (`/model <id>` just added it,
     * its row comes with the next board post) keeps the effort: the first row's efforts say nothing about it.
     */
    function choose(patch) {
      applyChoice(state, patch);
      if (!beforeEdit) keepChoice(state, patch);
      paint();
    }

    /** Saves the remembered choices `patch` changed in `choices` (and the effort a new model may have reset). */
    function keepChoice(choices, patch) {
      const choice = {};
      for (const k of Object.keys(patch)) choice[k] = choices[k];
      if (patch.model !== undefined) choice.effort = choices.effort;
      keep({ choice });
    }

    /** Applies `patch` to `choices`; a new model with a row that lacks the chosen effort resets it to Default (see `choose`). */
    function applyChoice(choices, patch) {
      Object.assign(choices, patch);
      const row = info.models.find((r) => r.value === choices.model);
      if (patch.model !== undefined && row && ![DEFAULT, ...(row.efforts || [])].includes(choices.effort)) choices.effort = DEFAULT;
    }

    /**
     * A choice the user changed in the box (a pill, Shift+Tab): also closes the notice, whose actions ("Send as text
     * anyway") would run with the choices it was shown for, not the ones the pills now show.
     */
    function pickChoice(patch) {
      dismissNotice();
      choose(patch);
    }

    /**
     * A choice a board command made (`/model`, `/effort`, `/ultracode`): it changes the remembered choices, so it
     * outlasts the edit of a prompt for later too (whose own choices come back to the remembered ones when it ends).
     */
    function chooseRemembered(patch) {
      if (beforeEdit) {
        applyChoice(beforeEdit, patch);
        keepChoice(beforeEdit, patch);
      }
      choose(patch);
    }

    /** Back to starting a session now, not editing a saved prompt, with the remembered choices. */
    function reset() {
      if (draftBeforeEdit !== undefined) prompt.value = draftBeforeEdit;
      draftBeforeEdit = undefined;
      editing = undefined;
      later = false;
      if (beforeEdit) Object.assign(state, beforeEdit);
      beforeEdit = undefined;
      paint();
    }

    /** Remembers the box's text (the text from before the edit while a prompt for later is edited). */
    function keepDraft() {
      const draft = draftBeforeEdit !== undefined ? draftBeforeEdit : prompt.value;
      if (draft === state.draft) return;
      state.draft = draft;
      keep({ draft });
    }

    function paint() {
      const m = mode();
      composerEl.dataset.tone = (m && m.tone) || 'default';
      // The square around the box takes the same colour, on its top edge.
      paneEl.dataset.tone = composerEl.dataset.tone;
      modeBtn.replaceChildren(icon(ICONS[TONE_ICONS[(m && m.tone) || 'default']]), el('span', 'label', m ? m.name : 'Default'));
      modeBtn.title = `${m ? `${m.name}: ${m.description}` : 'Mode'}. Click to change, or press Shift+Tab to cycle.`;
      const w = where === 'new' ? 'New worktree' : where === 'main' ? 'main' : (worktree() || { name: 'main' }).name;
      whereBtn.replaceChildren(icon(ICONS[where === 'main' ? 'folder' : 'branch']), el('span', 'label', w), icon(ICONS.chevron));
      whereBtn.title = where === 'new' ? 'Starts in a new worktree, named as typed next to this (else after the prompt)' : `Starts in ${w}`;
      nameInput.hidden = where !== 'new';
      const parts = [modelLabel(modelRow())];
      if (effort() !== DEFAULT) parts.push(effort());
      if (state.ultracode) parts.push('Ultracode');
      modelBtn.replaceChildren(el('span', 'label', parts.join(' · ')), icon(ICONS.chevron));
      const off = busy || !prompt.value.trim() || !!info.notReady;
      sendBtn.disabled = off;
      laterBtn.disabled = off;
      sendBtn.title = later ? 'Save for later (Enter)' : info.opensSession ? 'Start a new session and open it (Enter)' : 'Start a new session (Enter): it runs in the background, its card shows here';
      sendBtn.setAttribute('aria-label', later ? 'Save for later' : 'Start a new session');
      sendBtn.replaceChildren(icon(ICONS[later ? 'later' : 'send']));
      laterBtn.title = later ? 'Saving for later: click to start now instead' : `Save for later (${ALT_ENTER}): it runs only when you click Start, Plan or Spec`;
      laterBtn.classList.toggle('on', later);
      editingEl.hidden = !editing;
      keepDraft();
      paintAddDirs();
      hints();
      const error = info.notReady || failure;
      errorEl.textContent = error;
      errorEl.hidden = !error;
      const hint = argHint && prompt.value.startsWith(argHint.prefix) && !prompt.value.slice(argHint.prefix.length).trim();
      if (!hint) argHint = undefined;
      argHintEl.hidden = !hint;
      argHintEl.replaceChildren(...(hint ? [el('span', 'arghint-cmd', argHint.name), el('span', 'arghint-args', argHint.hint)] : []));
      grow();
    }

    /** The directories added with /add-dir, as chips with a × that takes one back (the next session gets them). */
    function paintAddDirs() {
      const dirs = info.addDirs || [];
      addDirsEl.hidden = !dirs.length;
      addDirsEl.replaceChildren(
        ...dirs.map((dir) => {
          const chip = el('span', 'chip adddir');
          chip.title = `The next session can also work in ${dir} (--add-dir)`;
          chip.append(el('span', 'label', `+ ${dir.split('/').filter(Boolean).pop() || dir}`));
          chip.append(labelled(button('ghost', '×', () => send('removeAddDir', { dir })), `Don't add ${dir}`));
          return chip;
        }),
      );
    }

    /**
     * The hint's navigation keys work in an empty box only (with text, ←, ↑ and ⌥↑ move the cursor): shown while it is
     * empty, ↑ cards while there are some, and earlier prompts while there are any (on ↑ itself when there are no cards).
     */
    function hints() {
      const cards = nav.hasCards();
      $('hint-nav').hidden = !!prompt.value;
      $('hint-cards').hidden = !cards;
      $('hint-earlier').hidden = !state.history.length;
      // On top, ↓ goes to the cards and plain ↑ stays free for earlier prompts.
      $('hint-cards-key').textContent = placedOnTop() ? '↓' : '↑';
      $('hint-history').textContent = cards && !placedOnTop() ? ALT_ENTER.replace('⏎', '↑') : '↑';
    }

    function grow() {
      prompt.style.height = 'auto';
      // Up to the CSS max-height (the pane at 60% of the window); past it the textarea scrolls.
      prompt.style.height = `${Math.min(prompt.scrollHeight, parseFloat(getComputedStyle(prompt).maxHeight))}px`;
    }

    function submit(asLater) {
      const text = prompt.value.trim();
      if (!text || busy || info.notReady) return;
      busy = true;
      failure = '';
      // The text is sent: its `/` or `@` menu is done, and an answer still on its way (Enter before it came) is dropped.
      stopCompleting();
      kept = keptFor = undefined;
      clearTimeout(completeTimer);
      seq++;
      paint();
      send('compose', {
        prompt: text,
        where,
        worktreeName: where === 'new' ? nameInput.value.trim() : undefined,
        mode: mode() ? mode().name : '',
        model: model(),
        effort: effort(),
        ultracode: state.ultracode,
        later: asLater,
        replaces: editing,
      });
    }

    /**
     * Empties the box after its text ran (into the history); after a session started (`started`), back to starting in
     * main. A command the board ran itself (`/model`, `/add-dir`, …) keeps where the next session starts.
     */
    function clearBox(started) {
      const text = prompt.value.trim();
      if (text && state.history[state.history.length - 1] !== text) state.history.push(text);
      state.history = state.history.slice(-HISTORY_MAX);
      if (text) keep({ remember: text });
      prompt.value = '';
      prompt.placeholder = PLACEHOLDER;
      if (started) {
        nameInput.value = '';
        where = 'main';
      }
      historyAt = -1;
      reset();
    }

    /**
     * What this project folder kept (`restore`, when the webview loaded); what it has not saved yet comes from the
     * webview's own state of versions before (saved now), else stays the default.
     */
    function restore(kept) {
      const choices = beforeEdit || state;
      const choice = kept.choice || pick(legacy, ['mode', 'model', 'effort', 'ultracode']);
      if (choice.mode !== undefined) choices.mode = choice.mode;
      if (choice.model !== undefined) choices.model = choice.model;
      if (choice.effort !== undefined) choices.effort = choice.effort;
      if (choice.ultracode !== undefined) choices.ultracode = !!choice.ultracode;
      if (!kept.choice && Object.keys(choice).length) keep({ choice });
      const history = kept.history || (Array.isArray(legacy.history) ? legacy.history.filter((t) => typeof t === 'string').slice(-HISTORY_MAX) : []);
      state.history = history.slice(-HISTORY_MAX);
      if (!kept.history) for (const remember of state.history) keep({ remember });
      const draft = kept.draft !== undefined ? kept.draft : typeof legacy.draft === 'string' ? legacy.draft : '';
      // Typed (or a prompt for later taken) before this came: the box keeps it.
      if (!prompt.value && !editing && draftBeforeEdit === undefined) {
        prompt.value = draft;
        state.draft = draft;
        if (kept.draft === undefined && draft) keep({ draft });
      }
      paint();
    }

    /** The extension's answer to `compose`: empty the box, keep it (`keep`: a notice says why), or show the error. */
    function composed(ok, error, keep, started) {
      busy = false;
      if (ok && !keep) clearBox(started);
      else {
        if (!ok) failure = error || 'The session was not started.';
        paint();
      }
      prompt.focus();
    }

    /** A message in the box from the extension ({ text, tone, actions: [{ id, label }] }); an empty text removes it. */
    function notice(m) {
      noticeEl.replaceChildren();
      noticeEl.hidden = !m.text;
      if (!m.text) return;
      noticeEl.dataset.tone = m.tone || 'info';
      noticeEl.append(el('span', 'notice-text', m.text));
      for (const a of m.actions || []) {
        noticeEl.append(
          button('link', a.label, () => {
            notice({ text: '' });
            // The clicked button is gone with the notice; keep typing in the box, not on the page.
            prompt.focus();
            send('noticeAction', { id: a.id });
          }),
        );
      }
    }

    function cycleMode() {
      if (!info.modes.length) return;
      pickChoice({ mode: info.modes[(info.modes.indexOf(mode()) + 1) % info.modes.length].name });
    }

    function modeMenu() {
      popup.open({
        anchor: modeBtn,
        header: 'Modes',
        hint: '⇧ + tab to switch',
        items: info.modes.map((m) => ({
          label: m.name,
          description: m.description,
          checked: m === mode(),
          pick: () => pickChoice({ mode: m.name }),
        })),
        close: () => prompt.focus(),
      });
    }

    /**
     * Models as a list (name and description, so 1M and 200K context differ); the chosen model's effort as one row that
     * cycles (as in Claude Code's mode popup; none for a model without effort) and an Ultracode switch.
     */
    function modelMenu(at) {
      const levels = efforts();
      const hasEffort = levels.length > 1;
      // Re-opens the popup with the row just changed still highlighted (rows after the models: effort, Ultracode).
      const change = (row, patch) => () => {
        pickChoice(patch);
        modelMenu(info.models.length + row);
      };
      /** @type {any[]} */
      const items = info.models.map((r) => ({ label: modelLabel(r), description: r.description, checked: r.value === model(), pick: () => pickChoice({ model: r.value }) }));
      items.push({ section: 'Options' });
      if (hasEffort) {
        items.push({
          label: `Effort: ${effort().toLowerCase()}`,
          description: `Click to cycle: ${levels.join(', ').toLowerCase()}`,
          keep: true,
          pick: change(0, { effort: levels[(levels.indexOf(effort()) + 1) % levels.length] }),
        });
      }
      items.push({
        label: `Ultracode: ${state.ultracode ? 'on' : 'off'}`,
        description: 'Run dynamic workflows on this task (adds “ultracode” to the prompt)',
        keep: true,
        pick: change(hasEffort ? 1 : 0, { ultracode: !state.ultracode }),
      });
      const typed = info.typedModels || [];
      if (typed.length) {
        items.push({
          label: 'Forget typed models',
          description: `Stop offering the models typed with /model: ${typed.join(', ')}`,
          pick: () => send('forgetTypedModels'),
        });
      }
      popup.open({ anchor: modelBtn, header: 'Model', items, close: () => prompt.focus(), active: at });
    }

    /** Opens the model list (`effort`: with the effort row highlighted, when the model has one). */
    function openPicker(which) {
      prompt.focus();
      modelMenu(which === 'effort' && efforts().length > 1 ? info.models.length : undefined);
    }

    function whereMenu() {
      const items = [
        { label: 'main', description: 'The workspace itself', checked: where === 'main', pick: () => setWhere('main') },
        ...info.worktrees.map((w) => ({ label: w.name, detail: w.dir, checked: where === w.dir, pick: () => setWhere(w.dir) })),
      ];
      // A plain folder (neither a package workspace nor a git repository) has no worktrees to make: the hint says why.
      if (!info.noWorktrees) items.push({ label: 'New worktree…', description: 'Make a worktree for this prompt: named as you type next to this, else after the prompt', checked: where === 'new', pick: () => setWhere('new') });
      const hint = info.noWorktrees ? 'No new worktrees: this folder is not a git repository' : undefined;
      popup.open({ anchor: whereBtn, header: 'Start in', hint, items, close: () => (where === 'new' ? nameInput : prompt).focus() });
    }

    /** The folder pill (or Escape in the name field); closes the notice, as `pickChoice`. */
    function setWhere(w) {
      dismissNotice();
      where = w;
      paint();
    }

    function plusMenu() {
      popup.open({
        anchor: $('plus'),
        items: [
          { label: 'Attach file…', description: 'Pick files; each is mentioned with @ in the prompt', pick: () => send('attach', { where }) },
          { label: 'Mention a file', description: 'Type @ and part of a file name', pick: () => insertTrigger('@') },
          { label: 'Skill or command', description: 'Type / at the start of the prompt', pick: () => insertTrigger('/') },
        ],
        close: () => prompt.focus(),
      });
    }

    /**
     * Puts `/` at the start (or `@` at the caret) and opens its completions. A command already at the start loses its
     * name, so the one picked replaces it instead of being spliced into it.
     */
    function insertTrigger(ch) {
      prompt.focus();
      if (ch === '/') {
        prompt.value = `/${prompt.value.replace(/^\/[\w:.-]*/, '')}`;
        prompt.setSelectionRange(1, 1);
      } else {
        const at = prompt.selectionStart;
        const before = prompt.value.slice(0, at);
        const add = before && !/\s$/.test(before) ? ' @' : '@';
        prompt.setRangeText(add, at, prompt.selectionEnd, 'end');
      }
      onInput(true);
    }

    function insert(text) {
      prompt.focus();
      prompt.setRangeText(text, prompt.selectionStart, prompt.selectionEnd, 'end');
      onInput();
    }

    /**
     * The `/` or `@` word the caret is in, if any: `/` at the very start, or after whitespace (`stacked`: skills only,
     * after fewer than `info.maxStacked` `/commands`, else `inline`, as in the middle of the text), unless the text
     * starts with a built-in the board handles (`info.unstackable`): `slashWord` in src/core/slashTrigger.ts.
     */
    function trigger() {
      const at = prompt.selectionStart;
      if (at !== prompt.selectionEnd) return undefined;
      const before = prompt.value.slice(0, at);
      const slash = slashWord(before, info.unstackable || [], info.maxStacked);
      if (slash) return { kind: '/', ...slash };
      // (A `/` word no menu opens for, after an unstackable built-in, is never an `@` one.)
      const mention = /(^|\s)@([^\s@]*)$/.exec(before);
      if (mention) return { kind: '@', start: at - mention[2].length - 1, query: mention[2] };
      return undefined;
    }

    /** Closes the box's notice (typing, or Escape); true when one was shown. */
    function dismissNotice() {
      if (noticeEl.hidden) return false;
      notice({ text: '' });
      send('noticeDismissed');
      return true;
    }

    /**
     * `typed`: the box's text was just edited. `clicked`: a click into a `/` or `@` word, which edits nothing, so the
     * box's notice and failure stay (only typing or Escape closes them).
     */
    function onInput(typed, clicked) {
      if (!clicked) {
        failure = '';
        dismissNotice();
        paint();
      }
      const t = trigger();
      // A trigger just typed with nothing after it yet: whatever follows the caret was there before it. The same trigger
      // completed again (typing or a click back into it after Escape closed its menu) keeps what was counted for it.
      if (!completing) {
        if (typed && t && !t.query) {
          kept = prompt.value.length - prompt.selectionEnd;
          keptFor = { kind: t.kind, start: t.start };
        } else if (!sameWord(t, keptFor)) {
          kept = keptFor = undefined;
        }
      }
      if (!t) {
        kept = keptFor = undefined;
        stopCompleting();
        return;
      }
      completing = t;
      ask(t);
    }

    /**
     * The caret moved without typing (arrow keys, Home, End): out of the `/` or `@` word closes its popup, elsewhere in
     * it asks again for the text before the caret, so Enter and Tab never act on where the caret was.
     */
    function caretMoved() {
      if (!completing) return;
      const t = trigger();
      if (!t) stopCompleting();
      else if (!sameWord(t, completing) || t.query !== completing.query) {
        if (!sameWord(t, completing)) kept = keptFor = undefined;
        completing = t;
        // The highlighted row stays highlighted when the new list still has it.
        ask({ ...t, relist: true });
      }
    }

    /** Where the `/` or `@` word the caret is in ends (a completion replaces all of it, never splicing it). */
    function wordEnd(kind) {
      const at = prompt.selectionEnd;
      const end = at + /** @type {RegExpExecArray} */ ((kind === '/' ? /^[\w:.-]*/ : /^[^\s@]*/).exec(prompt.value.slice(at)))[0].length;
      return kept === undefined ? end : Math.max(at, Math.min(end, prompt.value.length - kept));
    }

    /** Asks the extension for `t`'s completions (`@` after a pause in typing; `relist`: the same query again). */
    function ask(t) {
      clearTimeout(completeTimer);
      relisting = !!t.relist;
      completeTimer = setTimeout(() => send('complete', { kind: t.kind, query: t.query, where, seq: ++seq, stacked: !!t.stacked }), t.kind === '@' ? 200 : 0);
    }

    function completions(msg) {
      if (!completing || msg.seq !== seq || msg.kind !== completing.kind) return;
      const t = completing;
      // Asked again because the `/` list changed: the same row stays highlighted.
      const was = relisting && popup.isOpen && popup.current;
      relisting = false;
      shown = { kind: t.kind, start: t.start, query: t.query };
      // A `/` word in the middle of the text that names no skill (a path such as /tmp) opens nothing.
      if (t.inline && !msg.items.length) {
        popup.close();
        completing = undefined;
        return;
      }
      const at = was ? msg.items.findIndex((c) => c.label === was.label) : -1;
      /** Tab: `/name ` (or the file) in place of what was typed, and the command's argument hint under the box. */
      const put = (c) => {
        // The insert's trailing space stands for a space already after the word (no "/model  fix it").
        const end = wordEnd(t.kind);
        prompt.setRangeText(c.insert, t.start, / $/.test(c.insert) && prompt.value[end] === ' ' ? end + 1 : end, 'end');
        completing = undefined;
        argHint = c.hint ? { prefix: prompt.value.slice(0, prompt.selectionStart), name: c.insert.trim(), hint: c.hint } : undefined;
        paint();
      };
      popup.open({
        items: msg.items.map((c) => ({
          label: c.label,
          detail: c.detail,
          description: c.description,
          category: c.category,
          badge: c.badge,
          pick: () => put(c),
          // Enter on a command the board runs with no argument (A, C, D) or blocks (E) runs it, unless text follows its word;
          // in Save for later (or editing a prompt for later) it is saved instead, as plain Enter does.
          enter: c.run
            ? () => {
                if (prompt.value.slice(wordEnd(t.kind)).trim()) return put(c);
                prompt.value = c.insert.trimEnd();
                completing = undefined;
                submit(later);
              }
            : undefined,
          // Alt+Enter: the completed text is saved for later (a command the board runs is saved, not run).
          later: () => {
            put(c);
            argHint = undefined;
            submit(true);
          },
        })),
        empty: t.kind === '/' ? (t.stacked ? 'No matching skills' : 'No matching skills or commands') : 'No files found',
        active: at >= 0 ? at : undefined,
        close: () => {
          completing = undefined;
        },
      });
    }

    function onKey(ev) {
      if (ev.isComposing) return;
      // A caret moved since the last keyup (a key held down) is checked before Enter or Tab acts on the popup.
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        caretMoved();
        // The popup still shows an earlier query's rows (the answer for the text now typed is on its way): Enter and Tab
        // never act on them. Enter sends the text as typed; Tab waits for the answer, which opens the menu again.
        const t = completing;
        if (t && popup.isOpen && shown && !(sameWord(shown, t) && shown.query === t.query)) {
          popup.close();
          if (ev.key === 'Tab') {
            ev.preventDefault();
            completing = t;
            return;
          }
        }
        // Tab before the first answer for a `/` or `@` word (the `@` pause, or the `/` round trip): the focus stays in
        // the box, and the answer opens the menu there.
        if (ev.key === 'Tab' && !ev.shiftKey && !ev.altKey && completing && !popup.isOpen) {
          ev.preventDefault();
          return;
        }
      }
      if (popup.key(ev)) {
        ev.preventDefault();
        return;
      }
      if (ev.key === 'Tab' && ev.shiftKey) {
        ev.preventDefault();
        cycleMode();
      } else if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submit(ev.altKey || later);
      } else if (ev.key === 'Escape' && (editing || later)) {
        ev.preventDefault();
        reset();
      } else if (ev.key === 'Escape' && dismissNotice()) {
        ev.preventDefault();
      } else if (!prompt.value && plain(ev) && !popup.isOpen && nav.leavePrompt(ev.key)) {
        // With a popup open (a picker a command opened on an emptied box), the keys stay with it and the box.
        ev.preventDefault();
      } else if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.ctrlKey && !ev.metaKey && state.history.length && (historyAt >= 0 || (ev.key === 'ArrowUp' && !prompt.value))) {
        // Earlier prompts: ⌥↑ (plain ↑ when there are no cards to go to), then ↑ / ↓ while one is shown.
        ev.preventDefault();
        const n = state.history.length;
        historyAt = ev.key === 'ArrowUp' ? (historyAt < 0 ? n - 1 : Math.max(0, historyAt - 1)) : historyAt + 1;
        if (historyAt >= n) {
          historyAt = -1;
          prompt.value = '';
        } else prompt.value = state.history[historyAt];
        paint();
      }
    }

    // The shortcut as this keyboard shows it: Option on a Mac, Alt elsewhere.
    prompt.placeholder = prompt.placeholder.replace('⌥⏎', ALT_ENTER);
    /** @type {HTMLElement} */ (laterBtn.querySelector('kbd')).textContent = ALT_ENTER;
    $('hint-later').textContent = ALT_ENTER;
    const PLACEHOLDER = prompt.placeholder;
    prompt.value = state.draft;
    prompt.addEventListener('input', () => {
      historyAt = -1;
      keepDraft();
      if (!prompt.value) prompt.placeholder = PLACEHOLDER;
      onInput(true);
    });
    // A pasted image (a screenshot, an image copied in a browser) goes to the extension, which saves it and answers
    // with its `@` mention to insert at the caret. Text pastes as usual.
    prompt.addEventListener('paste', (ev) => {
      const images = Array.from((ev.clipboardData && ev.clipboardData.items) || [])
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => /** @type {File} */ (item.getAsFile()))
        .filter(Boolean);
      if (!images.length) return;
      ev.preventDefault();
      for (const file of images) {
        const reader = new FileReader();
        reader.onload = () => send('pasteImage', { mime: file.type, data: String(reader.result).replace(/^data:[^,]*,/, '') });
        reader.readAsDataURL(file);
      }
    });
    prompt.addEventListener('keydown', onKey);
    prompt.addEventListener('keyup', (ev) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(ev.key)) caretMoved();
    });
    prompt.addEventListener('click', () => trigger() && onInput(false, true));
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit(ev.altKey || later);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        setWhere('main');
        prompt.focus();
      }
    });
    $('plus').append(icon(ICONS.plus));
    $('slash').append(icon(ICONS.slash));
    // A footer control's click closes its own menu, else opens it in place of whatever popup is open (the `/` list too).
    const toggle = (btn, open) => () => {
      const mine = popup.isOpenAt(btn);
      popup.close();
      if (!mine) open();
    };
    $('plus').addEventListener('click', toggle($('plus'), plusMenu));
    $('slash').addEventListener('click', () => insertTrigger('/'));
    whereBtn.addEventListener('click', toggle(whereBtn, whereMenu));
    modelBtn.addEventListener('click', toggle(modelBtn, modelMenu));
    modeBtn.addEventListener('click', toggle(modeBtn, modeMenu));
    sendBtn.addEventListener('click', () => submit(later));
    laterBtn.addEventListener('click', () => {
      if (!later) return submit(true);
      later = false;
      paint();
      prompt.focus();
    });
    $('cancel-edit').addEventListener('click', reset);

    return {
      update,
      composed,
      completions,
      insert,
      notice,
      chooseRemembered,
      openPicker,
      clearBox,
      restore,
      hints,
      /** Focuses the box as it is (from the cards). */
      refocus: () => prompt.focus(),
      /**
       * Focuses the box: `later` saves on Enter, `text` and `choice` load a prompt for later to edit.
       * @param {{ text?: string, later?: boolean, choice?: any, editing?: string }} [_]
       */
      focus({ text, later: asLater, choice, editing: id } = {}) {
        // A prompt for later taking the box keeps what was typed there, for when its edit ends.
        if (id && draftBeforeEdit === undefined) draftBeforeEdit = prompt.value;
        if (text !== undefined) prompt.value = text;
        // Editing a prompt for later saves it again on Enter (the Later button switches to starting it now).
        later = !!asLater || !!id;
        editing = id;
        if (choice) {
          // Its choices apply while editing only: the remembered ones come back afterwards.
          beforeEdit ??= { mode: state.mode, model: state.model, effort: state.effort, ultracode: state.ultracode };
          if (choice.mode) state.mode = choice.mode;
          if (choice.model) state.model = choice.model;
          if (choice.effort) state.effort = choice.effort;
          state.ultracode = !!choice.ultracode;
          where = choice.where === 'new' ? 'new' : choice.where || 'main';
          nameInput.value = choice.worktreeName || '';
        }
        paint();
        prompt.focus();
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      },
    };
  })();

  filterEl.addEventListener('change', () => {
    state.filter = filterEl.value;
    keep({ filter: state.filter });
    render();
  });
  $('settings').append(icon(ICONS.gear));
  $('settings').addEventListener('click', () => send('settings'));
  /** The ☰ button shows whether the cards' one line is on (devdesk.board.cardLine). */
  function showCardLineButton(on) {
    const b = $('cardline');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Hide the line on Working and Needs you cards' : 'Show what Claude is doing or asks on Working and Needs you cards';
    b.replaceChildren(icon(on ? ICONS.cardline : ICONS.cardlineOff));
  }
  showCardLineButton(true);
  $('cardline').addEventListener('click', () => send('toggleCardLine'));

  /**
   * The 📊 popover: tokens used today, this week and in the last 30 days, as total and cached (with its share), by
   * sessions and by DevDesk's Haiku insights; More… opens the Claude Usage page. Its selects choose the project (or
   * All projects) and the worktree, and today's breakdown by project (or by worktree) narrows the scope on a click.
   */
  const stats = (() => {
    const btn = $('stats');
    const pop = $('stats-pop');
    const TITLE = 'Token usage';
    const row = (label, t, extra) => {
      const r = el('div', 'stats-row');
      r.append(el('span', 'stats-label', label), el('span', 'stats-num', t.totalText), el('span', 'stats-num cached', t.cachedText));
      if (extra) r.append(el('span', 'stats-extra', extra));
      return r;
    };
    const head = () => {
      const r = el('div', 'stats-row stats-head');
      r.append(el('span', 'stats-label', ''), el('span', 'stats-num', 'total'), el('span', 'stats-num cached', 'cached'));
      return r;
    };
    const section = (title) => el('div', 'stats-section', title);
    /** A select of the scope (`selects` is one of the popover's, from `scopeSelects` in src/core/usageScope.ts). */
    function scopeSelect(label, selects) {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', label);
      for (const o of selects.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        if (o.title) opt.title = o.title;
        sel.append(opt);
      }
      sel.value = selects.value;
      sel.addEventListener('change', () => {
        const o = selects.options[sel.selectedIndex];
        if (o) send('usageScope', { scope: o.scope });
      });
      return sel;
    }
    /** The scope's selects: project (this window's first, All projects, the others), then its worktrees. */
    function scopeLine(u) {
      const line = el('div', 'stats-scope');
      line.append(scopeSelect('Project', u.selects.project));
      if (u.selects.worktree) line.append(scopeSelect('Worktree', u.selects.worktree));
      return line;
    }
    /**
     * A breakdown row. Where it narrows (`narrow`, see `narrowScope` in src/core/usageScope.ts), clicking it narrows
     * the scope to its project, or its worktree.
     */
    function placeRow(p) {
      const r = row(p.label, p, `${p.share}%`);
      r.title = p.title;
      if (!p.narrow) return r;
      r.classList.add('stats-place');
      r.tabIndex = 0;
      r.setAttribute('role', 'button');
      // The name a screen reader reads replaces the row's text: it carries the numbers too.
      r.setAttribute('aria-label', `Show ${p.label}: ${p.totalText} total, ${p.cachedText} cached, ${p.share}%`);
      const go = () => send('usageScope', { scope: p.narrow });
      r.addEventListener('click', go);
      r.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        go();
      });
      return r;
    }
    const more = () => {
      const b = button('link stats-more', 'More…', () => {
        close();
        send('usageMore');
      });
      b.title = 'Open Claude Usage: tokens by day, week and month, with charts';
      return b;
    };
    function close() {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggle() {
      if (!pop.hidden) return close();
      pop.replaceChildren(el('div', 'stats-title', TITLE), el('div', 'stats-empty stats-counting', 'Counting…'));
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      send('usage');
    }
    /** How far the count has got, while the popup waits for it (shows "Counting…", not the numbers). */
    function progress(p) {
      const waiting = pop.querySelector('.stats-counting');
      if (pop.hidden || !waiting || !p) return;
      // What the count is doing, as `Reading 12 of 340 transcripts…`.
      const parts = [el('div', 'stats-counting-head', countHead(p, 'transcripts'))];
      if (p.phase === 'reading' && p.totalFiles) {
        const bar = el('progress', 'stats-progress');
        bar.max = Math.max(1, p.totalBytes || p.totalFiles);
        bar.value = p.totalBytes ? p.bytes : p.files;
        bar.setAttribute('aria-label', 'Counting progress');
        parts.push(bar);
      }
      const left = timeLeftText(p.etaMs, false);
      if (left) parts.push(el('div', 'stats-note', left));
      parts.push(el('div', 'stats-note', 'It keeps counting when you close this, and what is counted is saved.'));
      waiting.replaceChildren(...parts);
    }
    function show(u) {
      if (pop.hidden || !u) return;
      const calls = (d) => `${d.requests} calls${d.failed ? `, ${d.failed} failed` : ''}`;
      const all = u.scope.kind === 'all';
      const parts = [el('div', 'stats-title', TITLE), scopeLine(u), head(), section(all ? 'Claude sessions' : 'Claude sessions here')];
      for (const p of u.periods) parts.push(row(p.label, p.sessions, `${p.sessions.requests} requests`));
      const places = (u.today.places || []).slice(0, 5);
      if (places.length > (all ? 0 : 1)) {
        parts.push(section(all ? 'Today by project' : 'Today by worktree'));
        for (const p of places) parts.push(placeRow(p));
      }
      if (u.today.models.length) {
        parts.push(section('Today by model'));
        for (const m of u.today.models) parts.push(row(m.model, m));
      }
      if (u.today.top.length) {
        parts.push(section('Top sessions today'));
        for (const t of u.today.top) parts.push(row(t.name, t));
      }
      // A project's usage never includes DevDesk's own calls.
      if (all) {
        parts.push(section('DevDesk insights (Haiku)'));
        for (const p of u.periods.slice(0, 2)) parts.push(row(p.label, p.devdesk, calls(p.devdesk)));
      }
      parts.push(el('div', 'stats-note', 'Total counts input, cache writes, cache reads and output. Cached is the part read from the prompt cache, which is cheaper and is not new work; the % is its share of the total.'));
      parts.push(more());
      // Rebuilding drops the select or breakdown row being used: give focus back to the select with the same label,
      // or, when that element is gone (a row, or the Worktree select of a project with one worktree), to the Project select.
      const active = /** @type {HTMLElement} */ (document.activeElement);
      const hadFocus = pop.contains(active) && (active.tagName === 'SELECT' || active.classList.contains('stats-place'));
      const label = hadFocus && active.tagName === 'SELECT' ? active.getAttribute('aria-label') : undefined;
      pop.replaceChildren(...parts);
      if (hadFocus) (/** @type {HTMLElement | null} */ ((label && pop.querySelector(`select[aria-label="${label}"]`)) || pop.querySelector('select[aria-label="Project"]')))?.focus();
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggle();
    });
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    document.addEventListener('click', () => !pop.hidden && close());
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !pop.hidden && ev.target !== $('search')) {
        close();
        btn.focus();
      }
    });
    return { show, progress };
  })();

  // ---- Search box: filters the lanes as you type; Enter asks the extension's model search (Task 6) -------------

  const search = (function () {
    const input = /** @type {HTMLInputElement} */ ($('search'));
    const askBtn = $('ask');
    const banner = $('search-banner');
    let terms = parseQuery(state.query);
    /** The ✨ answer shown: matched id → reason; undefined while the as-you-type filter applies. */
    let found;
    let note = '';
    let error = '';
    /** The query of the ✨ search running, if any. */
    let pending;
    /** The history search: the query's sequence number (answers to older ones are dropped), the debounce, the last answer. */
    let seq = 0;
    let historyTimer;
    /**
     * `phase`: `asked` while a query is scheduled or sent and not answered yet. `onBoard`: the board's sessions whose
     * transcript has the query's words, card id → the excerpt (or null).
     */
    /** @type {{ phase: string, results: any[], onBoard: Map<string, any>, indexing?: { indexed: number, total: number } }} */
    let history = { phase: 'none', results: [], onBoard: new Map(), indexing: undefined };
    /** History search is turned off (known across a clear, so the lane does not flash back on). */
    let historyOff = false;
    /** The ✨ answer's past sessions: id → hit (with its reason). */
    let historyFound;
    /** Whether the extension holds a history query (it answers it again as the index changes). */
    let historyAsked = false;
    input.value = state.query;

    function paint(shownCount, historyCount = 0, indexing = false) {
      askBtn.classList.toggle('busy', !!pending);
      askBtn.setAttribute('aria-busy', String(!!pending));
      banner.replaceChildren();
      if (pending) banner.append(el('span', '', '✨ Searching…'));
      else if (error) banner.append(el('span', 'error', `✨ search failed: ${error}`));
      else if (found) {
        banner.append(el('span', '', historyCount > 0 ? `✨ ${shownCount} on the board · ${historyCount} in history` : `✨ ${shownCount} session${shownCount === 1 ? '' : 's'}`));
        if (note) banner.append(el('span', '', ` · ${note}`));
      } else if (terms.length && shownCount === 0 && historyCount === 0 && !indexing) banner.append(el('span', '', 'No sessions match. ⏎ to ask ✨'));
      if (found || error) {
        const clearBtn = el('button', 'link', 'Clear');
        clearBtn.addEventListener('click', clear);
        banner.append(' · ', clearBtn);
      }
      banner.hidden = !banner.childNodes.length;
    }
    function stop() {
      if (pending) send('cancelSearch');
      pending = undefined;
    }
    /** A new query (or none): older history answers no longer count, and the pending request is dropped. */
    function resetHistory(all) {
      clearTimeout(historyTimer);
      historyTimer = undefined;
      seq++;
      historyFound = undefined;
      history = all ? { phase: 'none', results: [], onBoard: new Map(), indexing: undefined } : { ...history, phase: history.phase === 'asked' ? 'none' : history.phase };
    }
    /** Asks the extension for the box's history matches 120 ms after the last call. */
    function scheduleHistory() {
      const query = input.value.trim();
      // Nothing to match (empty, or only `wt:`): no lane either.
      if (!parseQuery(query).length) return;
      const mine = seq;
      history = { ...history, phase: 'asked' };
      historyTimer = setTimeout(() => {
        historyTimer = undefined;
        historyAsked = true;
        send('historyQuery', { query, seq: mine });
      }, 120);
    }
    /** The box was cleared: the extension stops answering its last history query. */
    function forgetHistory() {
      if (!historyAsked) return;
      historyAsked = false;
      send('historyQuery', { query: '', seq });
    }
    function clear() {
      forgetHistory();
      stop();
      resetHistory(true);
      found = undefined;
      note = error = '';
      input.value = '';
      state.query = '';
      terms = [];
      keep({ query: '' });
      render();
    }
    function ask() {
      const query = input.value.trim().slice(0, 500).trim();
      if (!query) return input.focus();
      pending = query;
      error = '';
      send('search', { query });
      render();
    }
    function result(m) {
      if (m.query !== pending) return; // an older search's answer
      pending = undefined;
      if (m.error) {
        // The as-you-type filter applies again, not an earlier answer.
        found = undefined;
        historyFound = undefined;
        note = '';
        error = String(m.error);
      } else {
        found = new Map((m.matches || []).map((x) => [x.id, x.reason || '']));
        note = m.note || '';
        historyFound = new Map((m.historyMatches || []).map((h) => [h.id, h]));
      }
      render();
    }
    function historyResult(m) {
      if (m.seq !== seq) return;
      const onBoard = new Map((m.onBoard || []).filter((h) => h && typeof h.id === 'string').map((h) => [h.id, h.excerpt || null]));
      history = { phase: 'answered', results: m.results || [], onBoard, indexing: m.indexing };
      historyOff = !!m.off;
      render();
    }
    input.addEventListener('input', () => {
      if (!input.value.trim()) forgetHistory();
      stop();
      resetHistory(!input.value.trim());
      scheduleHistory();
      found = undefined;
      note = error = '';
      state.query = input.value;
      terms = parseQuery(input.value);
      keep({ query: state.query });
      render();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && plain(ev)) {
        ev.preventDefault();
        ask();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (input.value || found || pending || error) clear();
        else composer.refocus();
      }
    });
    askBtn.addEventListener('click', ask);
    document.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'f') {
        ev.preventDefault();
        input.focus();
        input.select();
      }
    });
    /** The typed query's `wt:` and `is:` words: a session found in its transcript must still match them on its card. */
    const facets = () => terms.filter((t) => t.field !== 'all');
    /** Whether the typed query shows session `s`: its card's texts match, or its transcript has the words (and the card the facets). */
    function matches(s) {
      if (matchesQuery(s.search, terms)) return true;
      return history.onBoard.has(s.id) && matchesQuery(s.search, facets());
    }
    return {
      terms: () => terms,
      found: () => found,
      matches,
      /** For a card the typed query shows only by its transcript: the excerpt of its match; else undefined. */
      textHit(s) {
        if (found || !terms.length || historyOff || matchesQuery(s.search, terms)) return undefined;
        return history.onBoard.get(s.id) || undefined;
      },
      paint,
      result,
      historyResult,
      /** The past sessions to show: the ✨ answer's when there is one, else the typed query's. */
      history: () => (historyFound ? { phase: 'answered', results: [...historyFound.values()], indexing: undefined } : history),
      /** A past session shown in the lane, by id. */
      historyById(id) {
        return this.history().results.find((h) => h.id === id);
      },
      start: () => scheduleHistory(),
      historyOn: () => terms.length > 0 && !historyOff,
      /** A ✨ past session was resumed: it leaves the lane, and its board card (once listed) is a match with the reason. */
      resumed(id) {
        const h = historyFound && historyFound.get(id);
        if (!h) return;
        historyFound.delete(id);
        if (found) found.set(id, h.reason || '');
        render();
      },
      focus: () => input.focus(),
      /** The search this project folder kept (`restore`): the lanes filter by it again. */
      restore(query) {
        if (input.value || query === state.query) return;
        input.value = state.query = query;
        terms = parseQuery(query);
        if (terms.length) scheduleHistory();
        render();
      },
    };
  })();

  /**
   * What each message from the extension does (`src/board/messages.ts` has their shapes). A new message type is one
   * more entry here.
   */
  /** @type {{ [K in PanelMessage['type']]: (m: Extract<PanelMessage, { type: K }>) => void }} */
  const HOST_MESSAGES = {
    searchResult: (m) => search.result(m),
    historyResults: (m) => search.historyResult(m),
    board: (m) => {
      // The extension posts only when the board or the composer's choices changed.
      const start = performance.now();
      composer.update(m.composer);
      last = m;
      showCardLineButton(m.cardLine !== false);
      rebuiltCards = 0;
      render();
      // For the log: the script's own time and the cards it built, then the time until the next frame is painted.
      const script = Math.round((performance.now() - start) * 10) / 10;
      const rebuilt = rebuiltCards;
      requestAnimationFrame(() => setTimeout(() => send('rendered', {
        ms: Math.round(performance.now() - start),
        script,
        rebuilt,
        cards: lanesEl.querySelectorAll('.card').length,
        postedAt: m.postedAt,
      })));
    },
    restore: (m) => {
      const filter = m.filter !== undefined ? m.filter : typeof legacy.filter === 'string' ? legacy.filter : '';
      const query = m.query !== undefined ? m.query : typeof legacy.query === 'string' ? legacy.query : '';
      if (m.filter === undefined && filter) keep({ filter });
      if (m.query === undefined && query) keep({ query });
      state.filter = filter;
      composer.restore(m);
      search.restore(query);
      // Taken: versions before's webview state is not needed any more.
      if (Object.keys(legacy).length) vscode.setState({});
      for (const k of Object.keys(legacy)) delete legacy[k];
      render();
    },
    focus: (m) => composer.focus(m),
    enter: () => nav.enter(),
    composed: (m) => composer.composed(m.ok, m.error, m.keep, m.started),
    completions: (m) => composer.completions(m),
    insert: (m) => composer.insert(m.text),
    notice: (m) => composer.notice(m),
    setChoice: (m) => {
      const patch = {};
      for (const k of ['model', 'effort', 'ultracode', 'mode']) if (m[k] !== undefined) patch[k] = m[k];
      composer.chooseRemembered(patch);
    },
    openPicker: (m) => composer.openPicker(m.picker),
    clearBox: (m) => composer.clearBox(m.started),
    usage: (m) => stats.show(m.usage),
    usageProgress: (m) => stats.progress(m.progress),
  };
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    const handle = m && Object.prototype.hasOwnProperty.call(HOST_MESSAGES, m.type) && HOST_MESSAGES[m.type];
    if (handle) handle(m);
  });
  send('ready');
  search.start();
  // The board's width (CSS px): with the editor area to itself, the extension decides from it whether a session opens
  // beside the board.
  let sizeTimer;
  const sendSize = () => send('size', { width: window.innerWidth });
  sendSize();
  window.addEventListener('resize', () => {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(sendSize, 150);
  });
})();
