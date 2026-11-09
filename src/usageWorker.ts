import { parentPort } from 'node:worker_threads';
import { UsageReader } from './core/usage';
import { type CountProgress, type CountRequest, countUsage, type UsageSnapshot } from './usageCount';

/*
 * The usage worker (`dist/usageWorker.js`): counts token usage on a thread of its own, so reading every transcript the
 * first time (it can be tens of GB) never blocks the extension host. It keeps its reader between counts, so later
 * counts read only what transcripts appended. One count at a time, in the order asked.
 */

export type ToWorker = { id: number; req: CountRequest };
export type FromWorker =
  | { id: number; type: 'progress'; progress: CountProgress }
  | { id: number; type: 'done'; snapshot: UsageSnapshot }
  | { id: number; type: 'error'; message: string };

const port = parentPort;
if (port) {
  const reader = new UsageReader();
  let queue = Promise.resolve();
  const post = (m: FromWorker) => port.postMessage(m);
  port.on('message', ({ id, req }: ToWorker) => {
    queue = queue.then(async () => {
      try {
        const snapshot = await countUsage(reader, req, (progress) => post({ id, type: 'progress', progress }));
        post({ id, type: 'done', snapshot });
      } catch (err) {
        post({ id, type: 'error', message: (err as Error).message });
      }
    });
  });
}
