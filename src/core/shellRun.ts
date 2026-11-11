import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { shellQuote } from './shell';

/** How a command ended: whether it succeeded, and its stdout, stderr and (without stderr) error message. */
export interface CommandResult {
  ok: boolean;
  output: string;
}

/** Runs `file` with `args`; never rejects. `env` is added to the extension host's environment. */
export function runCommand(file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}${err && !stderr ? err.message : ''}` }),
    );
  });
}

/** The error `execText` rejects with: `(stderr || err.message).trim()`, and whether the program was killed (for example on timeout). */
export class ExecError extends Error {
  constructor(message: string, readonly killed: boolean) {
    super(message);
  }
}

/**
 * Runs `file` with `args` and resolves with its stdout; rejects with an `ExecError` carrying the trimmed stderr, or the
 * error message when there is no stderr. The rejecting variant of `runCommand`.
 */
export function execText(file: string, args: string[], opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const execOpts = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
  };
  return new Promise((resolve, reject) => {
    execFile(file, args, execOpts, (err, stdout, stderr) => {
      if (err) reject(new ExecError((stderr || err.message).trim(), !!err.killed));
      else resolve(stdout);
    });
  });
}

/** `bin` (shell syntax, for example `$HOME/.toolbox/bin/claude`) followed by `args`, each quoted. */
export function shellCommand(bin: string, args: readonly string[]): string {
  return `${bin} ${args.map(shellQuote).join(' ')}`;
}

/**
 * A one-shot `claude -p --bare` call (shell syntax): `model` with `systemPrompt`, no tools or MCP servers, JSON output,
 * nothing saved as a session. The input goes on stdin.
 */
export function headlessClaudeCommand(claude: string, model: string, systemPrompt: string): string {
  return shellCommand(claude, [
    '-p', '--bare', '--model', model, '--output-format', 'json', '--system-prompt', systemPrompt,
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
  ]);
}

/** Runs `command` (shell syntax) in a login shell, as Claude sessions run, so PATH and the toolbox are there. */
export function spawnLoginShell(command: string, cwd: string, env?: Readonly<Record<string, string>>): ChildProcessWithoutNullStreams {
  return spawn(process.env.SHELL || '/bin/sh', ['-lc', `exec ${command}`], { cwd, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) });
}
