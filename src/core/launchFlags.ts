import { isAbsolute, resolve } from 'node:path';
import { shellQuote } from './shell';

/** The path typed after `/add-dir`: surrounding quotes removed, a leading `~` expanded to `home`; '' when none. */
function dirArgPath(arg: string, home: string): string {
  let p = arg.trim();
  const quoted = /^(['"])(.*)\1$/.exec(p);
  if (quoted) p = quoted[2].trim();
  return p.replace(/^~(?=\/|$)/, home);
}

/**
 * The directory typed after `/add-dir`: surrounding quotes removed, a leading `~` expanded to `home`, and a relative
 * path taken from `base` (where the session will run). Undefined when nothing was typed.
 */
export function resolveDirArg(arg: string, home: string, base: string): string | undefined {
  const p = dirArgPath(arg, home);
  if (!p) return undefined;
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** True when the path typed after `/add-dir` is relative (neither absolute nor under `~`). */
export function isRelativeDirArg(arg: string, home: string): boolean {
  const p = dirArgPath(arg, home);
  return p !== '' && !isAbsolute(p);
}

/** `claude` arguments that let a session also work in `dirs`: `--add-dir '<dir>'` each, in shell syntax. */
export function addDirArgs(dirs: readonly string[]): string {
  return dirs.map((d) => `--add-dir ${shellQuote(d)}`).join(' ');
}
