// @ts-check
/* The Claude Usage page: tokens by day, week or month (a stacked column chart of new and cached tokens, and the
 * cached share), with the selected period's models, sessions, projects (or worktrees) and DevDesk insight calls, for
 * the window's scope: one project (and worktree) or all projects, chosen in the header. Data comes from the host
 * (`usagePanel.ts`), already summed and formatted. */
import { countHead, durationText, timeLeftText } from '../src/core/usageProgress';

(function () {
  const vscode = acquireVsCodeApi();
  const SVG = 'http://www.w3.org/2000/svg';
  const main = /** @type {HTMLElement} */ (document.getElementById('main'));
  /** @type {{ unit: 'day' | 'week' | 'month', selected?: string, everyOpen?: boolean, everySort?: { col: number, dir: 1 | -1, for: string } }} */
  const state = Object.assign({ unit: 'day' }, vscode.getState() || {});
  /** @type {any} The page last posted (`ScopedPage` in src/core/usageScope.ts). */
  let page;
  /** Claude's plan limits (`planLimits.ts`): `view` (the 5-hour and weekly rows), `setup` (offer the status line), or neither. */
  /** @type {import('../src/board/messages').PlanLimits | undefined} */
  let limits;
  /** How far the count in progress has got (undefined when none runs), and when that arrived (this clock). */
  /** @type {any} */
  let counting;
  let countingAt = 0;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svg = (tag, attrs) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    return e;
  };
  const save = () => vscode.setState(state);
  const projectSel = /** @type {HTMLSelectElement} */ (document.getElementById('scope-project'));
  const worktreeSel = /** @type {HTMLSelectElement} */ (document.getElementById('scope-worktree'));
  /** The status line above the page while a count runs (more than a second). */
  const status = el('section', 'status');
  status.setAttribute('role', 'status');

  /**
   * Claude's plan limits, for the whole account (so whatever project is chosen): % of the 5-hour and weekly limits used,
   * with a bar and when each resets; while DevDesk's status line that records them is not installed, the offer to
   * install it; nothing without numbers otherwise.
   */
  function limitsBlock() {
    if (limits && limits.view) {
      const block = el('section', 'block limits');
      block.append(el('h2', '', `Plan limits${limits.view.asOf ? ` (${limits.view.asOf})` : ''}`));
      for (const r of limits.view.rows) {
        const line = el('div', 'limit');
        const bar = /** @type {HTMLMeterElement} */ (el('meter', 'limit-bar'));
        bar.min = 0;
        bar.max = 100;
        bar.low = 70;
        bar.high = 90;
        bar.optimum = 0;
        bar.value = r.percent;
        bar.setAttribute('aria-label', `${r.label} limit used`);
        line.append(el('span', 'limit-label', r.label), bar, el('span', 'num', r.percentText), el('span', 'muted', r.resetsText));
        if (r.resetsAt) line.title = `Resets ${new Date(r.resetsAt).toLocaleString()}`;
        block.append(line);
      }
      return block;
    }
    if (limits && limits.setup) {
      const line = el('p', 'muted limits-setup', "Claude's 5-hour and weekly limits: ");
      const b = el('button', 'link', 'Show…');
      b.title = "Install DevDesk's Claude status line, which records them (Claude.ai Pro and Max)";
      b.addEventListener('click', () => vscode.postMessage({ type: 'setupLimits' }));
      line.append(b);
      return line;
    }
    return undefined;
  }

  /** `950`, `12k`, `4.5M`, for axis ticks. */
  function compact(n) {
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return `${+(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
    if (n < 1e9) return `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
    return `${+(n / 1e9).toFixed(1)}B`;
  }
  /** A clean step for about `count` ticks up to `max`. */
  function niceStep(max, count) {
    const raw = max / count;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  }
  /** A column segment with a rounded top end (4px) and a square base. */
  function columnPath(x, y, w, h, rounded) {
    const r = rounded ? Math.min(4, w / 2, h) : 0;
    return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
  }

  const tip = el('div', 'tip');
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  function showTip(ev, lines) {
    tip.replaceChildren(...lines.map(([cls, text]) => el('div', cls, text)));
    tip.hidden = false;
    const pad = 12;
    const { innerWidth: W, innerHeight: H } = window;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + r.width > W - 4) x = ev.clientX - r.width - pad;
    if (y + r.height > H - 4) y = ev.clientY - r.height - pad;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }
  const hideTip = () => (tip.hidden = true);

  const tipLines = (p) => [
    ['tip-title', p.label],
    ['', `Total ${p.sessions.totalText}`],
    ['', `Cached ${p.sessions.cachedText}`],
    ['muted', `${p.sessions.requests} requests`],
  ];

  /** The columns: new tokens at the base, cached above, one per period; click selects. */
  function columnChart(periods, width) {
    const H = 220;
    const M = { top: 12, right: 8, bottom: 26, left: 48 };
    const w = Math.max(200, width) - M.left - M.right;
    const h = H - M.top - M.bottom;
    const max = Math.max(1, ...periods.map((p) => p.sessions.total));
    const step = niceStep(max, 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => M.top + h - (v / top) * h;
    const root = svg('svg', { width: w + M.left + M.right, height: H, class: 'chart', role: 'img', 'aria-label': 'Tokens per period: new and cached' });
    for (let v = 0; v <= top + 1e-9; v += step) {
      root.append(svg('line', { x1: M.left, x2: M.left + w, y1: y(v), y2: y(v), class: v ? 'grid' : 'axis' }));
      const t = svg('text', { x: M.left - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' });
      t.textContent = compact(v);
      root.append(t);
    }
    const band = w / periods.length;
    const bw = Math.max(2, Math.min(24, band * 0.7));
    const every = Math.ceil(periods.length / Math.max(1, Math.floor(w / 44)));
    periods.forEach((p, i) => {
      const cx = M.left + band * i + band / 2;
      const x = cx - bw / 2;
      const total = p.sessions.total;
      const cached = p.sessions.cached;
      const fresh = total - cached;
      const g = svg('g', { class: `col${p.key === state.selected ? ' selected' : ''}` });
      const hNew = (fresh / top) * h;
      const hCached = (cached / top) * h;
      const GAP = 2;
      if (fresh > 0) g.append(svg('path', { d: columnPath(x, y(0) - hNew, bw, hNew, cached <= 0), class: 'seg new' }));
      if (cached > 0) {
        const hc = Math.max(0, hCached - (fresh > 0 ? GAP : 0));
        g.append(svg('path', { d: columnPath(x, y(0) - hNew - hCached, bw, hc, true), class: 'seg cached' }));
      }
      // The hit target: the whole band, taller than the column.
      const hit = svg('rect', { x: M.left + band * i, y: M.top, width: band, height: h, class: 'hit', tabindex: 0, role: 'button', 'aria-label': `${p.label}: total ${p.sessions.totalText}, cached ${p.sessions.cachedText}` });
      hit.addEventListener('mousemove', (ev) => showTip(ev, tipLines(p)));
      hit.addEventListener('mouseleave', hideTip);
      const select = () => {
        state.selected = p.key;
        save();
        render();
      };
      hit.addEventListener('click', select);
      hit.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), select()));
      g.append(hit);
      if (i % every === 0 || i === periods.length - 1) {
        const t = svg('text', { x: cx, y: H - 8, class: `tick${p.key === state.selected ? ' strong' : ''}`, 'text-anchor': 'middle' });
        t.textContent = p.short;
        g.append(t);
      }
      root.append(g);
    });
    return root;
  }

  /** The cached share per period, 0–100%: one line. */
  function shareChart(periods, width) {
    const H = 120;
    const M = { top: 10, right: 8, bottom: 20, left: 48 };
    const w = Math.max(200, width) - M.left - M.right;
    const h = H - M.top - M.bottom;
    const y = (v) => M.top + h - (v / 100) * h;
    const band = w / periods.length;
    const x = (i) => M.left + band * i + band / 2;
    const root = svg('svg', { width: w + M.left + M.right, height: H, class: 'chart', role: 'img', 'aria-label': 'Cached share of the total, per period' });
    for (const v of [0, 50, 100]) {
      root.append(svg('line', { x1: M.left, x2: M.left + w, y1: y(v), y2: y(v), class: v ? 'grid' : 'axis' }));
      const t = svg('text', { x: M.left - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' });
      t.textContent = `${v}%`;
      root.append(t);
    }
    const pts = periods.map((p, i) => (p.sessions.total ? [x(i), y((100 * p.sessions.cached) / p.sessions.total), p] : undefined));
    // Periods without usage break the line.
    let d = '';
    let drawing = false;
    for (const pt of pts) {
      if (!pt) {
        drawing = false;
        continue;
      }
      d += `${drawing ? 'L' : 'M'}${pt[0]},${pt[1]}`;
      drawing = true;
    }
    if (d) root.append(svg('path', { d, class: 'share-line' }));
    pts.forEach((pt, i) => {
      if (!pt) return;
      const p = pt[2];
      const isSel = p.key === state.selected;
      if (isSel || i === pts.length - 1 || pts.filter(Boolean).length <= 12) root.append(svg('circle', { cx: pt[0], cy: pt[1], r: 4, class: `dot${isSel ? ' selected' : ''}` }));
      const hit = svg('rect', { x: M.left + band * i, y: M.top, width: band, height: h, class: 'hit' });
      const pct = Math.round((100 * p.sessions.cached) / p.sessions.total);
      hit.addEventListener('mousemove', (ev) => showTip(ev, [['tip-title', p.label], ['', `${pct}% cached`], ['muted', `${p.sessions.cachedText} of ${p.sessions.totalText}`]]));
      hit.addEventListener('mouseleave', hideTip);
      hit.addEventListener('click', () => {
        state.selected = p.key;
        save();
        render();
      });
      root.append(hit);
    });
    return root;
  }

  function legend() {
    const l = el('div', 'legend');
    for (const [cls, label] of [['new', 'New (input, cache writes, output)'], ['cached', 'Cached (cache reads)']]) {
      const item = el('span', 'legend-item');
      item.append(el('span', `swatch ${cls}`), el('span', '', label));
      l.append(item);
    }
    return l;
  }

  function tile(label, value, sub) {
    const t = el('div', 'tile');
    t.append(el('div', 'tile-label', label), el('div', 'tile-value', value));
    if (sub) t.append(el('div', 'tile-sub', sub));
    return t;
  }

  /**
   * A table. A cell is its text, or `[text, raw, title]` where `raw` is what it sorts by (a number, or text; `null`
   * sorts last both ways) and `title` its tooltip. `opts.titles` are the first column's tooltips (else its text);
   * `opts.textCols` are the columns aligned as text (else only the first); `opts.nameCol` is the text column that takes
   * the spare width and is cut with an ellipsis (else the first; the other text columns don't wrap); `opts.sort` makes the head clickable,
   * sorting the rows (`get`/`set` keep the order across renders, `ascFirst` lists the columns whose first click sorts
   * smallest first, where numbers otherwise sort largest first).
   */
  function table(caption, head, rows, opts = {}) {
    const wrap = el('section', 'block');
    if (caption) wrap.append(el('h2', '', caption));
    if (!rows.length) {
      wrap.append(el('p', 'muted', 'None.'));
      return wrap;
    }
    const textCols = opts.textCols || [0];
    const isText = (i) => textCols.includes(i);
    const nameCol = opts.nameCol ?? 0;
    const text = (c) => (Array.isArray(c) ? c[0] : c);
    const raw = (c) => (Array.isArray(c) ? c[1] : c);
    const t = el('table');
    const tr = el('tr');
    const ths = head.map((hText, i) => {
      const th = el('th', isText(i) ? '' : 'num', hText);
      tr.append(th);
      return th;
    });
    t.append(el('thead'));
    t.firstChild.append(tr);
    const body = el('tbody');
    const order = rows.map((r, i) => ({ r, i, title: opts.titles && opts.titles[i] }));
    const fill = () => {
      const s = opts.sort && opts.sort.get();
      const sorted = [...order];
      if (s) {
        sorted.sort((a, b) => {
          const x = raw(a.r[s.col]);
          const y = raw(b.r[s.col]);
          if (x === null || y === null) return Number(x === null) - Number(y === null) || a.i - b.i;
          const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return c * s.dir || a.i - b.i;
        });
      }
      ths.forEach((th, i) => (s && s.col === i ? th.setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending') : th.removeAttribute('aria-sort')));
      body.replaceChildren(
        ...sorted.map(({ r, title }) => {
          const row = el('tr');
          r.forEach((c, i) => {
            const td = el('td', isText(i) ? (i === nameCol ? 'name' : 'text') : 'num', text(c));
            if (!i) td.title = title || text(c);
            else if (Array.isArray(c) && c[2]) td.title = c[2];
            row.append(td);
          });
          return row;
        }),
      );
    };
    if (opts.sort) {
      const sort = opts.sort;
      ths.forEach((th, i) => {
        th.classList.add('sortable');
        th.tabIndex = 0;
        th.title = 'Sort by this column';
        const go = () => {
          const s = sort.get();
          // Numbers sort largest first, text A to Z; a second click turns the order around.
          const first = (sort.ascFirst || []).includes(i) || typeof raw(rows[0][i]) !== 'number' ? 1 : -1;
          sort.set({ col: i, dir: s && s.col === i ? /** @type {1 | -1} */ (-s.dir) : first });
          fill();
        };
        th.addEventListener('click', go);
        th.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), go()));
      });
    }
    fill();
    t.append(body);
    wrap.append(t);
    return wrap;
  }

  /** The options of a scope select (`page.selects`, from `scopeSelects` in src/core/usageScope.ts). */
  const options = (sel) =>
    sel.options.map((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.text;
      if (o.title) opt.title = o.title;
      return opt;
    });
  /** The scope the option chosen in `select` picks (`selects` is the page's `project` or `worktree` one). */
  const chosenScope = (select, selects) => selects && selects.options[select.selectedIndex] && selects.options[select.selectedIndex].scope;
  /** Fills the header's selects from the page: the project, and the chosen project's worktree when there is one to choose. */
  let scopeKey = '';
  function fillScope() {
    const selects = page.selects;
    // Hidden in the markup until the first page, so a first count does not show an empty select.
    projectSel.hidden = false;
    // Rebuilt only when what they show changes, so a partial page during a count doesn't close an open list.
    const key = JSON.stringify(selects);
    if (key === scopeKey) return;
    scopeKey = key;
    projectSel.replaceChildren(...options(selects.project));
    projectSel.value = selects.project.value;
    worktreeSel.hidden = !selects.worktree;
    if (!selects.worktree) return worktreeSel.replaceChildren();
    worktreeSel.replaceChildren(...options(selects.worktree));
    worktreeSel.value = selects.worktree.value;
  }

  const mb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  function render() {
    hideTip();
    if (!page) return showStatus();
    fillScope();
    for (const b of document.querySelectorAll('[data-unit]')) b.setAttribute('aria-checked', String(b.getAttribute('data-unit') === state.unit));
    const all = page.scope.kind === 'all';
    const periods = page.units[state.unit];
    if (!periods.some((p) => p.key === state.selected)) state.selected = periods[periods.length - 1]?.key;
    const sel = periods.find((p) => p.key === state.selected) || periods[periods.length - 1];
    const width = main.clientWidth - 2;

    const parts = [];
    if (updateStatus()) parts.push(status);
    const lp = limitsBlock();
    if (lp) parts.push(lp);
    const summary = el('section', 'block');
    summary.append(el('h2', '', sel.label));
    const tiles = el('div', 'tiles');
    tiles.append(
      tile('Total', sel.sessions.totalText, `${sel.sessions.requests} requests`),
      tile('Cached', sel.sessions.cachedText, 'read from the prompt cache'),
      tile('New', compact(sel.sessions.total - sel.sessions.cached), 'input, cache writes, output'),
    );
    // A project's usage never includes DevDesk's own calls.
    if (all) tiles.append(tile('DevDesk insights', sel.devdesk.totalText, `${sel.devdesk.requests} calls${sel.devdesk.failed ? `, ${sel.devdesk.failed} failed` : ''}`));
    summary.append(tiles);
    parts.push(summary);

    const chartBlock = el('section', 'block');
    chartBlock.append(el('h2', '', `Tokens per ${state.unit}`), legend(), columnChart(periods, width));
    chartBlock.append(el('h2', 'sub', 'Cached share'), shareChart(periods, width));
    parts.push(chartBlock);

    const grid = el('div', 'grid2');
    grid.append(
      table(`By model · ${sel.label}`, ['Model', 'Total', 'Cached', 'Requests'], sel.models.map((m) => [m.model, m.totalText, m.cachedText, String(m.requests)])),
      table(`Top sessions · ${sel.label}`, ['Session', 'Total', 'Cached', 'Requests'], sel.top.map((s) => [s.name, s.totalText, s.cachedText, String(s.requests)])),
    );
    parts.push(grid);

    // The selected period by project (All projects, DevDesk's calls a project of their own), or by worktree.
    const places = sel.places || [];
    parts.push(
      table(
        `${all ? 'Projects' : 'Worktrees'} · ${sel.label}`,
        [all ? 'Project' : 'Worktree', 'Total', 'Cached', 'Share'],
        places.map((p) => [p.label, p.totalText, p.cachedText, `${p.share}%`]),
        { titles: places.map((p) => p.title) },
      ),
    );

    const every = el('details', 'block');
    every.append(el('summary', '', `Every ${state.unit} as a table`));
    const unitTitle = state.unit[0].toUpperCase() + state.unit.slice(1);
    // The period column sorts by time (its index), oldest first on the first click (the table starts newest first).
    const at = (i) => periods.length - 1 - i;
    const num = (text, n) => [text, n];
    // One label per project across every period (the project select's), its path as the tooltip; a period without
    // usage has no project, which sorts after the others.
    const labelOf = new Map((page.choices || []).map((c) => [c.project, c.label]));
    const projectCell = (pl) => (pl.project === undefined ? ['—', null] : [labelOf.get(pl.project) ?? pl.label, labelOf.get(pl.project) ?? pl.label, pl.title]);
    const rows = all
      ? [...periods].reverse().flatMap((p, i) =>
          (p.places && p.places.length ? p.places : [{ label: '—', total: p.sessions.total, totalText: p.sessions.totalText, cached: p.sessions.cached, cachedText: p.sessions.cachedText, requests: p.sessions.requests }]).map((pl) => [
            num(p.label, at(i)),
            projectCell(pl),
            num(pl.totalText, pl.total),
            num(pl.cachedText, pl.cached),
            num(String(pl.requests), pl.requests),
          ]),
        )
      : [...periods].reverse().map((p, i) => [num(p.label, at(i)), num(p.sessions.totalText, p.sessions.total), num(p.sessions.cachedText, p.sessions.cached), num(String(p.sessions.requests), p.sessions.requests)]);
    const head = all ? [unitTitle, 'Project', 'Total', 'Cached', 'Requests'] : [unitTitle, 'Total', 'Cached', 'Requests'];
    // A sort is kept while the columns stay the same (same unit, same kind of scope).
    // Kept in the webview's state (`everySort`, undefined: newest first), so it survives the tab being hidden.
    const sortFor = `${state.unit}:${all}`;
    const getSort = () => (state.everySort && state.everySort.for === sortFor ? { col: state.everySort.col, dir: state.everySort.dir } : undefined);
    const setSort = (s) => {
      state.everySort = s ? { col: s.col, dir: s.dir, for: sortFor } : undefined;
      save();
    };
    every.append(table('', head, rows, { textCols: all ? [0, 1] : [0], nameCol: all ? 1 : 0, sort: { get: getSort, set: setSort, ascFirst: [0] } }));
    // Keep it open across renders once opened.
    if (state.everyOpen) every.open = true;
    every.addEventListener('toggle', () => {
      state.everyOpen = every.open;
      save();
    });
    parts.push(every);

    const h = page.history;
    const foot = el('p', 'muted foot');
    foot.textContent =
      `History: ${h.days} day${h.days === 1 ? '' : 's'} · ${mb(h.bytes)} of ${mb(h.maxBytes)} · kept ${h.keepDays} days` +
      (h.oldest ? ` · oldest ${h.oldest}` : '') +
      '. Total counts input, cache writes, cache reads and output; cached is the part read from the prompt cache. Today is counted live.';
    parts.push(foot);
    main.replaceChildren(...parts);
  }

  for (const b of document.querySelectorAll('[data-unit]')) {
    b.addEventListener('click', () => {
      state.unit = /** @type {any} */ (b.getAttribute('data-unit'));
      state.selected = undefined;
      save();
      render();
    });
  }
  // The window's scope is the host's: it posts the page again for the new one.
  for (const [select, which] of /** @type {const} */ ([[projectSel, 'project'], [worktreeSel, 'worktree']])) {
    select.addEventListener('change', () => {
      const scope = page && chosenScope(select, page.selects[which]);
      if (scope) vscode.postMessage({ type: 'setScope', scope });
    });
  }
  /** `Oct 21` */
  const shortDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  /**
   * Fills the status line from the count in progress; false when there is none to show (no count, or one under a
   * second, so a quick count doesn't flash it). The time goes on between messages (a big transcript takes a while).
   */
  function updateStatus() {
    const p = counting;
    if (!p) return false;
    const since = Date.now() - countingAt;
    const elapsed = p.elapsedMs + since;
    if (elapsed < 1000) return false;
    const bar = el('progress');
    bar.setAttribute('aria-label', 'Counting progress');
    const head = countHead(p, 'Claude transcripts', true);
    const notes = [];
    if (p.phase === 'listing' && p.listed && p.found) {
      bar.max = p.found;
      bar.value = p.listed;
    } else if (p.phase === 'reading') {
      bar.max = Math.max(1, p.totalBytes);
      bar.value = p.bytes;
    }
    const eta = p.etaMs === undefined ? undefined : Math.max(0, p.etaMs - since);
    const left = timeLeftText(eta, true, p.phase === 'reading' ? 'working out the time left' : '');
    notes.push([`${durationText(elapsed, true)} so far`, left].filter(Boolean).join(' · '));
    if (p.savedThrough) notes.push(`Days up to ${shortDay(p.savedThrough)} are counted and shown below. They are saved, so closing the page or the window keeps them.`);
    if (p.phase === 'reading' && p.totalBytes > 1024 * 1024 * 1024) notes.push('The first count reads every transcript; later ones read only what is new.');
    status.replaceChildren(el('p', '', head), bar, ...notes.map((t) => el('p', 'muted', t)));
    return true;
  }
  /** Shows the status line: alone until there is a page, else above it. */
  function showStatus() {
    const shown = updateStatus();
    if (!page) {
      if (shown) main.replaceChildren(status);
    } else if (!shown) status.remove();
    else if (status.parentElement !== main) main.prepend(status);
  }
  setInterval(() => counting && showStatus(), 1000);
  /** @type {HTMLElement} */ (document.getElementById('refresh')).addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  /** @type {HTMLElement} */ (document.getElementById('settings')).addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 100);
  });
  window.addEventListener('message', (ev) => {
    /** @type {import('../src/usage/messages').UsageHostMessage | undefined} */
    const m = ev.data;
    if (m?.type === 'page') {
      page = m.page;
      limits = m.limits;
      counting = undefined;
      render();
    } else if (m?.type === 'partial') {
      // The days counted so far, while the count goes on.
      page = m.page;
      counting = m.progress;
      countingAt = Date.now();
      render();
    } else if (m?.type === 'progress') {
      counting = m.progress;
      countingAt = Date.now();
      showStatus();
    } else if (m?.type === 'error') {
      counting = undefined;
      main.replaceChildren(el('p', 'error', `Cannot count token usage: ${m.message}`));
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
