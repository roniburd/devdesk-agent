#!/usr/bin/env node
// A stand-in for the Claude Code CLI, for the e2e tests and manual checks of the Claude Board. It never calls a model.
//
// Every run appends one JSON line { event: 'run', argv, cwd, pid, time } to $DEVDESK_FAKE_CLAUDE_LOG (default
// $TMPDIR/devdesk-fake-claude.jsonl). Then:
// - `-p --input-format stream-json`: answers the `initialize` control request (matched by request_id) with
//   ../../test/fixtures/initialize.json (Claude Code 2.1.316's real answer: 112 commands, 18 models), then after
//   $DEVDESK_FAKE_CLAUDE_CHANGED_MS (default 300) a `system/commands_changed` event with one more command,
//   `fake-mcp:late-command`. Any other control request gets an empty success. Exits when stdin closes.
// - `-p <prompt>`: prints a line and exits.
// - otherwise (interactive, as tmux runs it): draws Claude's prompt box (a rule, `❯ ` and what is typed, a rule) so
//   `claudePromptIsEmpty` reads it, shows the first prompt (the argument after `--`, or the last one) and each submitted line, and logs each
//   line as { event: 'line', text, pid }. Ctrl+C exits.
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const LOG = process.env.DEVDESK_FAKE_CLAUDE_LOG || join(tmpdir(), 'devdesk-fake-claude.jsonl');
const argv = process.argv.slice(2);
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ ...entry, pid: process.pid, time: Date.now() })}\n`);
log({ event: 'run', argv, cwd: process.cwd() });

const fixture = () => JSON.parse(readFileSync(new URL('../../test/fixtures/initialize.json', import.meta.url), 'utf8'));
const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

// Like the real CLI's option parser: a word that starts with '-' before `--` is an option, so a prompt that starts
// with '-' (and is not behind `--`) is refused.
const end = argv.indexOf('--');
const options = end < 0 ? argv : argv.slice(0, end);
const notOption = options.find((a) => /^-/.test(a) && /\s/.test(a));
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
  const first = end < 0 ? argv.at(-1) : argv[end + 1];
  if (first && (end >= 0 || !first.startsWith('-'))) seen.push(`> ${first}`);
  let typed = '';
  const rule = `\x1b[38;5;244m${'─'.repeat(40)}\x1b[39m`;
  const draw = () => {
    process.stdout.write(`\x1b[2J\x1b[H fake Claude (pid ${process.pid})\r\n`);
    for (const line of seen.slice(-10)) process.stdout.write(`${line}\r\n`);
    process.stdout.write(`${rule}\r\n❯ ${typed}\x1b[7m \x1b[0m\r\n${rule}\r\n`);
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === '\x03') process.exit(0);
      if (ch === '\x1b') {
        // An escape sequence (arrow keys): skipped.
        const m = /^\x1b(\[[0-9;?]*[A-Za-z~]|.)?/.exec(chunk.slice(i));
        i += (m?.[0].length ?? 1) - 1;
      } else if (ch === '\r' || ch === '\n') {
        if (typed) {
          log({ event: 'line', text: typed });
          seen.push(`> ${typed}`);
        }
        typed = '';
      } else if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1);
      else if (ch >= ' ') typed += ch;
    }
    draw();
  });
  draw();
}
