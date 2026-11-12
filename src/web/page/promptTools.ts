// The prompt box's tools: the `/` menu under the text and the mode, model and effort pills, as the Claude Board's box
// has them. What the menu lists and what a pick does come from core/web/promptBox.ts; this file is only the DOM.
import type { CommandRow } from '../../core/commandMenu';
import { DEFAULT_CHOICE } from '../../core/composer';
import { type BoxChoice, slashMenu } from '../../core/web/promptBox';
import type { ComposerResponse, WebModel } from '../../core/web/types';
import { h } from './dom';

/** The browser remembers the pills here, so the next visit starts with them (when still offered). */
const KEPT_KEY = 'devdesk.web.choice';

const BADGE_TEXT: Record<string, string> = { board: 'box', session: 'running session', terminal: 'opens panel', unavailable: 'not here' };

export interface PromptTools {
  /** The `/` menu, right under the prompt. */
  menu: HTMLElement;
  /** The `/` button and the pills. */
  bar: HTMLElement;
  /** What the box offers now (undefined until the first answer). */
  info(): ComposerResponse | undefined;
  setInfo(info: ComposerResponse): void;
  choice(): BoxChoice;
  set(change: Partial<BoxChoice>): void;
  /** Whether a pill is off its default (the box then stays open). */
  custom(): boolean;
  /** The prompt's keydown: true when the menu used the key. */
  key(e: KeyboardEvent): boolean;
  /** The text or caret moved: open, filter or close the menu. */
  update(): void;
  close(): void;
}

/**
 * `prompt`'s tools. `run(text)` submits a command picked from the menu that runs at once (`/clear`, `/help`, a blocked
 * one, which only says why).
 */
export function promptTools(prompt: HTMLTextAreaElement, o: { run(): void; changed(): void }): PromptTools {
  let info: ComposerResponse | undefined;
  let rows: CommandRow[] = [];
  let start = 0;
  let active = 0;
  let open = false;
  const kept = readKept();
  const choice: BoxChoice = { mode: kept.mode ?? '', model: kept.model ?? DEFAULT_CHOICE, effort: kept.effort ?? DEFAULT_CHOICE };

  const menu = h('div', { class: 'slash-menu', attrs: { role: 'listbox', id: 'slash-menu', 'aria-label': 'Commands' } });
  menu.hidden = true;
  prompt.setAttribute('aria-controls', 'slash-menu');
  prompt.setAttribute('aria-autocomplete', 'list');

  const pill = (label: string, title: string) => {
    // The pill shows the chosen option's text; the native select lies over it, transparent, so the pill is as wide as
    // what it shows (a select is as wide as its longest option) and a tap still opens the phone's own picker.
    const select = h('select', { class: 'pill-pick', attrs: { 'aria-label': label } });
    const shown = h('span', { class: 'pill-text', attrs: { 'aria-hidden': 'true' } });
    const wrap = h('label', { class: 'pill', attrs: { title } }, shown, select);
    select.addEventListener('change', () => (shown.textContent = select.selectedOptions[0]?.textContent ?? ''));
    return { select, wrap, shown };
  };
  const mode = pill('Mode', 'Permission mode the session starts in');
  const model = pill('Model', 'Model the session starts with');
  const effort = pill('Effort', 'Effort level the session starts with');
  const slash = h('button', {
    class: 'pill slash-button',
    text: '/',
    attrs: { type: 'button', title: 'Skills and commands', 'aria-label': 'Skills and commands' },
    on: {
      // Keep the keyboard up on a phone: the prompt never loses focus.
      mousedown: (e) => e.preventDefault(),
      click: () => openSlash(),
    },
  });
  const bar = h('div', { class: 'composer-tools' }, slash, mode.wrap, model.wrap, effort.wrap);

  mode.select.addEventListener('change', () => set({ mode: mode.select.value }));
  model.select.addEventListener('change', () => set({ model: model.select.value }));
  effort.select.addEventListener('change', () => set({ effort: effort.select.value }));

  function openSlash(): void {
    const at = prompt.selectionStart ?? prompt.value.length;
    const before = prompt.value.slice(0, at);
    // `/` at the start, or after a space: where the menu opens.
    const add = before === '' || /\s$/.test(before) ? '/' : before.endsWith('/') ? '' : ' /';
    prompt.setRangeText(add, at, at, 'end');
    prompt.focus();
    update();
    o.changed();
  }

  const modelRow = (): WebModel | undefined => info?.models.find((m) => m.value === choice.model);

  function fill(select: HTMLSelectElement, options: { value: string; label: string; title?: string }[], value: string): void {
    select.replaceChildren(...options.map((x) => h('option', { text: x.label, attrs: { value: x.value, ...(x.title ? { title: x.title } : {}) } })));
    select.value = value;
    (select.previousElementSibling as HTMLElement).textContent = select.selectedOptions[0]?.textContent ?? '';
  }

  function render(): void {
    if (!info) return;
    // A pill says what it is only on Claude's default ("Default model"); a choice speaks for itself.
    fill(mode.select, info.modes.map((m) => ({ value: m.name, label: m.name === DEFAULT_CHOICE ? 'Default mode' : m.name, title: m.description })), choice.mode);
    const models = info.models.some((m) => m.value === choice.model) ? info.models : [...info.models, { value: choice.model, label: choice.model, description: '', efforts: [] }];
    fill(model.select, models.map((m) => ({ value: m.value, label: m.value === DEFAULT_CHOICE ? 'Default model' : m.label, title: m.description })), choice.model);
    const efforts = modelRow()?.efforts ?? [];
    fill(effort.select, [DEFAULT_CHOICE, ...efforts].map((e) => ({ value: e, label: e === DEFAULT_CHOICE ? 'Default effort' : `Effort ${e}` })), choice.effort);
    effort.wrap.hidden = efforts.length === 0;
    mode.wrap.hidden = info.modes.length < 2;
    mode.wrap.classList.toggle('changed', choice.mode !== info.defaultMode);
    model.wrap.classList.toggle('changed', choice.model !== DEFAULT_CHOICE);
    effort.wrap.classList.toggle('changed', choice.effort !== DEFAULT_CHOICE);
  }

  /** Keeps the choices to what `info` offers: an unknown mode is the default, a model it lacks stays only while the CLI is still listing. */
  function fit(): void {
    if (!info) return;
    if (!info.modes.some((m) => m.name === choice.mode)) choice.mode = info.defaultMode;
    if (!info.listing && !info.models.some((m) => m.value === choice.model)) choice.model = DEFAULT_CHOICE;
    const efforts = modelRow()?.efforts;
    if (efforts && choice.effort !== DEFAULT_CHOICE && !efforts.includes(choice.effort)) choice.effort = DEFAULT_CHOICE;
  }

  function set(change: Partial<BoxChoice>): void {
    Object.assign(choice, change);
    fit();
    render();
    keep(choice);
    o.changed();
  }

  function close(): void {
    open = false;
    menu.hidden = true;
    prompt.removeAttribute('aria-activedescendant');
    prompt.setAttribute('aria-expanded', 'false');
  }

  function update(): void {
    if (!info) return close();
    const at = prompt.selectionStart ?? prompt.value.length;
    if (prompt.selectionEnd !== at) return close();
    const found = slashMenu(prompt.value.slice(0, at), info.commands);
    if (!found || !found.rows.length) return close();
    const same = open && found.start === start && found.rows.length === rows.length && found.rows.every((r, i) => r.label === rows[i].label);
    rows = found.rows;
    start = found.start;
    if (!same) active = 0;
    open = true;
    menu.hidden = false;
    prompt.setAttribute('aria-expanded', 'true');
    menu.replaceChildren(
      ...rows.map((r, i) =>
        h(
          'div',
          {
            class: i === active ? 'slash-row active' : 'slash-row',
            attrs: { role: 'option', id: `slash-${i}`, 'aria-selected': String(i === active) },
            on: {
              mousedown: (e) => e.preventDefault(),
              click: () => pick(i),
            },
          },
          h('span', { class: 'slash-head' }, h('span', { class: 'slash-name', text: r.label }), r.hint ? h('span', { class: 'slash-hint', text: r.hint }) : null, r.badge ? h('span', { class: `slash-badge badge-${r.badge}`, text: BADGE_TEXT[r.badge] }) : null),
          r.description || r.detail ? h('span', { class: 'slash-desc', text: [r.description, r.detail].filter(Boolean).join(' · ') }) : null,
        ),
      ),
    );
    prompt.setAttribute('aria-activedescendant', `slash-${active}`);
    menu.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i: number): void {
    const r = rows[i];
    if (!r) return;
    const at = prompt.selectionStart ?? prompt.value.length;
    prompt.setRangeText(r.insert, start, at, 'end');
    close();
    prompt.focus();
    o.changed();
    // A command that needs nothing more and does not start a session runs at once (as on the board).
    if (r.run && r.category !== 'D' && start === 0) o.run();
    else update();
  }

  function move(by: number): void {
    active = (active + by + rows.length) % rows.length;
    for (const [i, el] of [...menu.children].entries()) {
      el.classList.toggle('active', i === active);
      el.setAttribute('aria-selected', String(i === active));
    }
    prompt.setAttribute('aria-activedescendant', `slash-${active}`);
    menu.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function key(e: KeyboardEvent): boolean {
    if (!open || e.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') move(e.key === 'ArrowDown' ? 1 : -1);
    else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') pick(active);
    else if (e.key === 'Escape') close();
    else return false;
    e.preventDefault();
    return true;
  }

  return {
    menu,
    bar,
    info: () => info,
    setInfo: (next) => {
      info = next;
      fit();
      render();
      if (open) update();
    },
    choice: () => ({ ...choice }),
    set,
    custom: () => !!info && (choice.mode !== info.defaultMode || choice.model !== DEFAULT_CHOICE || choice.effort !== DEFAULT_CHOICE),
    key,
    update,
    close,
  };
}

function readKept(): Partial<BoxChoice> {
  try {
    const v = JSON.parse(localStorage.getItem(KEPT_KEY) ?? '{}') as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === 'string' && x.length < 200 ? x : undefined);
    return { mode: s(v.mode), model: s(v.model), effort: s(v.effort) };
  } catch {
    return {};
  }
}

function keep(choice: BoxChoice): void {
  try {
    localStorage.setItem(KEPT_KEY, JSON.stringify(choice));
  } catch {
    // Private mode or storage off: the pills reset next visit.
  }
}
