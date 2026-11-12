import type { CliListing } from './core/cliStream';
import { listClaude as listWith } from './core/cliList';
import { log } from './log';

/** `core/cliList.ts`'s `listClaude`, warning in DevDesk's log. */
export function listClaude(claude: string, cwd: string, onUpdate?: (listing: CliListing) => void): Promise<CliListing | undefined> {
  return listWith(claude, cwd, onUpdate, log.warn);
}
