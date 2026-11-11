#!/usr/bin/env node
// A stand-in for the Claude Code CLI, for the e2e tests and manual checks of the Claude Board. It never calls a model.
//
// Every run appends one JSON line { event: 'run', argv, cwd, env, pid, time } (env: CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER and DEVDESK_E2E_ACCOUNT, when set) to $DEVDESK_FAKE_CLAUDE_LOG (default
// $TMPDIR/devdesk-fake-claude.jsonl), except `--version`, which prints a version and exits (DevDesk asks it to pick
// the hook events it installs). Then:
// - `-p --input-format stream-json`: answers the `initialize` control request (matched by request_id) with
//   ../../test/fixtures/initialize.json (Claude Code 2.1.316's real answer: 112 commands, 18 models), then after
//   $DEVDESK_FAKE_CLAUDE_CHANGED_MS (default 300) a `system/commands_changed` event with one more command,
//   `fake-mcp:late-command`. Any other control request gets an empty success. Exits when stdin closes.
// - `-p <prompt>`: prints a line and exits.
// - otherwise (interactive, as tmux runs it): draws Claude's prompt box (a rule, `❯`, a no-break space and what is typed, a rule, the cursor parked at the caret) so
//   `claudePromptIsEmpty` reads it, shows the first prompt (the argument after `--`, or the last one) and each submitted line, and logs each
//   line as { event: 'line', text, pasted, pid } (`pasted`: some of it came in a bracketed paste, which it turns on
//   as Claude does; a line break in a paste stays in the line). `--prefill <draft>` starts with the draft typed at the
//   prompt, not submitted. Ctrl+C exits. Like Claude Code 2.1.295+, it probes for the Program Status
//   Protocol (`ESC]7501;?`); once answered (DevDesk's relay, devdesk.sessions.programStatus), it reports `idle`, or
//   `working` when the first prompt holds `e2e-status-working`, `blocked` on a permission ("approve Bash: e2e-merge")
//   once `e2e: ask permission` is submitted, and `done` once `e2e: finish` is.
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** What Claude's composer has after `❯`: a no-break space (`claudePromptIsEmpty` looks for it). */
const COMPOSER_SPACE = '\u00a0';
const LOG = process.env.DEVDESK_FAKE_CLAUDE_LOG || join(tmpdir(), 'devdesk-fake-claude.jsonl');
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.316 (Claude Code)\n');
  process.exit(0);
}
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ ...entry, pid: process.pid, time: Date.now() })}\n`);
// The environment DevDesk sets for a Claude account and its launch settings (never anything else: no credentials).
const env = Object.fromEntries(['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'DEVDESK_E2E_ACCOUNT'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
log({ event: 'run', argv, cwd: process.cwd(), env });

const fixture = () => JSON.parse(readFileSync(new URL('../../test/fixtures/initialize.json', import.meta.url), 'utf8'));
const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

// Like the real CLI's option parser: a word that starts with '-' before `--` is an option, so a prompt that starts
// with '-' (and is not behind `--`) is refused.
const end = argv.indexOf('--');
const options = end < 0 ? argv : argv.slice(0, end);
// The value of `--prefill` is never an option, whatever it starts with.
const notOption = options.find((a, i) => /^-/.test(a) && /\s/.test(a) && options[i - 1] !== '--prefill');
if (notOption !== undefined) {
  process.stderr.write(`error: unknown option '${notOption}'\n`);
  process.exit(1);
}

if (argv.includes('-p') && argv.includes('stream-json')) streamJson();
else if (argv.includes('-p')) {
  process.stdout.write(`fake Claude -p: ${argv.at(-1)}\n`);
} else interactive();

function streamJson() {
  const changedMs = Number(process.env.DEVDESK_FAKE_CLAUDE_CHANGED_MS ?? 300);
  write({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m?.type !== 'control_request') return;
    if (m.request?.subtype !== 'initialize') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      return;
    }
    const answer = fixture();
    write({ ...answer, response: { ...answer.response, request_id: m.request_id } });
    setTimeout(() => {
      const late = { name: 'fake-mcp:late-command', description: '(fake-mcp) A command that loads late, like an MCP prompt', argumentHint: '', aliases: [] };
      write({ type: 'system', subtype: 'commands_changed', commands: [...answer.response.response.commands, late], session_id: 'fake', uuid: 'fake' });
    }, changedMs);
  });
  lines.on('close', () => setTimeout(() => process.exit(0), 10));
}

function interactive() {
  const seen = [];
  // `--prefill <draft>`: the draft is typed at the prompt, not submitted.
  const prefill = options.indexOf('--prefill');
  const draft = prefill >= 0 ? options[prefill + 1] : undefined;
  const first = end < 0 ? (draft === undefined ? argv.at(-1) : undefined) : argv[end + 1];
  if (first && (end >= 0 || !first.startsWith('-'))) seen.push(`> ${first}`);
  let typed = draft ?? '';
  // Inside a bracketed paste (asked for below, as Claude does), and whether the line being typed got one.
  let pasting = false;
  let pasted = false;
  const rule = `\x1b[38;5;244m${'─'.repeat(40)}\x1b[39m`;
  const draw = () => {
    process.stdout.write(`\x1b[2J\x1b[H fake Claude (pid ${process.pid})\r\n`);
    for (const line of seen.slice(-10)) process.stdout.write(`${line}\r\n`);
    // Like Claude Code 2.1.319: `❯` and a no-break space, the cursor drawn as an inverted cell, and the terminal's own
    // cursor (hidden) parked at the caret: moved back up there once the box is drawn (relative moves, so a screen that
    // scrolled while drawing does not matter), after `❯ ` and what is typed on its last line.
    const caret = 2 + [...(typed.split('\n').at(-1) ?? '')].length;
    process.stdout.write(`${rule}\r\n❯${COMPOSER_SPACE}${typed}\x1b[7m \x1b[0m\r\n${rule}\r\n\x1b[2A\r\x1b[${caret}C`);
  };
  let statusOn = false;
  const report = (body) => statusOn && process.stdout.write(`\x1b]7501;${body}:app=claude-code\x1b\\`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    let chunk = data;
    const reply = /\x1b\]7501;\?:[^\x07\x1b]*(?:\x07|\x1b\\)/.exec(chunk);
    if (reply) {
      chunk = chunk.replace(reply[0], '');
      if (!statusOn) {
        statusOn = true;
        log({ event: 'programStatus' });
        report(first?.includes('e2e-status-working') ? `state=working:msg=${Buffer.from('Running the e2e checks').toString('base64')}` : 'state=idle');
      }
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === '\x03' && !pasting) process.exit(0);
      if (ch === '\x1b') {
        // An escape sequence (arrow keys): skipped; bracketed paste's start and end markers, as Claude reads them.
        const m = /^\x1b(\[[0-9;?]*[A-Za-z~]|.)?/.exec(chunk.slice(i));
        if (m?.[0] === '\x1b[200~') pasting = pasted = true;
        else if (m?.[0] === '\x1b[201~') pasting = false;
        i += (m?.[0].length ?? 1) - 1;
      } else if (pasting && (ch === '\r' || ch === '\n')) typed += '\n';
      else if (ch === '\r' || ch === '\n') {
        if (typed) {
          log({ event: 'line', text: typed, pasted });
          seen.push(`> ${typed.replace(/\n/g, ' ⏎ ')}`);
          if (typed === 'e2e: finish') report('state=done');
          if (typed === 'e2e: ask permission') report(`state=blocked:kind=permission:msg=${Buffer.from('approve Bash: e2e-merge').toString('base64')}`);
        }
        typed = '';
        pasted = false;
      } else if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1);
      else if (ch >= ' ') typed += ch;
    }
    draw();
  });
  process.stdout.write('\x1b]7501;?\x07');
  // Bracketed paste on, as Claude asks for it (tmux's `paste-buffer -p` then marks what it pastes), with palette
  // updates and focus events, and the terminal's cursor hidden (Claude draws its own).
  process.stdout.write('\x1b[?2004h\x1b[?2031h\x1b[?1004h\x1b[?25l');
  draw();
}
