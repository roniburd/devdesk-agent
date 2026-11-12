import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROGRAM_STATUS_SCRIPT, PROGRAM_STATUS_SCRIPT_NAME, programStatusWrapper } from './core/programStatus';
import { log } from './log';

const PYTHON = 'python3';
/** Whether `python3` runs (checked once: macOS ships a stub that only offers to install it). */
let pythonRuns: boolean | undefined;

/** The relay script in Claude's config directory, rewritten when it differs from this version's. */
function ensureScript(claudeDir: string): string {
  const path = join(claudeDir, 'devdesk', PROGRAM_STATUS_SCRIPT_NAME);
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== PROGRAM_STATUS_SCRIPT) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, PROGRAM_STATUS_SCRIPT, { mode: 0o755 });
    renameSync(tmp, path);
  }
  return path;
}

/**
 * The command prefix that runs Claude under the Program Status relay (setting `devdesk.sessions.programStatus`),
 * writing to `statusDir`; undefined (Claude runs directly) when Python cannot run or the script cannot be written.
 */
export function programStatusLaunchWrapper(claudeDir: string, statusDir: string): string | undefined {
  if (pythonRuns === undefined) {
    const run = spawnSync(PYTHON, ['-I', '-c', ''], { timeout: 5000, stdio: 'ignore' });
    pythonRuns = run.status === 0;
    if (!pythonRuns) log.warn(`devdesk.sessions.programStatus: ${PYTHON} does not run, so sessions start without the status relay`);
  }
  if (!pythonRuns) return undefined;
  try {
    return programStatusWrapper(PYTHON, ensureScript(claudeDir), statusDir);
  } catch (err) {
    log.warn(`cannot write the Program Status relay script: ${(err as Error).message}`);
    return undefined;
  }
}
