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

/** `bin` (shell syntax, for example `$HOME/.toolbox/bin/claude`) followed by `args`, each quoted. */
export function shellCommand(bin: string, args: readonly string[]): string {
  return `${bin} ${args.map(shellQuote).join(' ')}`;
}

/** Runs `command` (shell syntax) in a login shell, as Claude sessions run, so PATH and the toolbox are there. */
export function spawnLoginShell(command: string, cwd: string): ChildProcessWithoutNullStreams {
  return spawn(process.env.SHELL || '/bin/sh', ['-lc', `exec ${command}`], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}
