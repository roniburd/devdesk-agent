import { type CliListing, CliStreamReader, INITIALIZE_REQUEST } from './core/cliStream';
import { shellCommand, spawnLoginShell } from './core/shellRun';
import { log } from './log';

/** The CLI gets this long to answer and finish loading (it loads plugins and MCP servers first). */
const LIST_TIMEOUT_MS = 30_000;
/** After the answer, `commands_changed` events (late MCP and plugin commands) are read until none came for this long. */
const QUIET_MS = 1_500;
/** After stdin is closed, the CLI gets this long to exit before it is killed. */
const EXIT_GRACE_MS = 2_000;
/**
 * `-p` reads requests on stdin and answers in JSON lines; no hooks run (DevDesk's status hook would list a session that
 * is not one) and nothing is saved. No prompt is sent, so no model is called.
 */
const LIST_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}', '--no-session-persistence'];

/**
 * What `claude` (shell syntax, see `claudeInvocation`) offers in `cwd`, exactly as it lists them: its commands (built-ins,
 * skills, plugins', the project's, MCP prompts) and its model picker's rows. Runs in a login shell, as sessions do. Only
 * for trusted folders: the CLI loads the project's settings. Resolves once no `commands_changed` came for 1.5 s after
 * the answer (at the timeout, with what came; undefined without an answer); `onUpdate` sees each listing as it arrives.
 */
export function listClaude(claude: string, cwd: string, onUpdate?: (listing: CliListing) => void): Promise<CliListing | undefined> {
  return new Promise((resolve) => {
    const child = spawnLoginShell(shellCommand(claude, LIST_ARGS), cwd);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const reader = new CliStreamReader();
    let errors = '';
    let done = false;
    let quiet: NodeJS.Timeout | undefined;
    const finish = (why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(quiet);
      reader.end();
      const listing = reader.listing;
      // Closing stdin ends a stream-json CLI; one that does not exit is killed.
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), EXIT_GRACE_MS);
      child.on('close', () => clearTimeout(kill));
      if (!listing) log.warn(`cannot list Claude's commands in ${cwd}: ${reader.error ?? why}${errors.trim() ? `: ${errors.trim().split('\n').pop()}` : ''}`);
      resolve(listing);
    };
    const timer = setTimeout(() => finish(`no answer in ${LIST_TIMEOUT_MS / 1000}s`), LIST_TIMEOUT_MS);
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      const events = reader.push(chunk);
      if (!events.length || !reader.listing) return;
      onUpdate?.(reader.listing);
      clearTimeout(quiet);
      quiet = setTimeout(() => finish(), QUIET_MS);
    });
    child.stderr.on('data', (chunk: string) => (errors = (errors + chunk).slice(-2000)));
    child.on('error', (err) => finish(err.message));
    // `close`, not `exit`: by then all of its output has been read.
    child.on('close', (code) => finish(`it exited (${code})`));
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
  });
}
