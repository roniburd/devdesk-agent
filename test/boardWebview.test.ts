// The Claude Board webview (media/board.js) in jsdom: the page's own markup from src/board/html.ts, with the extension
// played by this test (it answers `complete` queries and records what the webview posts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { UNSTACKABLE } from '../src/core/commandMenu';
import { dayKey } from '../src/core/usageHistory';
import { scopedPopover } from '../src/core/usageScope';
import { projectFolder } from './boardProjectFolder';

const ROOT = join(__dirname, '..');

type Item = { label: string; insert: string; run?: boolean; category?: string };

/** `/` rows: every command whose name contains the query, in this order. */
const COMMANDS: Item[] = [
  { label: '/auto-mode-setup', insert: '/auto-mode-setup ' },
  { label: '/simplify', insert: '/simplify ' },
  { label: '/model', insert: '/model ', run: true, category: 'A' },
  { label: '/clear', insert: '/clear ', run: true, category: 'A' },
];

function boardHtml(): string {
  const src = readFileSync(join(ROOT, 'src/board/html.ts'), 'utf8');
  const body = /<body[^>]*>([\s\S]*?)<script/.exec(src)![1];
  return `<!DOCTYPE html><html><body>${body.replace(/\$\{[^}]*\}/g, '')}</body></html>`;
}

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

/**
 * `held`: the extension's `completions` answers wait until `release()` (an answer arriving late). `saved`: what the
 * project folder kept (as after a reload or the tab closed), or `folder`, one shared with another webview; `legacy`:
 * the webview's own state from a version before; `composer`: what the extension posts besides the defaults.
 */
async function board({
  held = false,
  saved = undefined as Record<string, unknown> | undefined,
  folder = projectFolder(saved),
  legacy = undefined as Record<string, unknown> | undefined,
  composer = {} as Record<string, unknown>,
} = {}) {
  const pending: Array<() => void> = [];
  dom = new JSDOM(boardHtml(), { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown; acquireVsCodeApi: unknown };
  const posted: Array<Record<string, unknown>> = [];
  /** The webview's own state (only versions before kept anything in it). */
  let webviewState: Record<string, unknown> | undefined = legacy;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.acquireVsCodeApi = () => ({
    getState: () => webviewState,
    setState: (s: Record<string, unknown>) => {
      webviewState = s;
    },
    postMessage: (m: Record<string, unknown>) => {
      posted.push(m);
      folder.answer(m, (answer) => win.postMessage(answer, '*'));
      if (m.type === 'complete') {
        const items = COMMANDS.filter((c) => c.label.includes(String(m.query)));
        const answer = () => win.postMessage({ type: 'completions', kind: m.kind, seq: m.seq, items }, '*');
        if (held) pending.push(answer);
        else setTimeout(answer);
      }
    },
  });
  win.eval(readFileSync(join(ROOT, 'media/board.js'), 'utf8'));
  const prompt = win.document.getElementById('prompt') as HTMLTextAreaElement;
  const popup = win.document.getElementById('popup')!;
  const settle = () => new Promise((r) => setTimeout(r, 20));

  /** Types `text` at the caret, as the browser does (one input event). */
  async function type(text: string) {
    prompt.focus();
    prompt.setRangeText(text, prompt.selectionStart, prompt.selectionEnd, 'end');
    prompt.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle();
  }

  /** Presses `key`: keydown, the browser's default caret move unless the board took the key, then keyup. */
  async function press(key: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}) {
    const down = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
    prompt.dispatchEvent(down);
    if (!down.defaultPrevented) {
      const at = prompt.selectionStart;
      const moved = { ArrowLeft: Math.max(0, at - 1), ArrowRight: Math.min(prompt.value.length, at + 1), Home: 0, End: prompt.value.length }[key];
      if (moved !== undefined) prompt.setSelectionRange(moved, moved);
    }
    prompt.dispatchEvent(new win.KeyboardEvent('keyup', { key, bubbles: true }));
    await settle();
    return down;
  }

  win.postMessage({ type: 'board', composer: { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: UNSTACKABLE, ...composer }, sessions: [], tasks: [] }, '*');
  await settle();
  const release = async () => {
    pending.splice(0).forEach((answer) => answer());
    await settle();
  };
  /** The extension's answer to `compose`. */
  const composed = async (m: Record<string, unknown>) => {
    win.postMessage({ type: 'composed', ...m }, '*');
    await settle();
  };
  /** Types `text` and presses Enter: what the webview posted to the extension. */
  async function send(text: string) {
    await type(text);
    await press('Enter');
    return posted.filter((m) => m.type === 'compose').at(-1)!;
  }
  const pill = () => win.document.getElementById('model')!.textContent;
  /** A message from the extension. */
  const host = async (m: Record<string, unknown>) => {
    win.postMessage(m, '*');
    await settle();
  };
  return { prompt, popup, posted, type, press, release, composed, send, pill, host, folder, stored: () => folder.flat(), webviewState: () => webviewState };
}

/** The pill's rows before the CLI listed its models: Default and Claude's aliases. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALIAS_ROWS = ['Default', 'sonnet', 'opus', 'haiku'].map((value) => ({ value, label: value, description: '', efforts: EFFORTS }));

describe('board webview: a remembered model the CLI has not listed yet', () => {
  it('is what Enter starts on, with its effort, and what the pill shows', async () => {
    const b = await board({ saved: { model: 'claude-opus-4-7', effort: 'xhigh' }, composer: { models: ALIAS_ROWS, modelsListing: true } });
    expect(b.pill()).toContain('claude-opus-4-7');
    expect(b.pill()).toContain('xhigh');
    const sent = await b.send('hello');
    expect(sent.model).toBe('claude-opus-4-7');
    expect(sent.effort).toBe('xhigh');
  });

  it('falls back to Default once the CLI answered without it', async () => {
    const b = await board({ saved: { model: 'claude-opus-4-7', effort: 'xhigh' }, composer: { models: ALIAS_ROWS, modelsListing: false } });
    expect(b.pill()).toContain('Default model');
    expect((await b.send('hello')).model).toBe('Default');
  });

  it("keeps a Claude alias picked before the CLI listed its models, with its effort, once the CLI answered without it", async () => {
    const cliRows = [
      { value: 'Default', label: 'Default', description: '', efforts: EFFORTS },
      { value: 'claude-opus-4-7', label: 'Opus 4.7', description: '', efforts: EFFORTS },
    ];
    const aliases = [{ value: 'opus', label: 'opus', description: "Claude's alias", efforts: EFFORTS }];
    const b = await board({ saved: { model: 'opus', effort: 'high' }, composer: { models: cliRows, aliases, modelsListing: false } });
    expect(b.pill()).toContain('opus');
    expect(b.pill()).toContain('high');
    const sent = await b.send('hello');
    expect(sent.model).toBe('opus');
    expect(sent.effort).toBe('high');
  });
});

describe('board webview: /model <id> the model list did not have yet', () => {
  it('keeps the effort though setChoice arrives before the new row (first row has no efforts)', async () => {
    const router = { value: 'router', label: 'Router', description: '', efforts: [] };
    const opus = { value: 'claude-opus-4-7', label: 'Opus 4.7', description: '', efforts: EFFORTS };
    const b = await board({ saved: { model: 'claude-opus-4-7', effort: 'high' }, composer: { models: [router, opus] } });
    expect(b.pill()).toContain('high');
    await b.host({ type: 'setChoice', model: 'opus[1m]' });
    const added = { value: 'opus[1m]', label: 'opus[1m]', description: '', efforts: EFFORTS };
    await b.host({ type: 'board', composer: { notReady: '', modes: [], defaultMode: '', models: [router, opus, added], worktrees: [], unstackable: UNSTACKABLE }, sessions: [], tasks: [] });
    expect(b.pill()).toContain('high');
    const sent = await b.send('hello');
    expect(sent.model).toBe('opus[1m]');
    expect(sent.effort).toBe('high');
  });
});

describe('board webview: the / popup after the caret moves', () => {
  it('Enter with the caret moved back inside the word never splices it (no "/model d")', async () => {
    const b = await board();
    await b.type('/mod');
    expect(b.popup.hidden).toBe(false);
    await b.press('ArrowDown');
    await b.press('ArrowLeft');
    await b.press('Enter');
    expect(b.prompt.value).not.toBe('/model d');
    // The highlighted /model runs on the whole word.
    expect(b.posted.filter((m) => m.type === 'compose').map((m) => m.prompt)).toEqual(['/model']);
  });

  it('Tab with the caret moved out of the word does not insert at the old place (no "/auto-mode-setup /mod")', async () => {
    const b = await board();
    await b.type('/mod');
    expect(b.popup.hidden).toBe(false);
    await b.press('Home');
    expect(b.popup.hidden).toBe(true);
    await b.press('Tab');
    expect(b.prompt.value).toBe('/mod');
  });

  it('Tab with the caret moved back inside the word replaces the whole word', async () => {
    const b = await board();
    await b.type('/mod');
    await b.press('ArrowLeft');
    await b.press('Tab');
    expect(b.prompt.value).toBe('/auto-mode-setup ');
  });
});

describe('board webview: the empty / popup', () => {
  it('Tab with "No matching skills or commands" open stays in the box', async () => {
    const b = await board();
    await b.type('/zzzq');
    expect(b.popup.hidden).toBe(false);
    expect(b.popup.textContent).toContain('No matching skills or commands');
    const down = await b.press('Tab');
    expect(down.defaultPrevented).toBe(true);
    expect(b.prompt.value).toBe('/zzzq');
  });
});

describe('board webview: stacked skills', () => {
  it('a / after a built-in the board handles opens no menu (no "/clear /simplify ")', async () => {
    const b = await board();
    await b.type('/clear /');
    expect(b.popup.hidden).toBe(true);
    await b.type('simpl');
    await b.press('Tab');
    expect(b.prompt.value).toBe('/clear /simpl');
  });

  it('a / after a skill opens the menu of skills', async () => {
    const b = await board();
    await b.type('/review /simpl');
    expect(b.popup.hidden).toBe(false);
    await b.press('Tab');
    expect(b.prompt.value).toBe('/review /simplify ');
  });
});

describe('board webview: Enter before the / menu opens', () => {
  it('a late completions answer for the sent text opens no menu over the emptied box, and Enter runs nothing', async () => {
    const b = await board({ held: true });
    await b.type('/clear');
    expect(b.popup.hidden).toBe(true);
    await b.press('Enter');
    expect(b.posted.filter((m) => m.type === 'compose').map((m) => m.prompt)).toEqual(['/clear']);
    await b.composed({ ok: true });
    expect(b.prompt.value).toBe('');
    await b.release();
    expect(b.popup.hidden).toBe(true);
    await b.press('Enter');
    expect(b.posted.filter((m) => m.type === 'compose')).toHaveLength(1);
  });

  it('a late answer arriving while the send is still in flight opens no menu either', async () => {
    const b = await board({ held: true });
    await b.type('/clear');
    await b.press('Enter');
    await b.release();
    expect(b.popup.hidden).toBe(true);
    await b.composed({ ok: true });
    expect(b.popup.hidden).toBe(true);
    expect(b.prompt.value).toBe('');
  });
});

describe('board webview: Enter or Tab before the answer for the new query', () => {
  it("Enter acts on the text typed, not on the previous query's rows ('/c' then 'ompact' sends '/compact', not '/clear')", async () => {
    const b = await board({ held: true });
    await b.type('/c');
    await b.release();
    expect(b.popup.hidden).toBe(false);
    await b.type('ompact');
    await b.press('Enter');
    expect(b.posted.filter((m) => m.type === 'compose').map((m) => m.prompt)).toEqual(['/compact']);
    await b.release();
    expect(b.popup.hidden).toBe(true);
  });

  it("Tab completes nothing from the previous query's rows", async () => {
    const b = await board({ held: true });
    await b.type('/c');
    await b.release();
    await b.type('ompact');
    const down = await b.press('Tab');
    expect(down.defaultPrevented).toBe(true);
    expect(b.prompt.value).toBe('/compact');
    await b.release();
    expect(b.prompt.value).toBe('/compact');
  });

  it('once the answer for the new query came, Tab completes from it', async () => {
    const b = await board({ held: true });
    await b.type('/c');
    await b.release();
    await b.type('l');
    await b.release();
    await b.press('Tab');
    expect(b.prompt.value).toBe('/clear ');
  });
});

describe('board webview: Tab before the first / or @ answer', () => {
  it('keeps the focus in the box while the / list is on its way, and the answer opens the menu there', async () => {
    const b = await board({ held: true });
    await b.type('/mod');
    expect(b.popup.hidden).toBe(true);
    const down = await b.press('Tab');
    expect(down.defaultPrevented).toBe(true);
    expect(b.prompt.value).toBe('/mod');
    await b.release();
    expect(b.popup.hidden).toBe(false);
  });

  it('keeps the focus in the box during the @ pause', async () => {
    const b = await board();
    await b.type('look @sr');
    const down = await b.press('Tab');
    expect(down.defaultPrevented).toBe(true);
  });

  it('a Tab with no / or @ word being completed still leaves the box', async () => {
    const b = await board();
    await b.type('plain text');
    const down = await b.press('Tab');
    expect(down.defaultPrevented).toBe(false);
  });
});

describe('board webview: notice actions', () => {
  it('clicking a notice action (Send as text anyway) puts focus back in the prompt box', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    await b.type('/foo bar baz');
    await b.press('Enter');
    doc.defaultView!.postMessage({ type: 'notice', text: '/foo is not a command.', tone: 'warning', actions: [{ id: 1, label: 'Send as text anyway' }] }, '*');
    await new Promise((r) => setTimeout(r, 20));
    const action = doc.querySelector<HTMLButtonElement>('#notice button')!;
    // A click focuses the button first, as the browser does.
    action.focus();
    action.click();
    expect(b.posted.at(-1)).toEqual({ type: 'noticeAction', id: 1 });
    expect(doc.activeElement?.id).toBe('prompt');
  });

  /** `/frobnicate the cache` warned with "Send as text anyway", whose action keeps the choices it was sent with. */
  async function warned() {
    const b = await board({ composer: { models: ALIAS_ROWS, worktrees: [{ name: 'feat-a', dir: '/ws/worktrees/feat-a' }] } });
    const doc = b.prompt.ownerDocument;
    await b.send('/frobnicate the cache');
    await b.composed({ ok: true, keep: true });
    await b.host({ type: 'notice', text: '/frobnicate is not a command.', tone: 'warning', actions: [{ id: 'a1', label: 'Send as text anyway' }] });
    const noticeEl = doc.getElementById('notice')!;
    expect(noticeEl.hidden).toBe(false);
    /** Clicks the row labelled `label` of the popup `pill` opens. */
    const pick = async (pill: 'where' | 'model', label: string) => {
      doc.getElementById(pill)!.click();
      await new Promise((r) => setTimeout(r, 20));
      const row = [...b.popup.querySelectorAll<HTMLElement>('.pop-row')].find((r) => r.querySelector('.pop-label')?.textContent === label)!;
      row.click();
      await new Promise((r) => setTimeout(r, 20));
    };
    return { b, noticeEl, pick };
  }

  it('picking another folder closes the notice, so its action cannot start in the old one', async () => {
    const { b, noticeEl, pick } = await warned();
    await pick('where', 'feat-a');
    expect(noticeEl.hidden).toBe(true);
    expect(b.posted.at(-1)).toEqual({ type: 'noticeDismissed' });
    // Enter now sends it with the folder shown.
    await b.press('Enter');
    expect(b.posted.filter((m) => m.type === 'compose').at(-1)).toMatchObject({ prompt: '/frobnicate the cache', where: '/ws/worktrees/feat-a' });
  });

  it('picking another model closes the notice too', async () => {
    const { b, noticeEl, pick } = await warned();
    await pick('model', 'opus');
    expect(noticeEl.hidden).toBe(true);
    expect(b.posted.some((m) => m.type === 'noticeDismissed')).toBe(true);
  });

  it('a choice the extension sets (setChoice) leaves the notice', async () => {
    const { b, noticeEl } = await warned();
    await b.host({ type: 'setChoice', model: 'opus' });
    expect(noticeEl.hidden).toBe(false);
    expect(b.posted.some((m) => m.type === 'noticeDismissed')).toBe(false);
  });

  it('clicking into a / word in the box leaves the notice (only typing or Escape closes it)', async () => {
    const { b, noticeEl } = await warned();
    b.prompt.focus();
    b.prompt.setSelectionRange(4, 4);
    b.prompt.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(noticeEl.hidden).toBe(false);
    expect(b.posted.some((m) => m.type === 'noticeDismissed')).toBe(false);
    // The / menu still opens for the word clicked into.
    expect(b.posted.at(-1)).toMatchObject({ type: 'complete', kind: '/', query: 'fro' });
  });

  it('Escape in the empty box closes the notice (as /help leaves it)', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    await b.type('/help');
    await b.press('Enter');
    await b.composed({ ok: true });
    doc.defaultView!.postMessage({ type: 'notice', text: 'Claude Board help.', tone: 'info' }, '*');
    await new Promise((r) => setTimeout(r, 20));
    const noticeEl = doc.getElementById('notice')!;
    expect(noticeEl.hidden).toBe(false);
    const down = await b.press('Escape');
    expect(down.defaultPrevented).toBe(true);
    expect(noticeEl.hidden).toBe(true);
    expect(b.posted.at(-1)).toEqual({ type: 'noticeDismissed' });
  });
});

describe('board webview: the / footer button', () => {
  async function clickSlash(b: Awaited<ReturnType<typeof board>>) {
    b.prompt.ownerDocument.getElementById('slash')!.click();
    await new Promise((r) => setTimeout(r, 20));
  }

  it('on text that already starts with a command, the picked command replaces that word (no "/auto-mode-setup simplify fix it")', async () => {
    const b = await board();
    await b.type('/simplify fix it');
    await clickSlash(b);
    expect(b.popup.hidden).toBe(false);
    // The old command word is gone, not spliced into what is typed ("/modsimplify").
    expect(b.prompt.value).toBe('/ fix it');
    await b.type('mod');
    expect(b.prompt.value).toBe('/mod fix it');
    await b.press('Enter');
    expect(b.prompt.value).toBe('/auto-mode-setup fix it');
  });

  it('on text that starts with a command, Enter on /model keeps the text after it', async () => {
    const b = await board();
    await b.type('/simplify fix it');
    await clickSlash(b);
    await b.type('mod');
    await b.press('ArrowDown');
    await b.press('Enter');
    expect(b.prompt.value).toBe('/model fix it');
  });

  it('on plain text, / goes in front of it and the menu opens', async () => {
    const b = await board();
    await b.type('fix it');
    await clickSlash(b);
    expect(b.prompt.value).toBe('/fix it');
    expect(b.popup.hidden).toBe(false);
  });

  it('on plain text, the picked command goes in front of its first word (no "/simplify it")', async () => {
    const b = await board();
    await b.type('fix it');
    await clickSlash(b);
    await b.type('simpl');
    await b.press('Tab');
    expect(b.prompt.value).toBe('/simplify fix it');
  });
});

describe('board webview: / typed in front of plain text', () => {
  it('Tab puts the command in front of the first word (no "/auto-mode-setup it")', async () => {
    const b = await board();
    await b.type('fix it');
    await b.press('Home');
    await b.type('/');
    expect(b.popup.hidden).toBe(false);
    await b.press('Tab');
    expect(b.prompt.value).toBe('/auto-mode-setup fix it');
  });

  it('after Escape and more typing, Tab still keeps the first word (no "/model it")', async () => {
    const b = await board();
    await b.type('fix it');
    await b.press('Home');
    await b.type('/');
    await b.type('m');
    await b.press('Escape');
    expect(b.popup.hidden).toBe(true);
    await b.type('o');
    await b.type('d');
    await b.press('ArrowDown');
    await b.press('Tab');
    expect(b.prompt.value).toBe('/model fix it');
  });

  it('after Escape, a click back into the word then Tab still keeps the first word', async () => {
    const b = await board();
    await b.type('fix it');
    await b.press('Home');
    await b.type('/');
    await b.type('mod');
    await b.press('Escape');
    b.prompt.setSelectionRange(4, 4);
    b.prompt.dispatchEvent(new b.prompt.ownerDocument.defaultView!.MouseEvent('click'));
    await new Promise((r) => setTimeout(r, 20));
    await b.press('ArrowDown');
    await b.press('Tab');
    expect(b.prompt.value).toBe('/model fix it');
  });

  it('a / typed in front of a word after a skill keeps that word too (no "/simplify /auto-mode-setup it")', async () => {
    const b = await board();
    await b.type('/simplify fix it');
    b.prompt.setSelectionRange(10, 10);
    await b.type('/');
    await b.type('auto');
    await b.press('Tab');
    expect(b.prompt.value).toBe('/simplify /auto-mode-setup fix it');
  });
});

describe('board webview: /model or /effort while editing a prompt for later', () => {
  const sonnet = { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: '', efforts: EFFORTS };
  const opus = { value: 'claude-opus-4-7', label: 'Opus 4.7', description: '', efforts: EFFORTS };
  const haiku = { value: 'claude-haiku-4-5', label: 'Haiku 4.5', description: '', efforts: [] };
  const models = [{ value: 'Default', label: 'Default', description: '', efforts: [] }, sonnet, opus, haiku];

  it('keeps the model /model chose after the box clears', async () => {
    const b = await board({ saved: { model: 'claude-sonnet-4-6', effort: 'high' }, composer: { models } });
    await b.host({ type: 'focus', text: 'prompt for later', editing: 'item-1', choice: { model: 'claude-haiku-4-5' } });
    expect(b.pill()).toContain('Haiku 4.5');
    // Later (on while editing) switches to starting it now; then the text is replaced.
    (b.prompt.ownerDocument.getElementById('later') as HTMLButtonElement).click();
    b.prompt.value = '';
    const sent = await b.send('/model claude-opus-4-7');
    expect(sent.prompt).toBe('/model claude-opus-4-7');
    expect(sent.later).toBe(false);
    await b.host({ type: 'setChoice', model: 'claude-opus-4-7' });
    await b.composed({ ok: true });
    expect(b.pill()).toContain('Opus 4.7');
    expect(b.pill()).toContain('high');
    const next = await b.send('hello');
    expect(next.model).toBe('claude-opus-4-7');
    expect(next.effort).toBe('high');
  });

  it('keeps the effort /effort chose after the edit is cancelled', async () => {
    const b = await board({ saved: { model: 'claude-opus-4-7', effort: 'high' }, composer: { models } });
    await b.host({ type: 'focus', text: 'prompt A', editing: 'item-2', choice: { model: 'claude-sonnet-4-6', effort: 'low' } });
    await b.host({ type: 'setChoice', effort: 'max' });
    expect(b.pill()).toContain('max');
    (b.prompt.ownerDocument.getElementById('cancel-edit') as HTMLButtonElement).click();
    expect(b.pill()).toContain('Opus 4.7');
    expect(b.pill()).toContain('max');
  });

  it('a pill picked while editing still applies to the edit only', async () => {
    const b = await board({ saved: { model: 'claude-opus-4-7', effort: 'high' }, composer: { models } });
    await b.host({ type: 'focus', text: 'prompt A', editing: 'item-2', choice: { model: 'claude-sonnet-4-6', effort: 'low' } });
    (b.prompt.ownerDocument.getElementById('cancel-edit') as HTMLButtonElement).click();
    expect(b.pill()).toContain('Opus 4.7');
    expect(b.pill()).toContain('high');
  });
});

describe('board webview: a / popup left open when the focus moves to a card', () => {
  it('closes, so Enter on the card only opens its session and the arrows move between cards', async () => {
    const b = await board();
    const session = (id: string) => ({ id, look: 'idle', lookLabel: 'Idle', title: `Session ${id}`, worktree: 'main', canOpen: true });
    const data = { worktrees: ['main'], lanes: [{ id: 'needs', title: 'Needs you', sessions: [session('s1'), session('s2')] }] };
    const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: UNSTACKABLE };
    await b.host({ type: 'board', loaded: true, board: data, composer });
    await b.type('/cl');
    expect(b.popup.hidden).toBe(false);
    // The focus moves to a card with no mousedown in the webview.
    const doc = b.prompt.ownerDocument;
    const card = (id: string) => doc.querySelector(`.card[data-session="${id}"]`) as HTMLElement;
    card('s1').focus();
    expect(doc.activeElement).toBe(card('s1'));
    expect(b.popup.hidden).toBe(true);
    const keydown = (target: HTMLElement, key: string) =>
      target.dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    keydown(card('s1'), 'ArrowDown');
    expect(doc.activeElement).toBe(card('s2'));
    keydown(card('s2'), 'Enter');
    expect(b.posted.filter((m) => m.type === 'compose')).toEqual([]);
    expect(b.posted.filter((m) => m.type === 'open').map((m) => m.id)).toEqual(['s2']);
  });
});

describe('board webview: → from the Claude view', () => {
  it('always focuses the prompt box, wherever ← left from; ↑ from the box goes back to the card', async () => {
    const b = await board();
    const session = (id: string) => ({ id, look: 'idle', lookLabel: 'Idle', title: `Session ${id}`, worktree: 'main', canOpen: true });
    const data = { worktrees: ['main'], lanes: [{ id: 'needs', title: 'Needs you', sessions: [session('s1'), session('s2')] }] };
    const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: UNSTACKABLE };
    await b.host({ type: 'board', loaded: true, board: data, composer });
    const doc = b.prompt.ownerDocument;
    const card = (id: string) => doc.querySelector(`.card[data-session="${id}"]`) as HTMLElement;
    // ← on a card of the leftmost lane goes to the Claude view.
    card('s2').focus();
    card('s2').dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(b.posted.filter((m) => m.type === 'sidebar').map((m) => m.id)).toEqual(['s2']);
    card('s2').blur();
    await b.host({ type: 'enter' });
    expect(doc.activeElement).toBe(b.prompt);
    await b.press('ArrowUp');
    expect(doc.activeElement).toBe(card('s2'));
  });
});

describe('board webview: a board update while a card is clicked', () => {
  const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: UNSTACKABLE };
  const session = (id: string, title = `Session ${id}`) => ({ id, look: 'working', lookLabel: 'Working', title, worktree: 'main', canOpen: true, canFork: true });
  const boardOf = (...sessions: ReturnType<typeof session>[]) => ({
    type: 'board',
    loaded: true,
    composer,
    board: { worktrees: ['main'], lanes: [{ id: 'working', title: 'Working', sessions }, { id: 'done', title: 'Done', sessions: [] }] },
  });

  it('keeps the card and its buttons the same elements, so a double-click across the update opens the session', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const win = doc.defaultView!;
    const card = (id: string) => doc.querySelector(`.card[data-session="${id}"]`) as HTMLElement;
    await b.host(boardOf(session('s1', 'Fix the parser'), session('s2')));
    const before = card('s1');
    const fork = before.querySelector('button')!;
    before.dispatchEvent(new win.MouseEvent('click', { bubbles: true, detail: 1 }));
    // The session moved on between the two clicks: its title changed and another session started.
    await b.host(boardOf(session('s3'), session('s1', 'Read the parser'), session('s2')));
    expect(card('s1')).toBe(before);
    expect(before.querySelector('.title')!.textContent).toBe('Read the parser');
    expect(before.querySelector('button')).toBe(fork);
    before.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect(b.posted.filter((m) => m.type === 'open').map((m) => m.id)).toEqual(['s1']);
    // Its buttons still act on it, and a double-click on one opens nothing.
    fork.click();
    fork.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect(b.posted.filter((m) => m.type === 'fork').map((m) => m.id)).toEqual(['s1']);
    expect(b.posted.filter((m) => m.type === 'open')).toHaveLength(1);
    expect([...doc.querySelectorAll('.card')].map((c) => (c as HTMLElement).dataset.session)).toEqual(['s3', 's1', 's2']);
  });

  it('draws a color given by hand on the card and puts it in the right-click menu context', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const card = (id: string) => doc.querySelector(`.card[data-session="${id}"]`) as HTMLElement;
    await b.host(boardOf({ ...session('s1'), color: 'green' } as ReturnType<typeof session>, session('s2')));
    expect(card('s1').classList.contains('color-green')).toBe(true);
    expect(JSON.parse(card('s1').dataset.vscodeContext!)).toMatchObject({ sessionId: 's1', sessionColor: 'green' });
    expect([...card('s2').classList].some((c) => c.startsWith('color-'))).toBe(false);
    expect(JSON.parse(card('s2').dataset.vscodeContext!).sessionColor).toBe('');
    // Taking the color away redraws the card without it.
    await b.host(boardOf(session('s1'), session('s2')));
    expect(card('s1').classList.contains('color-green')).toBe(false);
  });

  it('keeps the focus on a card that stays, and gives it back to one that moved', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const card = (id: string) => doc.querySelector(`.card[data-session="${id}"]`) as HTMLElement;
    await b.host(boardOf(session('s1'), session('s2')));
    card('s2').focus();
    await b.host(boardOf(session('s1'), session('s2', 'Thinking')));
    expect(doc.activeElement).toBe(card('s2'));
    await b.host(boardOf(session('s2', 'Thinking'), session('s1')));
    expect(doc.activeElement).toBe(card('s2'));
    await b.host(boardOf(session('s1')));
    expect(doc.activeElement).toBe(card('s1'));
  });
});

describe('board webview: Enter on a / menu row in Save for later', () => {
  it('saves the command for later, as plain Enter does', async () => {
    const b = await board();
    await b.host({ type: 'focus', later: true });
    await b.type('/cle');
    expect(b.popup.hidden).toBe(false);
    await b.press('Enter');
    expect(b.posted.filter((m) => m.type === 'compose').map((m) => [m.prompt, m.later])).toEqual([['/clear', true]]);
  });

  it('saves an edited prompt for later again, in place of the old one', async () => {
    const b = await board();
    await b.host({ type: 'focus', text: '', editing: 'item-1' });
    await b.type('/cle');
    await b.press('Enter');
    const sent = b.posted.filter((m) => m.type === 'compose');
    expect(sent.map((m) => [m.prompt, m.later, m.replaces])).toEqual([['/clear', true, 'item-1']]);
  });
});

describe('board webview: Alt+Enter on a / menu row', () => {
  it('saves the highlighted command for later, not the half-typed word (no "/simpl")', async () => {
    const b = await board();
    await b.type('/simpl');
    expect(b.popup.hidden).toBe(false);
    await b.press('Enter', { altKey: true });
    expect(b.posted.filter((m) => m.type === 'compose').map((m) => [m.prompt, m.later])).toEqual([['/simplify', true]]);
    expect(b.popup.hidden).toBe(true);
  });

  it('saves a command the board runs for later instead of running it', async () => {
    const b = await board();
    await b.type('/cle');
    await b.press('Enter', { altKey: true });
    expect(b.posted.filter((m) => m.type === 'compose').map((m) => [m.prompt, m.later])).toEqual([['/clear', true]]);
  });
});

describe('board webview: a footer pill clicked while another popup is open', () => {
  it('opens its menu in place of the / popup at the first click', async () => {
    const b = await board();
    await b.type('/mo');
    expect(b.popup.hidden).toBe(false);
    expect(b.popup.textContent).toContain('/model');
    (b.prompt.ownerDocument.getElementById('where') as HTMLButtonElement).click();
    expect(b.popup.hidden).toBe(false);
    expect(b.popup.textContent).toContain('New worktree');
    expect(b.popup.textContent).not.toContain('/model');
  });

  it('opens its menu in place of another pill menu, and closes its own at a second click', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    (doc.getElementById('model') as HTMLButtonElement).click();
    expect(b.popup.textContent).toContain('Model');
    const where = doc.getElementById('where') as HTMLButtonElement;
    where.click();
    expect(b.popup.hidden).toBe(false);
    expect(b.popup.textContent).toContain('New worktree');
    where.click();
    expect(b.popup.hidden).toBe(true);
  });
});

describe('board webview: pasting an image', () => {
  /** Pastes clipboard `items` into the box: whether the board took the paste. */
  async function paste(b: Awaited<ReturnType<typeof board>>, items: Array<{ kind: string; type: string; getAsFile: () => unknown }>) {
    const ev = new (b.prompt.ownerDocument.defaultView as Window & typeof globalThis).Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { items } });
    b.prompt.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 50));
    return ev.defaultPrevented;
  }

  it('sends the image to the extension as base64 and inserts the mention it answers with', async () => {
    const b = await board();
    await b.type('look at ');
    const win = b.prompt.ownerDocument.defaultView as Window & typeof globalThis;
    const file = new win.File(['hi'], 'image.png', { type: 'image/png' });
    expect(await paste(b, [{ kind: 'file', type: 'image/png', getAsFile: () => file }])).toBe(true);
    expect(b.posted.filter((m) => m.type === 'pasteImage')).toEqual([{ type: 'pasteImage', mime: 'image/png', data: 'aGk=' }]);
    await b.host({ type: 'insert', text: '@/tmp/pasted.png ' });
    expect(b.prompt.value).toBe('look at @/tmp/pasted.png ');
  });

  it('leaves a text paste to the browser', async () => {
    const b = await board();
    expect(await paste(b, [{ kind: 'string', type: 'text/plain', getAsFile: () => null }])).toBe(false);
    expect(b.posted.some((m) => m.type === 'pasteImage')).toBe(false);
  });
});

describe('board webview: the prompt box above the lanes (devdesk.board.promptPlacement top)', () => {
  const session = (id: string) => ({ id, look: 'idle', lookLabel: 'Idle', title: `Session ${id}`, worktree: 'main', canOpen: true });
  const composer = (placement: string) => ({ notReady: '', placement, modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: UNSTACKABLE });
  const boardOf = (placement: string) => ({
    type: 'board',
    loaded: true,
    composer: composer(placement),
    board: { worktrees: ['main'], lanes: [{ id: 'needs', title: 'Needs you', sessions: [session('s1'), session('s2')] }] },
  });

  it('↓ goes to the cards, ↑ on the first card back to the box, and plain ↑ brings back earlier prompts; the hint says so', async () => {
    const b = await board({ saved: { history: ['earlier one'] } });
    const doc = b.prompt.ownerDocument;
    const card = (id: string) => doc.querySelector(`.card[data-session="${id}"]`) as HTMLElement;
    const text = (id: string) => doc.getElementById(id)!.textContent;
    await b.host(boardOf('bottom'));
    expect(text('hint-cards-key')).toBe('↑');
    expect(text('hint-history')).not.toBe('↑');
    await b.host(boardOf('top'));
    expect(doc.body.dataset.placement).toBe('top');
    expect(text('hint-cards-key')).toBe('↓');
    expect(text('hint-history')).toBe('↑');
    b.prompt.focus();
    await b.press('ArrowDown');
    expect(doc.activeElement).toBe(card('s1'));
    card('s1').dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(doc.activeElement).toBe(b.prompt);
    await b.press('ArrowUp');
    expect(b.prompt.value).toBe('earlier one');
  });
});

describe('board webview: session cards', () => {
  const composer = { notReady: '', modes: [], defaultMode: '', models: [{ value: 'Default', label: 'Default', efforts: [] }], worktrees: [], unstackable: UNSTACKABLE };
  const hoverParts = [
    { text: 'Raise login timeout' },
    { label: 'Where it stands', text: 'TIMEOUT_MS raised to 30s; tests pass' },
    { label: 'Last prompt', text: 'Fix the login timeout when the session expires' },
  ];
  const boardOf = (lanes: unknown[]) => ({ type: 'board', loaded: true, composer, board: { worktrees: ['main'], lanes } });

  it('shows the title, the worktree and when, and in Needs you what Claude asks', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    await b.host(
      boardOf([
        { id: 'needs', title: 'Needs you', sessions: [{ id: 'n', look: 'permission', lookLabel: 'Permission', title: 'Upgrade to SDK v3', ask: 'Allow npm uninstall aws-sdk?', worktree: 'sdk', ago: '12m', canEnd: true, hoverParts }] },
        { id: 'review', title: 'Done', sessions: [{ id: 'd', look: 'done', lookLabel: 'Done', title: 'Raise login timeout', worktree: 'main', ago: '2m', canFork: true, canEnd: true, detail: 'I changed it', insight: 'Done', hoverParts }] },
      ]),
    );
    const needs = doc.querySelector('.card[data-session="n"]')!;
    expect(needs.querySelector('.ask-kind')!.textContent).toContain('Permission');
    expect(needs.querySelector('.ask-text')!.textContent).toBe('Allow npm uninstall aws-sdk?');
    expect(needs.querySelector('.when')!.textContent).toBe('waiting 12m');
    const done = doc.querySelector('.card[data-session="d"]')!;
    expect(done.querySelector('.title')!.textContent).toBe('Raise login timeout');
    expect(done.querySelector('.ask')).toBeNull();
    // The detail and the insight are only in the hover now.
    expect(done.querySelector('.detail, .insight')).toBeNull();
    expect(done.querySelector('.wt')!.textContent).toBe('main');
    expect([...done.querySelectorAll('.acts button')].map((x) => x.textContent)).toEqual(['Fork', 'End']);
  });

  it('shows in Working what Claude is doing, and ☰ hides the Working and Needs you lines', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const lanes = [
      { id: 'needs', title: 'Needs you', sessions: [{ id: 'n', look: 'question', lookLabel: 'Question', title: 'Paginate', ask: 'Cursor or page numbers?', worktree: 'api', ago: '3m', hoverParts }] },
      { id: 'working', title: 'Working', sessions: [{ id: 'w', look: 'working', lookLabel: 'Working', title: 'Fix parser', doing: 'Running the unit tests', worktree: 'main', ago: 'just now', hoverParts }] },
    ];
    await b.host(boardOf(lanes));
    expect(doc.querySelector('.card[data-session="w"] .doing')!.textContent).toBe('Running the unit tests');
    expect(doc.getElementById('cardline')!.getAttribute('aria-pressed')).toBe('true');
    (doc.getElementById('cardline') as HTMLButtonElement).click();
    expect(b.posted.at(-1)).toEqual({ type: 'toggleCardLine' });
    // The extension flips devdesk.board.cardLine and posts the board again.
    await b.host({ ...boardOf(lanes), cardLine: false });
    expect(doc.querySelector('.card .doing, .card .ask')).toBeNull();
    expect(doc.querySelector('.card[data-session="n"] .when')!.textContent).toContain('3m');
    expect(doc.getElementById('cardline')!.getAttribute('aria-pressed')).toBe('false');
    expect(doc.getElementById('cardline')!.title).toMatch(/^Show/);
  });

  it('leaves a card whose session did not change as shown, and updates the one that did', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const session = (id: string, title: string) => ({ id, look: 'done', lookLabel: 'Done', title, worktree: 'main', ago: '1m', hoverParts });
    await b.host(boardOf([{ id: 'review', title: 'Done', sessions: [session('a', 'Alpha'), session('b', 'Beta')] }]));
    const title = (id: string) => doc.querySelector(`.card[data-session="${id}"] .title`)!;
    const [alpha, beta] = [title('a'), title('b')];
    await b.host(boardOf([{ id: 'review', title: 'Done', sessions: [session('a', 'Alpha'), session('b', 'Beta 2')] }]));
    expect(title('a')).toBe(alpha);
    expect(title('b').textContent).toBe('Beta 2');
    // The report of that redraw counts the one card built again.
    await new Promise((r) => setTimeout(r, 50));
    expect(b.posted.filter((m) => m.type === 'rendered').at(-1)).toMatchObject({ rebuilt: 1, cards: 2 });
    expect(doc.querySelectorAll('.card[data-session]')).toHaveLength(2);
    // Nothing of the session changed, but the board's read style did: the card is drawn again.
    await b.host({ ...boardOf([{ id: 'review', title: 'Done', sessions: [session('a', 'Alpha'), session('b', 'Beta 2')] }]), readStyle: { dimRead: true } });
    expect(doc.querySelector('.card[data-session="a"]')!.classList.contains('read')).toBe(true);
    expect(beta.isConnected).toBe(true);
  });

  it('shows the hover soon after the pointer rests on a card, and hides it when the pointer leaves', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const win = doc.defaultView!;
    await b.host(boardOf([{ id: 'review', title: 'Done', sessions: [{ id: 'd', look: 'done', lookLabel: 'Done', title: 'Raise login timeout', worktree: 'main', hoverParts }] }]));
    const card = doc.querySelector('.card[data-session="d"]') as HTMLElement;
    const hover = doc.querySelector('.hovercard') as HTMLElement;
    expect(card.title).toBe('');
    // Screen readers get the hover as text, one paragraph per part.
    expect(card.getAttribute('aria-description')).toBe(
      'Raise login timeout\n\nWhere it stands: TIMEOUT_MS raised to 30s; tests pass\n\nLast prompt: Fix the login timeout when the session expires',
    );
    card.dispatchEvent(new win.MouseEvent('pointerover', { bubbles: true }));
    expect(hover.hidden).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(hover.hidden).toBe(false);
    expect(hover.querySelector('.hc-title')!.textContent).toBe('Raise login timeout');
    expect([...hover.querySelectorAll('.hc-label')].map((x) => x.textContent)).toEqual(['Where it stands', 'Last prompt']);
    card.dispatchEvent(new win.MouseEvent('pointerout', { bubbles: true, relatedTarget: doc.body }));
    await new Promise((r) => setTimeout(r, 100));
    expect(hover.hidden).toBe(true);
  });
});

describe('board webview: the text typed in the box', () => {
  const cancel = (b: { prompt: HTMLTextAreaElement }) => (b.prompt.ownerDocument.getElementById('cancel-edit') as HTMLButtonElement).click();

  it('comes back when the edit of a prompt for later is cancelled', async () => {
    const b = await board();
    await b.type('half a thought');
    await b.host({ type: 'focus', text: 'prompt for later', editing: 'item-1', choice: {} });
    expect(b.prompt.value).toBe('prompt for later');
    cancel(b);
    expect(b.prompt.value).toBe('half a thought');
  });

  it('comes back after the edited prompt for later is saved', async () => {
    const b = await board();
    await b.type('half a thought');
    await b.host({ type: 'focus', text: 'prompt A', editing: 'item-1', choice: {} });
    await b.host({ type: 'focus', text: 'prompt B', editing: 'item-2', choice: {} });
    await b.press('Enter');
    await b.composed({ ok: true });
    expect(b.prompt.value).toBe('half a thought');
  });

  it('is in the box again when the webview loads again (an update, a window reload, the tab moved)', async () => {
    const first = await board();
    await first.type('half a thought');
    // Editing a prompt for later keeps the text typed before as the one to restore, not the prompt being edited.
    await first.host({ type: 'focus', text: 'prompt for later', editing: 'item-1', choice: {} });
    const saved = first.stored();
    expect(saved?.draft).toBe('half a thought');
    const again = await board({ saved });
    expect(again.prompt.value).toBe('half a thought');
  });

  it('is forgotten once it started a session', async () => {
    const b = await board();
    await b.send('start this');
    await b.composed({ ok: true, started: true });
    expect(b.stored()?.draft).toBe('');
  });
});

describe('board webview: what the box keeps for the project folder', () => {
  const models = [
    { value: 'Default', label: 'Default', description: '', efforts: EFFORTS },
    { value: 'claude-opus-4-7', label: 'Opus 4.7', description: '', efforts: EFFORTS },
  ];
  const modes = [
    { name: 'Default', description: '', tone: 'default' },
    { name: 'Plan', description: '', tone: 'plan' },
  ];

  it('keeps the model, effort, mode and Ultracode picked, for the next board on the same folder only', async () => {
    const first = await board({ composer: { models, modes, defaultMode: 'Default' } });
    await first.host({ type: 'setChoice', model: 'claude-opus-4-7', effort: 'xhigh', ultracode: true });
    await first.press('Tab', { shiftKey: true });
    expect(first.stored()).toMatchObject({ model: 'claude-opus-4-7', effort: 'xhigh', ultracode: true, mode: 'Plan' });
    // The board's tab closed and opened again (or a reload): a new webview, the same project folder.
    const again = await board({ folder: first.folder, composer: { models, modes, defaultMode: 'Default' } });
    expect(again.pill()).toContain('Opus 4.7');
    expect(again.pill()).toContain('xhigh');
    expect(again.pill()).toContain('Ultracode');
    const sent = await again.send('hello');
    expect(sent).toMatchObject({ model: 'claude-opus-4-7', effort: 'xhigh', ultracode: true, mode: 'Plan' });
    // Another project folder has its own: none saved, so the defaults.
    const other = await board({ composer: { models, modes, defaultMode: 'Default' } });
    expect(other.pill()).toContain('Default model');
    expect(await other.send('hello')).toMatchObject({ model: 'Default', effort: 'Default', ultracode: false, mode: 'Default' });
  });

  it('keeps only the fields picked: the others follow the defaults', async () => {
    const b = await board({ composer: { models } });
    await b.host({ type: 'setChoice', effort: 'low' });
    expect(b.folder.kept.restore().choice).toEqual({ effort: 'low' });
  });

  it('does not keep a pill picked while editing a prompt for later (its choices are its own)', async () => {
    const b = await board({ saved: { model: 'claude-opus-4-7', effort: 'high' }, composer: { models } });
    await b.host({ type: 'focus', text: 'prompt A', editing: 'item-2', choice: { model: 'Default', effort: 'low' } });
    expect(b.stored()).toMatchObject({ model: 'claude-opus-4-7', effort: 'high' });
    // A board command (/effort) while editing changes the kept choice, as it does the remembered one.
    await b.host({ type: 'setChoice', effort: 'max' });
    expect(b.stored()).toMatchObject({ model: 'claude-opus-4-7', effort: 'max' });
  });

  it('keeps the earlier prompts for ⌥↑ across boards, the last 50', async () => {
    const first = await board();
    for (let i = 0; i < 52; i++) {
      await first.send(`prompt ${i}`);
      await first.composed({ ok: true });
    }
    const history = first.stored().history as string[];
    expect(history).toHaveLength(50);
    expect(history.at(-1)).toBe('prompt 51');
    const again = await board({ folder: first.folder });
    await again.press('ArrowUp');
    expect(again.prompt.value).toBe('prompt 51');
  });

  it("takes what a version before kept in the webview's own state, once, for what the folder has not saved", async () => {
    const b = await board({ legacy: { model: 'claude-opus-4-7', effort: 'high', ultracode: false, history: ['old prompt'], draft: 'old draft', query: 'auth' }, composer: { models } });
    expect(b.prompt.value).toBe('old draft');
    expect(b.pill()).toContain('Opus 4.7');
    expect(b.stored()).toMatchObject({ model: 'claude-opus-4-7', effort: 'high', history: ['old prompt'], draft: 'old draft', query: 'auth' });
    expect(b.webviewState()).toEqual({});
  });

  it("prefers what the folder saved to the webview's own state", async () => {
    const b = await board({ saved: { model: 'Default', draft: 'kept draft' }, legacy: { model: 'claude-opus-4-7', draft: 'old draft' }, composer: { models } });
    expect(b.prompt.value).toBe('kept draft');
    expect(b.pill()).toContain('Default model');
  });
});

describe('board webview: the 📊 popup while the usage count runs', () => {
  const reading = { phase: 'reading', found: 340, listed: 340, files: 12, totalFiles: 340, bytes: 10, totalBytes: 100, savedDays: 3, elapsedMs: 5000, etaMs: 180_000 };

  it('shows how far the count has got, then the numbers', async () => {
    const b = await board();
    const doc = b.prompt.ownerDocument;
    const pop = doc.getElementById('stats-pop')!;
    // Progress before the popup opens is ignored.
    await b.host({ type: 'usageProgress', progress: reading });
    expect(pop.hidden).toBe(true);
    doc.getElementById('stats')!.click();
    expect(b.posted.at(-1)).toEqual({ type: 'usage' });
    expect(pop.textContent).toContain('Counting…');
    await b.host({ type: 'usageProgress', progress: { ...reading, phase: 'listing', listed: 50, totalFiles: 0 } });
    expect(pop.textContent).toContain('Checking which transcripts changed: 50 of 340…');
    await b.host({ type: 'usageProgress', progress: reading });
    expect(pop.textContent).toContain('Reading 12 of 340 transcripts…');
    expect(pop.textContent).toContain('about 3 min left');
    expect(pop.textContent).toContain('keeps counting when you close this');
    expect((pop.querySelector('progress') as HTMLProgressElement).value).toBe(10);
    await b.host({ type: 'usage', usage: scopedPopover([], dayKey(Date.now()), { kind: 'all' }, undefined) });
    expect(pop.textContent).toContain('Claude sessions');
    expect(pop.textContent).not.toContain('Reading');
    // A late progress message does not replace the numbers.
    await b.host({ type: 'usageProgress', progress: reading });
    expect(pop.textContent).not.toContain('Reading');
  });
});
