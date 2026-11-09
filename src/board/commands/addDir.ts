import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isRelativeDirArg, resolveDirArg } from '../../core/launchFlags';
import { keepText } from '../outcomes';
import type { Handler } from '../types';

/**
 * `/add-dir <path>` lets the next session the board starts also work in a directory (`--add-dir`): it shows as a chip
 * in the box until that launch (or until its × is clicked). `~` is the home directory; a relative path is taken from
 * where the session will run, so it is refused for a new worktree (which does not exist yet: the main checkout's
 * directory would be added instead). The directory must exist.
 */
export const addDir: Handler = async ({ submission, choice, composer, ui }) => {
  if (choice.where === 'new' && isRelativeDirArg(submission.arg, homedir())) {
    return keepText(ui, `A new worktree does not exist yet, so /add-dir ${submission.arg.trim()} cannot be taken from it: type an absolute path or one under ~.`);
  }
  const dir = resolveDirArg(submission.arg, homedir(), composer.dirOf(choice.where) ?? homedir());
  if (!dir) {
    return keepText(ui, 'Type a directory after /add-dir: /add-dir <path> lets the next session also work there.');
  }
  const isDir = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) {
    return keepText(ui, { text: `${dir} is not a directory.`, tone: 'error' });
  }
  const added = composer.addLaunchDir(dir);
  ui.notice({ text: added ? `The next session the board starts can also work in ${dir}.` : `${dir} is already added to the next session.`, tone: 'info' });
  return { clear: true };
};
