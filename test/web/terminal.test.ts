import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureCommand,
  ControlParser,
  decodeOutput,
  firstFrame,
  parseControlLine,
  reclaimCommand,
  resizeCommand,
  SEND_KEYS_CHUNK,
  sendKeysCommands,
  termSizeOf,
} from '../../src/core/web/terminal';
import { parseRoute, parseTermInputBody, parseTermResizeBody, isMutating } from '../../src/core/web/routes';
import { TerminalHub } from '../../src/web/terminal';

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('control-mode protocol', () => {
  it('decodes %output octal escapes, backslashes included', () => {
    expect(text(decodeOutput('a\\033[1mb\\015\\012\\134x'))).toBe('a\x1b[1mb\r\n\\x');
    // A backslash not followed by three octal digits is itself.
    expect(text(decodeOutput('a\\9b\\0'))).toBe('a\\9b\\0');
  });

  it('classifies lines', () => {
    expect(parseControlLine('%output %3 hi\\012')).toMatchObject({ kind: 'output', pane: '%3' });
    expect(parseControlLine('%begin 1 2 0')).toEqual({ kind: 'begin' });
    expect(parseControlLine('%end 1 2 0')).toEqual({ kind: 'end', error: false });
    expect(parseControlLine('%error 1 2 0')).toEqual({ kind: 'end', error: true });
    expect(parseControlLine('%exit')).toEqual({ kind: 'exit', reason: '' });
    expect(parseControlLine('%layout-change @1 x')).toEqual({ kind: 'other' });
  });

  it('splits replies from notifications across chunks, skipping the attach reply', () => {
    const got: string[] = [];
    const p = new ControlParser({
      output: (pane, b) => got.push(`out ${pane} ${text(b)}`),
      reply: (lines, error) => got.push(`reply ${error} ${lines.join('|')}`),
      exit: (r) => got.push(`exit ${r}`),
    });
    p.push('%begin 1 1 0\n%end 1 1 0\n%output %1 a\\012\n%beg');
    p.push('in 1 2 1\nline one\n%output %1 not output\n%end 1 2 1\n%begin 1 3 1\nbad\n%error 1 3 1\n%exit detached\n');
    expect(got).toEqual(['out %1 a\n', 'reply false line one|%output %1 not output', 'reply true bad', 'exit detached']);
  });

  it('builds commands only for pane ids', () => {
    expect(resizeCommand({ cols: 40, rows: 20 })).toBe('refresh-client -C 40x20');
    expect(reclaimCommand('%7')).toBe('switch-client -t %7');
    expect(captureCommand('%7')).toBe('capture-pane -p -e -t %7');
    expect(() => captureCommand('=x; kill-server')).toThrow();
    expect(() => sendKeysCommands('%1; kill-server', new Uint8Array([1]))).toThrow();
  });

  it('sends keys as hex, in chunks', () => {
    expect(sendKeysCommands('%2', new TextEncoder().encode('é\r'))).toEqual(['send-keys -t %2 -H c3 a9 0d']);
    const many = sendKeysCommands('%2', new Uint8Array(SEND_KEYS_CHUNK * 2 + 1));
    expect(many).toHaveLength(3);
  });

  it('clamps sizes and refuses non-numbers', () => {
    expect(termSizeOf('80', '30')).toEqual({ cols: 80, rows: 30 });
    expect(termSizeOf(1, 1000)).toEqual({ cols: 20, rows: 200 });
    expect(termSizeOf('x', 3)).toBeUndefined();
    expect(termSizeOf('', 3)).toBeUndefined();
  });

  it('first frame: clear, rows joined by CRLF, cursor placed', () => {
    expect(text(firstFrame(['ab', 'c'], '1 1'))).toBe('\x1b[0m\x1b[H\x1b[2Jab\r\nc\x1b[0m\x1b[2;2H');
    expect(text(firstFrame(['ab'], ''))).toBe('\x1b[0m\x1b[H\x1b[2Jab\x1b[0m');
  });
});

describe('terminal routes', () => {
  it('routes the stream, input, resize, settings and assets', () => {
    expect(parseRoute('GET', '/api/sessions/abc/term?cols=1')).toEqual({ kind: 'term', id: 'abc' });
    expect(parseRoute('POST', '/api/sessions/abc/term')).toEqual({ status: 405 });
    expect(parseRoute('POST', '/api/sessions/abc/term/input')).toEqual({ kind: 'term-input', id: 'abc' });
    expect(parseRoute('GET', '/api/sessions/abc/term/input')).toEqual({ status: 405 });
    expect(parseRoute('POST', '/api/sessions/abc/term/resize')).toEqual({ kind: 'term-resize', id: 'abc' });
    expect(parseRoute('GET', '/api/settings')).toEqual({ kind: 'settings' });
    expect(parseRoute('GET', '/term.js')).toEqual({ kind: 'page', asset: 'termJs' });
    expect(parseRoute('GET', '/term.css')).toEqual({ kind: 'page', asset: 'termCss' });
    expect(isMutating({ kind: 'term-input', id: 'a' })).toBe(true);
    expect(isMutating({ kind: 'term-resize', id: 'a' })).toBe(true);
    expect(isMutating({ kind: 'term', id: 'a' })).toBe(false);
  });

  it('checks the bodies', () => {
    const term = 'abcdefgh1234';
    expect(parseTermInputBody({ term, data: 'x' })).toEqual({ term, data: 'x' });
    expect(parseTermInputBody({ term: 'short', data: 'x' })).toMatchObject({ status: 400 });
    expect(parseTermInputBody({ term, data: '' })).toMatchObject({ status: 400 });
    expect(parseTermInputBody({ term, data: 'x'.repeat(16385) })).toMatchObject({ status: 413 });
    expect(parseTermResizeBody({ term, cols: 50, rows: 10 })).toEqual({ term, cols: 50, rows: 10 });
    expect(parseTermResizeBody({ term, cols: 'a', rows: 10 })).toMatchObject({ status: 400 });
  });
});

let hasTmux = true;
try {
  execFileSync('tmux', ['-V']);
} catch {
  hasTmux = false;
}

describe.skipIf(!hasTmux)('TerminalHub against a real tmux', () => {
  const server = `devdesk-term-test-${process.pid}`;
  const t = (...a: string[]) => execFileSync('tmux', ['-L', server, '-f', '/dev/null', ...a]).toString().trim();
  const wait = async (ok: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await new Promise((r) => setTimeout(r, 30));
  };
  afterEach(() => {
    try {
      t('kill-server');
    } catch {
      // already gone
    }
  });

  it('sizes the window, sends the screen, types, resizes, and ends with the session', async () => {
    t('new-session', '-d', '-s', 'claude', '-x', '200', '-y', '50', 'sh');
    const pane = t('display', '-p', '-t', '=claude:', '#{pane_id}');
    const hub = new TerminalHub({ bin: 'tmux', configFile: '/dev/null', configServer: server, log: () => {} });
    let got = '';
    let ended: string | undefined;
    const id = await hub.open(server, pane, { cols: 40, rows: 20 }, { data: (b) => (got += Buffer.from(b).toString('utf8')), end: (r) => (ended = r) });
    expect(typeof id).toBe('string');
    expect(t('display', '-p', '-t', pane, '#{window_width}x#{window_height}')).toBe('40x20');
    expect(got.startsWith('\x1b[0m\x1b[H\x1b[2J')).toBe(true);
    got = '';
    const term = hub.get(id as string, pane)!;
    expect(hub.get(id as string, '%999')).toBeUndefined();
    await term.input('echo héllo-$((1+1))\r');
    await wait(() => got.includes('héllo-2'));
    expect(got).toContain('héllo-2');
    await term.resize({ cols: 60, rows: 20 });
    expect(t('display', '-p', '-t', pane, '#{window_width}x#{window_height}')).toBe('60x20');
    t('kill-session', '-t', '=claude');
    await wait(() => ended !== undefined);
    expect(ended).toBeDefined();
    expect(hub.size).toBe(0);
  });

  it('refuses past MAX_TERMINALS and closes all', async () => {
    t('new-session', '-d', '-s', 'claude', '-x', '100', '-y', '30', 'sh');
    const pane = t('display', '-p', '-t', '=claude:', '#{pane_id}');
    const hub = new TerminalHub({ bin: 'tmux', log: () => {} });
    const sink = { data: () => {}, end: () => {} };
    for (let i = 0; i < 4; i++) expect(await hub.open(server, pane, { cols: 40, rows: 20 }, sink)).not.toBe('busy');
    expect(await hub.open(server, pane, { cols: 40, rows: 20 }, sink)).toBe('busy');
    hub.closeAll();
    expect(hub.size).toBe(0);
  });
});
