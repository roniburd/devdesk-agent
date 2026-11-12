// The web access page (src/web/page) in jsdom: index.html with app.ts bundled the way scripts/webBuild.mjs bundles it,
// the daemon played by a fake `fetch` and a fake `EventSource`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardsResponse, ComposerResponse, FoldersResponse, SessionDetail, WebCard } from '../../src/core/web/types';
import { cssColor, fitLine } from '../../src/web/page/screen';

const PAGE = join(__dirname, '..', '..', 'src', 'web', 'page');
let bundle: string | undefined;
const appJs = () =>
  (bundle ??= buildSync({
    entryPoints: [join(PAGE, 'app.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    write: false,
    logLevel: 'error',
  }).outputFiles[0].text);

const card = (over: Partial<WebCard> = {}): WebCard => ({
  id: 's1',
  title: 'Fix tests',
  state: 'idle',
  look: 'idle',
  label: 'READY',
  glyph: '○',
  tone: 'dim',
  spin: false,
  line: '',
  group: 'rest',
  ago: '1m',
  pane: '%1',
  tmuxSession: 'cc-main-1',
  canSend: true,
  ...over,
});

const detail = (c: WebCard, over: Partial<SessionDetail> = {}): SessionDetail => ({
  card: c,
  turns: [
    { kind: 'user', text: 'run the tests' },
    { kind: 'tool', text: '- Bash npm test' },
    { kind: 'assistant', text: 'All green.' },
  ],
  screen: [[{ text: '> ' }], [{ text: 'Do you want to proceed?', fg: 3, bold: true }]],
  prompt: { empty: true, dialog: false, working: false, inMode: false, exited: false },
  ended: false,
  ...over,
});

interface Answer {
  status: number;
  body?: unknown;
}
type Handler = (method: string, url: string, body: unknown) => Answer | undefined;
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  credentials?: string;
  body: unknown;
}

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

const settle = async (win: Window, n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => win.setTimeout(r, 0));
};

/**
 * The page's timers of a second or more, held until fire() runs them (shorter ones, settle()'s included, stay real), so
 * a test can count the polls the page has scheduled.
 */
function holdTimers(win: Window & typeof globalThis) {
  const realSet = win.setTimeout.bind(win);
  const realClear = win.clearTimeout.bind(win);
  const held = new Map<number, () => void>();
  let next = 1_000_000;
  win.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    if ((ms ?? 0) < 1000) return realSet(fn, ms, ...args);
    const id = next++;
    held.set(id, fn);
    return id;
  }) as typeof setTimeout;
  win.clearTimeout = ((id?: number) => {
    if (id !== undefined && held.has(id)) held.delete(id);
    else realClear(id);
  }) as typeof clearTimeout;
  return {
    get pending() {
      return held.size;
    },
    /** Runs every held timer once (the ones they schedule are held for the next fire()). */
    fire() {
      const due = [...held.values()];
      held.clear();
      for (const fn of due) fn();
    },
  };
}

/** The page at `hash`, with `handler` answering its requests (404 for the rest). */
async function page(handler: Handler, hash = '#/', o: { holdTimers?: boolean; delay?: (method: string, url: string) => number } = {}) {
  dom = new JSDOM(readFileSync(join(PAGE, 'index.html'), 'utf8'), {
    url: `http://127.0.0.1:7690/${hash}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(code: string): unknown };
  const calls: Call[] = [];
  const streams: FakeEventSource[] = [];
  class FakeEventSource {
    readyState = 0;
    listeners = new Map<string, Array<(e: { data?: string }) => void>>();
    constructor(readonly url: string) {
      streams.push(this);
    }
    addEventListener(type: string, fn: (e: { data?: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close() {
      this.readyState = 2;
    }
    emit(type: string, data?: unknown) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners.get(type) ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) });
    }
  }
  win.EventSource = FakeEventSource as unknown as typeof EventSource;
  win.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, credentials: init.credentials, body });
    const delay = o.delay?.(method, url) ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const a = handler(method, url, body) ?? { status: 404, body: { error: 'Not found.', code: 'not-found' } };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.scrollTo = () => {};
  const timers = o.holdTimers ? holdTimers(win) : undefined;
  win.eval(appJs());
  await settle(win);
  const doc = win.document;
  const $ = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => [...doc.querySelectorAll(sel)] as HTMLElement[];
  const visible = (el: HTMLElement | null) => !!el && !el.closest('[hidden]');
  return { win, doc, calls, streams, timers, $, $$, visible, settle: () => settle(win) };
}

const cardsAnswer = (cards: WebCard[]): CardsResponse => ({ cards, at: 1 });

describe('list', () => {
  it('shows needs-you first, then working, then the rest, from the event stream', async () => {
    const p = await page(() => undefined);
    expect(p.streams[0].url).toBe('api/events');
    p.streams[0].emit('open');
    p.streams[0].emit(
      'cards',
      cardsAnswer([
        card({ id: 'a', title: 'Idle one', group: 'rest' }),
        card({ id: 'b', title: 'Busy', group: 'working', state: 'working', look: 'working', label: 'WORKING', glyph: '⟳', tone: 'blue', spin: true }),
        card({ id: 'c', title: 'Asks', group: 'needs', state: 'waiting', look: 'permission', label: 'NEEDS PERMISSION', tone: 'yellow', line: 'Bash rm -rf build' }),
        card({ id: 'd', title: 'Other idle', group: 'rest' }),
      ]),
    );
    await p.settle();
    const sections = p.$$('section.group');
    expect(sections.map((s) => s.dataset.group)).toEqual(['needs', 'working', 'rest']);
    expect(sections.map((s) => [...s.querySelectorAll('.title')].map((t) => t.textContent))).toEqual([['Asks'], ['Busy'], ['Idle one', 'Other idle']]);
    const asks = p.$('a.card[href="#/s/c"]')!;
    expect(asks.classList.contains('tone-yellow')).toBe(true);
    expect(asks.querySelector('.label')!.textContent).toBe('Needs permission');
    expect(asks.querySelector('.line')!.textContent).toBe('Bash rm -rf build');
    expect(p.$('a.card[href="#/s/b"] .glyph')!.classList.contains('spin')).toBe(true);
    expect(p.$('a.card[href="#/s/b"] .glyph')!.textContent).toBe('');
    expect(p.$('.view-list form.composer textarea.prompt')).not.toBeNull();
  });

  it('renders card text as text, never as markup', async () => {
    const p = await page(() => undefined);
    p.streams[0].emit('cards', cardsAnswer([card({ title: '<img src=x onerror=alert(1)>', line: '<b>bold</b>' })]));
    await p.settle();
    expect(p.$('img')).toBeNull();
    expect(p.$('b')).toBeNull();
    expect(p.$('.card .title')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('polls api/sessions after three stream errors in a row', async () => {
    const p = await page((m, url) => (m === 'GET' && url === 'api/sessions' ? { status: 200, body: cardsAnswer([card({ title: 'Polled' })]) } : undefined));
    for (let i = 0; i < 3; i++) p.streams[0].emit('error');
    await p.settle();
    expect(p.calls.some((c) => c.url === 'api/sessions')).toBe(true);
    expect(p.$('.card .title')!.textContent).toBe('Polled');
  });

  it('says when there are no sessions', async () => {
    const p = await page(() => undefined);
    p.streams[0].emit('cards', cardsAnswer([]));
    await p.settle();
    expect(p.$('.empty')!.textContent).toContain('No Claude sessions');
  });
});

describe('session', () => {
  const answering = (d: SessionDetail, also: Handler = () => undefined): Handler => (m, url, body) =>
    also(m, url, body) ?? (m === 'GET' && url === `api/sessions/${encodeURIComponent(d.card.id)}` ? { status: 200, body: d } : undefined);

  it('shows the transcript and the reply box at an empty prompt', async () => {
    const c = card({ id: 'tmux:devdesk:%3' });
    const p = await page(answering(detail(c)), `#/s/${encodeURIComponent(c.id)}`);
    expect(p.$$('.turn').map((t) => [t.dataset.kind, t.querySelector('.turn-mark')?.textContent, t.querySelector('.turn-body, summary')!.textContent])).toEqual([
      ['user', '>', 'run the tests'],
      ['tool', undefined, 'Ran a tool: Bash'],
      ['assistant', '⏺', 'All green.'],
    ]);
    expect(p.visible(p.$('textarea.reply-text'))).toBe(true);
    expect(p.visible(p.$('.keys'))).toBe(false);
    expect(p.visible(p.$('.reply button[data-key="Escape"]'))).toBe(false);
  });

  it("renders Claude's Markdown, keeps the prompt as typed, and folds each run of tool calls into one line", async () => {
    const turns: SessionDetail['turns'] = [
      { kind: 'user', text: 'what **passed**?' },
      { kind: 'tool', text: '- Bash npm test' },
      { kind: 'tool', text: '- mcp__playwright__browser_click Send' },
      { kind: 'tool', text: '- Bash npm run e2e' },
      { kind: 'assistant', text: '| Check | Result |\n|---|---|\n| unit | **ok** |' },
    ];
    const p = await page(answering(detail(card(), { turns })), '#/s/s1');
    const [you, tools, claude] = p.$$('.turns > li');
    expect(you.querySelector('.turn-body')!.textContent).toBe('what **passed**?');
    expect(tools.querySelector('summary')!.textContent).toBe('Ran 3 tools: Bash, browser_click');
    expect([...tools.querySelectorAll('.tool-calls li')].map((l) => l.textContent)).toEqual(['Bash npm test', 'mcp__playwright__browser_click Send', 'Bash npm run e2e']);
    expect([...claude.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Check', 'Result']);
    expect(claude.querySelector('td strong')!.textContent).toBe('ok');
  });

  it('replaces the reply box with key buttons and opens the Screen tab when a dialog is open', async () => {
    const c = card({ state: 'waiting' });
    const p = await page(answering(detail(c, { prompt: { empty: false, dialog: true, working: false, inMode: false, exited: false } })), '#/s/s1');
    expect(p.visible(p.$('textarea.reply-text'))).toBe(false);
    expect(p.visible(p.$('.keys'))).toBe(true);
    expect(p.$$('.keys button').map((b) => b.dataset.key)).toEqual(['1', '2', '3', 'Up', 'Down', 'Escape', 'Enter']);
    expect(p.visible(p.$('.panel.screen'))).toBe(true);
    expect(p.visible(p.$('.panel.transcript'))).toBe(false);
    const styled = p.$('.panel.screen .row:nth-child(2) span')!;
    expect(styled.textContent).toBe('Do you want to proceed?');
    expect(styled.style.color).toBe('var(--ansi-3)');
    expect(styled.style.fontWeight).toBe('700');
  });

  it('keeps the reply box, and says why, when text is typed at the prompt (not a dialog)', async () => {
    const c = card({ state: 'done' });
    const p = await page(answering(detail(c, { prompt: { empty: false, dialog: false, working: false, inMode: false, exited: false } })), '#/s/s1');
    expect(p.visible(p.$('textarea.reply-text'))).toBe(true);
    expect(p.visible(p.$('.keys'))).toBe(false);
    expect(p.$('.view-session .notice')?.textContent).toMatch(/already typed/);
  });

  it('sends a key and refreshes', async () => {
    const c = card();
    const p = await page(
      answering(detail(c, { prompt: { empty: false, dialog: true, working: false, inMode: false, exited: false } }), (m, url) =>
        m === 'POST' && url === 'api/sessions/s1/key' ? { status: 200, body: { ok: true } } : undefined,
      ),
      '#/s/s1',
    );
    const before = p.calls.filter((x) => x.url === 'api/sessions/s1').length;
    (p.$('.keys button[data-key="1"]') as HTMLButtonElement).click();
    await p.settle();
    const post = p.calls.find((x) => x.method === 'POST')!;
    expect(post.body).toEqual({ key: '1' });
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(p.calls.filter((x) => x.url === 'api/sessions/s1').length).toBeGreaterThan(before);
  });

  it('shows Esc (interrupt) while working', async () => {
    const c = card({ state: 'working', look: 'working', label: 'WORKING', tone: 'blue', spin: true, group: 'working' });
    const p = await page(answering(detail(c, { prompt: { empty: true, dialog: false, working: true, inMode: false, exited: false } })), '#/s/s1');
    expect(p.visible(p.$('.reply button[data-key="Escape"]'))).toBe(true);
    expect(p.visible(p.$('textarea.reply-text'))).toBe(true);
  });

  it('hides Esc (interrupt) when the hooks say the session is done, even if the screen still shows a spinner', async () => {
    const c = card({ state: 'done' });
    const p = await page(answering(detail(c, { prompt: { empty: true, dialog: false, working: true, inMode: false, exited: false } })), '#/s/s1');
    expect(p.visible(p.$('.reply button[data-key="Escape"]'))).toBe(false);
  });

  it('uses the screen for Esc (interrupt) when the session has no hooks', async () => {
    const c = card({ state: 'unknown' });
    const p = await page(answering(detail(c, { prompt: { empty: true, dialog: false, working: true, inMode: false, exited: false } })), '#/s/s1');
    expect(p.visible(p.$('.reply button[data-key="Escape"]'))).toBe(true);
  });

  it('keeps the typed text and shows the message on a 409', async () => {
    const blocked = '"Fix tests" is working: send it when it is done.';
    const p = await page(
      answering(detail(card()), (m, url) =>
        m === 'POST' && url === 'api/sessions/s1/send' ? { status: 409, body: { error: blocked, code: 'blocked' } } : undefined,
      ),
      '#/s/s1',
    );
    const text = p.$('textarea.reply-text') as HTMLTextAreaElement;
    text.value = 'and now the docs';
    (p.$('.reply button.send') as HTMLButtonElement).click();
    await p.settle();
    const post = p.calls.find((x) => x.method === 'POST')!;
    expect(post.body).toEqual({ text: 'and now the docs' });
    expect(post.credentials).toBe('same-origin');
    expect(text.value).toBe('and now the docs');
    expect(p.$('.view-session .notice')!.textContent).toBe(blocked);
  });

  it('clears the box after a send', async () => {
    const p = await page(
      answering(detail(card()), (m, url) => (m === 'POST' && url === 'api/sessions/s1/send' ? { status: 200, body: { ok: true } } : undefined)),
      '#/s/s1',
    );
    const text = p.$('textarea.reply-text') as HTMLTextAreaElement;
    text.value = 'go on';
    (p.$('.reply button.send') as HTMLButtonElement).click();
    await p.settle();
    expect(text.value).toBe('');
  });

  it('says "Session ended" on a 410 and goes back to the list', async () => {
    const p = await page(
      answering(detail(card()), (m, url) => (m === 'POST' && url === 'api/sessions/s1/send' ? { status: 410, body: { error: 'gone', code: 'ended' } } : undefined)),
      '#/s/s1',
    );
    (p.$('textarea.reply-text') as HTMLTextAreaElement).value = 'hi';
    (p.$('.reply button.send') as HTMLButtonElement).click();
    await p.settle();
    expect(p.$('.ended')!.textContent).toContain('Session ended');
    await new Promise((r) => setTimeout(r, 2200));
    await p.settle();
    expect(p.win.location.hash).toBe('#/');
  });

  it('keeps one poll going when a reply goes while a refresh is under way', async () => {
    let slow = false;
    const p = await page(
      answering(detail(card()), (m, url) => (m === 'POST' && url === 'api/sessions/s1/send' ? { status: 200, body: { ok: true } } : undefined)),
      '#/s/s1',
      { holdTimers: true, delay: (m, url) => (slow && m === 'GET' && url === 'api/sessions/s1' ? 30 : 0) },
    );
    const timers = p.timers!;
    expect(timers.pending).toBe(1);
    slow = true;
    timers.fire();
    (p.$('textarea.reply-text') as HTMLTextAreaElement).value = 'go on';
    (p.$('.reply button.send') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 100));
    await p.settle();
    expect(p.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
    expect(timers.pending).toBe(1);
  });

  it('says "Session ended" when the detail says so', async () => {
    const p = await page(answering(detail(card(), { ended: true })), '#/s/s1');
    expect(p.$('.ended')!.textContent).toContain('Session ended');
  });

  it('follows the card with the same pane when its id changed', async () => {
    const renamed = card({ id: 'abc-session' });
    const p = await page(answering(detail(renamed)));
    p.streams[0].emit('cards', cardsAnswer([card({ id: 'tmux:devdesk:%1' })]));
    await p.settle();
    p.win.location.hash = '#/s/' + encodeURIComponent('tmux:devdesk:%1');
    await p.settle();
    expect(p.$('.view-session .notice')!.textContent).toContain('Looking for this session');
    p.streams[0].emit('cards', cardsAnswer([renamed]));
    await p.settle();
    expect(p.win.location.hash).toBe('#/s/abc-session');
  });
});

describe('new session', () => {
  const folders: FoldersResponse = {
    folders: [
      { dir: '/ws/feat-a', name: 'feat-a', isMain: false },
      { dir: '/ws/main', name: 'main', isMain: true },
    ],
  };
  const starts = (m: string, url: string) => {
    if (m === 'GET' && url === 'api/folders') return { status: 200, body: folders };
    if (m === 'POST' && url === 'api/sessions') return { status: 201, body: { tmuxSession: 'cc-feat-a-1', server: 'devdesk' } };
    return undefined;
  };

  it('starts from the prompt box on top of the list: posts {dir, prompt} with JSON headers and opens the session', async () => {
    const p = await page(starts);
    const pick = p.$('.composer select.folder-pick') as HTMLSelectElement;
    expect([...pick.options].map((o) => [o.value, o.textContent])).toEqual([
      ['/ws/main', 'main (main repo)'],
      ['/ws/feat-a', 'feat-a'],
    ]);
    expect(pick.value).toBe('/ws/main');
    pick.value = '/ws/feat-a';
    (p.$('textarea.prompt') as HTMLTextAreaElement).value = '<script>x</script> add docs';
    (p.$('button.start') as HTMLButtonElement).click();
    await p.settle();
    const post = p.calls.find((x) => x.method === 'POST')!;
    expect(post.url).toBe('api/sessions');
    expect(post.body).toEqual({ dir: '/ws/feat-a', prompt: '<script>x</script> add docs' });
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.credentials).toBe('same-origin');
    expect((p.$('textarea.prompt') as HTMLTextAreaElement).value).toBe('');
    p.streams[0].emit('cards', cardsAnswer([card({ id: 'new-1', tmuxSession: 'cc-feat-a-1' })]));
    await p.settle();
    expect(p.win.location.hash).toBe('#/s/new-1');
  });

  it('starts with Cmd/Ctrl+Enter', async () => {
    const p = await page(starts);
    const prompt = p.$('textarea.prompt') as HTMLTextAreaElement;
    prompt.value = 'go';
    prompt.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await p.settle();
    expect(p.calls.find((x) => x.method === 'POST')?.body).toEqual({ dir: '/ws/main', prompt: 'go' });
  });

  it("doesn't open the new session if another one was opened while it started", async () => {
    const p = await page(starts);
    (p.$('button.start') as HTMLButtonElement).click();
    await p.settle();
    p.win.location.hash = '#/s/s1';
    await p.settle();
    p.streams[0].emit('cards', cardsAnswer([card(), card({ id: 'new-1', pane: '%9', tmuxSession: 'cc-feat-a-1' })]));
    await p.settle();
    expect(p.win.location.hash).toBe('#/s/s1');
  });

  it('asks for the folders once, however often the list is shown', async () => {
    const p = await page(starts);
    p.win.location.hash = '#/s/s1';
    await p.settle();
    p.win.location.hash = '#/';
    await p.settle();
    expect(p.calls.filter((x) => x.url === 'api/folders')).toHaveLength(1);
  });

  it('#/new shows the list with the prompt box focused', async () => {
    const p = await page(starts, '#/new');
    expect(p.doc.activeElement).toBe(p.$('textarea.prompt'));
    expect(p.win.location.hash).toBe('#/');
    expect(p.visible(p.$('.view-list'))).toBe(true);
  });

  it('polls once every 2 s while the new session has not shown up', async () => {
    const p = await page(
      (m, url) => {
        if (m === 'GET' && url === 'api/sessions') return { status: 200, body: cardsAnswer([card()]) };
        return starts(m, url);
      },
      '#/',
      { holdTimers: true },
    );
    (p.$('button.start') as HTMLButtonElement).click();
    await p.settle();
    const timers = p.timers!;
    expect(timers.pending).toBe(1);
    for (let i = 0; i < 4; i++) {
      timers.fire();
      await p.settle();
      expect(timers.pending).toBe(1);
      p.streams[0].emit('cards', cardsAnswer([card()]));
      expect(timers.pending).toBe(1);
    }
    expect(p.calls.filter((x) => x.method === 'GET' && x.url === 'api/sessions')).toHaveLength(4);
  });

  it('shows the error and keeps the prompt when Start fails', async () => {
    const p = await page((m, url) => {
      if (m === 'GET' && url === 'api/folders') return { status: 200, body: folders };
      if (m === 'POST') return { status: 400, body: { error: 'Not an allowed folder.', code: 'bad-request' } };
      return undefined;
    });
    (p.$('textarea.prompt') as HTMLTextAreaElement).value = 'keep me';
    (p.$('button.start') as HTMLButtonElement).click();
    await p.settle();
    expect(p.$('.composer .notice')!.textContent).toBe('Not an allowed folder.');
    expect((p.$('textarea.prompt') as HTMLTextAreaElement).value).toBe('keep me');
  });
});

describe('prompt box tools', () => {
  const folders: FoldersResponse = { folders: [{ dir: '/ws/main', name: 'main', isMain: true }] };
  const info: ComposerResponse = {
    commands: [
      { name: 'model', description: 'Set the model', origin: 'built-in', category: 'A', argumentHint: '[model]' },
      { name: 'clear', description: 'Clear the prompt box', origin: 'built-in', category: 'A' },
      { name: 'compact', description: 'Summarize', origin: 'built-in', category: 'C' },
      { name: 'plan', description: 'Plan mode', origin: 'built-in', category: 'B', argumentHint: '<task>' },
      { name: 'superpowers:brainstorming', description: 'Design first', origin: 'superpowers', aliases: ['brainstorming'] },
    ],
    models: [
      { value: 'Default', label: 'Default', description: '', efforts: ['low', 'high'] },
      { value: 'global.opus', label: 'Opus', description: 'Opus 5.5', efforts: ['low', 'high', 'max'] },
      { value: 'router', label: 'Router', description: '', efforts: [] },
    ],
    modes: [
      { name: 'Auto', description: 'auto' },
      { name: 'Plan', description: 'plan' },
    ],
    defaultMode: 'Auto',
    planMode: 'Plan',
    listing: false,
  };
  const answers = (m: string, url: string) => {
    if (m === 'GET' && url === 'api/folders') return { status: 200, body: folders };
    if (m === 'GET' && url === 'api/composer?dir=%2Fws%2Fmain') return { status: 200, body: info };
    if (m === 'POST' && url === 'api/sessions') return { status: 201, body: { tmuxSession: 'cc-main-1', server: 'devdesk' } };
    return undefined;
  };
  type Page = Awaited<ReturnType<typeof page>>;
  const box = (p: Page) => p.$('textarea.prompt') as HTMLTextAreaElement;
  const type = (p: Page, text: string) => {
    const prompt = box(p);
    prompt.focus();
    prompt.value = text;
    prompt.setSelectionRange(text.length, text.length);
    prompt.dispatchEvent(new p.win.Event('input', { bubbles: true }));
  };
  const press = (p: Page, key: string) => box(p).dispatchEvent(new p.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const pick = (p: Page, label: string, value: string) => {
    const select = p.$(`select[aria-label="${label}"]`) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new p.win.Event('change', { bubbles: true }));
  };
  const startClick = async (p: Page) => {
    (p.$('button.start') as HTMLButtonElement).click();
    await p.settle();
  };
  const posted = (p: Page) => p.calls.find((x) => x.method === 'POST')?.body;

  it('opens the / menu as you type, filters it, and Tab or Enter puts the command in the box', async () => {
    const p = await page(answers);
    type(p, '/');
    expect(p.visible(p.$('.slash-menu'))).toBe(true);
    expect(p.$$('.slash-row .slash-name').map((e) => e.textContent)).toContain('/superpowers:brainstorming');
    type(p, '/brain');
    expect(p.$$('.slash-row .slash-name').map((e) => e.textContent)).toEqual(['/superpowers:brainstorming']);
    press(p, 'Tab');
    expect(box(p).value).toBe('/superpowers:brainstorming ');
    expect(p.visible(p.$('.slash-menu'))).toBe(false);
    type(p, '/mo');
    expect(p.$('.slash-row.active .slash-hint')!.textContent).toBe('[model]');
    press(p, 'Enter');
    expect(box(p).value).toBe('/model ');
    expect(posted(p)).toBeUndefined();
  });

  it('moves with the arrows and closes with Escape', async () => {
    const p = await page(answers);
    type(p, '/');
    const first = p.$('.slash-row.active')!.textContent;
    press(p, 'ArrowDown');
    expect(p.$('.slash-row.active')!.textContent).not.toBe(first);
    press(p, 'Escape');
    expect(p.visible(p.$('.slash-menu'))).toBe(false);
  });

  it('the / button opens the menu (for a phone keyboard)', async () => {
    const p = await page(answers);
    (p.$('button.slash-button') as HTMLButtonElement).click();
    expect(box(p).value).toBe('/');
    expect(p.visible(p.$('.slash-menu'))).toBe(true);
  });

  it('posts the mode, model and effort picked in the pills, and keeps them for the next visit', async () => {
    const p = await page(answers);
    expect([...(p.$('select[aria-label="Model"]') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Model', 'Opus', 'Router']);
    pick(p, 'Mode', 'Plan');
    pick(p, 'Model', 'global.opus');
    expect([...(p.$('select[aria-label="Effort"]') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['Default', 'low', 'high', 'max']);
    pick(p, 'Effort', 'max');
    type(p, 'go');
    await startClick(p);
    expect(posted(p)).toEqual({ dir: '/ws/main', prompt: 'go', mode: 'Plan', model: 'global.opus', effort: 'max' });
    expect(JSON.parse(p.win.localStorage.getItem('devdesk.web.choice')!)).toEqual({ mode: 'Plan', model: 'global.opus', effort: 'max' });
  });

  it('hides the effort pill for a model without effort, and resets the effort', async () => {
    const p = await page(answers);
    pick(p, 'Effort', 'high');
    pick(p, 'Model', 'router');
    expect(p.visible(p.$('select[aria-label="Effort"]'))).toBe(false);
    type(p, 'go');
    await startClick(p);
    expect(posted(p)).toEqual({ dir: '/ws/main', prompt: 'go', model: 'router' });
  });

  it('/model sets the pill instead of starting, /compact says where it works, /plan starts in plan mode', async () => {
    const p = await page(answers);
    type(p, '/model opus');
    await startClick(p);
    expect((p.$('select[aria-label="Model"]') as HTMLSelectElement).value).toBe('global.opus');
    expect(box(p).value).toBe('');
    expect(p.$('.composer .notice')!.textContent).toBe('Model: Opus.');
    type(p, '/compact');
    press(p, 'Escape');
    await startClick(p);
    expect(p.$('.composer .notice')!.textContent).toContain('works in a running session');
    expect(posted(p)).toBeUndefined();
    type(p, '/plan add a cache');
    await startClick(p);
    expect(posted(p)).toEqual({ dir: '/ws/main', prompt: 'add a cache', mode: 'Plan', model: 'global.opus' });
  });
});

describe('list beside a session', () => {
  it('keeps the list, its prompt box text and the open card marked while a session is open', async () => {
    const p = await page((m, url) => (m === 'GET' && url === 'api/sessions/s2' ? { status: 200, body: detail(card({ id: 's2' })) } : undefined));
    p.streams[0].emit('cards', cardsAnswer([card(), card({ id: 's2', title: 'Second' })]));
    await p.settle();
    const listEl = p.$('.view-list')!;
    (p.$('textarea.prompt') as HTMLTextAreaElement).value = 'half typed';
    p.win.location.hash = '#/s/s2';
    await p.settle();
    expect(p.$('.shell')!.classList.contains('has-session')).toBe(true);
    expect(p.$('.view-list')).toBe(listEl);
    expect(p.$('.view-session')).not.toBeNull();
    expect(p.$('a.card[aria-current="page"]')!.getAttribute('href')).toBe('#/s/s2');
    p.win.location.hash = '#/';
    await p.settle();
    expect(p.$('.shell')!.classList.contains('has-session')).toBe(false);
    expect(p.$('.view-session')).toBeNull();
    expect(p.$('a.card[aria-current]')).toBeNull();
    expect((p.$('textarea.prompt') as HTMLTextAreaElement).value).toBe('half typed');
  });
});

describe('settings and the experimental terminal', () => {
  it('has a gear on the list, and saves the view for this browser', async () => {
    const p = await page((m, url) => (url === 'api/settings' ? { status: 200, body: { sessionView: 'transcript' } } : undefined));
    expect(p.$('a.gear')!.getAttribute('href')).toBe('#/settings');
    p.win.location.hash = '#/settings';
    await p.settle();
    const radios = p.$$('input[name="view"]') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['', 'transcript', 'terminal-experimental']);
    expect(radios[0].checked).toBe(true);
    expect(p.$('label.setting-option .setting-name')!.textContent).toBe('Default: Transcript');
    radios[2].checked = true;
    radios[2].dispatchEvent(new p.win.Event('change'));
    expect(p.win.localStorage.getItem('devdesk.web.sessionView')).toBe('terminal-experimental');
    radios[0].checked = true;
    radios[0].dispatchEvent(new p.win.Event('change'));
    expect(p.win.localStorage.getItem('devdesk.web.sessionView')).toBeNull();
  });

  it('shows one option per row, and OK goes back to the page Settings was opened from', async () => {
    const p = await page((m, url) => (url === 'api/settings' ? { status: 200, body: { sessionView: 'transcript' } } : undefined), '#/s/s1');
    await p.settle();
    p.win.location.hash = '#/settings';
    await p.settle();
    expect(p.$$('.setting-options > label.setting-option')).toHaveLength(3);
    (p.$('.settings-actions button') as HTMLButtonElement).click();
    await p.settle();
    expect(p.win.location.hash).toBe('#/s/s1');
    expect(p.$('.view-settings')).toBeNull();
  });

  it("opens a session as the terminal when the daemon's default says so, and types into it", async () => {
    const writes: string[] = [];
    let onData: ((d: string) => void) | undefined;
    const p = await page(
      (m, url) => {
        if (url === 'api/settings') return { status: 200, body: { sessionView: 'terminal-experimental' } };
        if (m === 'POST' && url === 'api/sessions/s1/term/input') return { status: 200, body: { ok: true } };
        return undefined;
      },
      '#/s/s1',
    );
    await p.settle();
    expect(p.$('.view-term')).not.toBeNull();
    const script = p.$('script[src="term.js"]')!;
    expect(script).not.toBeNull();
    expect(p.$('link[href="term.css"]')).not.toBeNull();
    class FakeTerminal {
      cols = 50;
      rows = 20;
      loadAddon() {}
      open() {}
      focus() {}
      dispose() {}
      write(b: Uint8Array) {
        writes.push(Buffer.from(b).toString('utf8'));
      }
      onData(fn: (d: string) => void) {
        onData = fn;
      }
    }
    class FakeFit {
      fit() {}
    }
    (p.win as unknown as { DevdeskXterm: unknown }).DevdeskXterm = { Terminal: FakeTerminal, FitAddon: FakeFit };
    script.dispatchEvent(new p.win.Event('load'));
    await p.settle();
    const term = p.streams.find((s) => s.url.startsWith('api/sessions/s1/term'))!;
    expect(term.url).toBe('api/sessions/s1/term?cols=50&rows=20');
    for (const fn of term.listeners.get('data') ?? []) fn({ data: Buffer.from('héllo').toString('base64') });
    expect(writes).toEqual(['héllo']);
    term.emit('hello', { term: 'abcdefgh1234' });
    onData!('x');
    await p.settle();
    expect(p.calls.find((c) => c.url === 'api/sessions/s1/term/input')?.body).toEqual({ term: 'abcdefgh1234', data: 'x' });
    // Ctrl from the key bar turns the next key into a control character.
    p.$('button.tkey[aria-pressed]')!.click();
    onData!('c');
    await p.settle();
    const typed = p.calls.filter((c) => c.url === 'api/sessions/s1/term/input').map((c) => (c.body as { data: string }).data);
    expect(typed).toEqual(['x', String.fromCharCode(3)]);
    term.emit('end', { reason: 'The session ended.' });
    await p.settle();
    expect(p.$('.term-notice')!.textContent).toBe('The session ended.');
    expect(term.readyState).toBe(2);
  });
});

describe('index.html', () => {
  it('has no inline script or style (CSP default-src self)', () => {
    const html = readFileSync(join(PAGE, 'index.html'), 'utf8');
    const d = new JSDOM(html).window.document;
    expect([...d.querySelectorAll('script')].map((s) => [s.getAttribute('src'), s.textContent])).toEqual([['app.js', '']]);
    expect(d.querySelectorAll('style, [style]').length).toBe(0);
    expect(d.querySelector('link[rel="stylesheet"]')!.getAttribute('href')).toBe('app.css');
    expect(d.querySelector('#app')).not.toBeNull();
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('cssColor', () => {
  it('maps the xterm palette', () => {
    expect(cssColor(1)).toBe('var(--ansi-1)');
    expect(cssColor(16)).toBe('#000000');
    expect(cssColor(196)).toBe('#ff0000');
    expect(cssColor(231)).toBe('#ffffff');
    expect(cssColor(232)).toBe('#080808');
    expect(cssColor(255)).toBe('#eeeeee');
    expect(cssColor('#a1b2c3')).toBe('#a1b2c3');
    expect(cssColor('red;background:url(x)')).toBeUndefined();
    expect(cssColor(256)).toBeUndefined();
    expect(cssColor(undefined)).toBeUndefined();
  });
});

describe('fitLine', () => {
  it("drops the pane's trailing padding, so a wrapped line adds no blank rows", () => {
    expect(fitLine([{ text: '> hi' }, { text: '      ' }])).toEqual({ spans: [{ text: '> hi' }], rule: false });
    expect(fitLine([{ text: 'a b   ' }])).toEqual({ spans: [{ text: 'a b' }], rule: false });
  });

  it('keeps trailing spaces that are drawn (a background or inverse bar)', () => {
    const bar = [{ text: 'mode ' }, { text: '    ', bg: 4 }];
    expect(fitLine(bar)).toEqual({ spans: bar, rule: false });
    expect(fitLine([{ text: ' x  ', inverse: true }]).spans).toEqual([{ text: ' x  ', inverse: true }]);
  });

  it('marks a line of box-drawing rules, which is clipped to the width instead of wrapped', () => {
    expect(fitLine([{ text: '────────', fg: 8 }, { text: '  ' }]).rule).toBe(true);
    expect(fitLine([{ text: '╰──────╯' }]).rule).toBe(true);
    expect(fitLine([{ text: '╭──── Claude ────╮' }]).rule).toBe(false);
    expect(fitLine([{ text: '--' }]).rule).toBe(false);
    expect(fitLine([]).rule).toBe(false);
  });
});
