// A fake tmux for the web access daemon test (test/web/daemon.test.ts): answers from the JSON file named by
// DEVDESK_FAKE_TMUX_STATE ({ panes: LIST_FORMAT lines, capture, pid }) and appends each call's arguments (one JSON
// array per line, after -f/-L) to DEVDESK_FAKE_TMUX_LOG.
import { appendFileSync, readFileSync } from 'node:fs';

const SEP = '|^|';
let args = process.argv.slice(2);
while (args[0] === '-f' || args[0] === '-L') args = args.slice(2);
appendFileSync(process.env.DEVDESK_FAKE_TMUX_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.DEVDESK_FAKE_TMUX_STATE, 'utf8'));
const out = (text) => process.stdout.write(text);
switch (args[0]) {
  case 'list-panes':
    out(state.panes.map((l) => `${l}\n`).join(''));
    break;
  case 'capture-pane':
    out(state.capture);
    break;
  case 'display-message':
    out(`${state.pid}${SEP}0${SEP}claude\n`);
    break;
  default:
    break;
}
