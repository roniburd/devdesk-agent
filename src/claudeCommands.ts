import type { CliListing } from './core/cliStream';
import { listClaude as listWith } from './core/cliList';
import { log } from './log';

/** `core/cliList.ts`'s `listClaude`, warning in DevDesk's log; `env` (a Claude account's) is added to its environment. */
export function listClaude(claude: string, cwd: string, onUpdate?: (listing: CliListing) => void, env?: Readonly<Record<string, string>>): Promise<CliListing | undefined> {
  return listWith(claude, cwd, onUpdate, log.warn, env);
}
