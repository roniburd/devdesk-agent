import { execFile } from 'node:child_process';
import { basename } from 'node:path';

/** Parent → children and pid → command name, from `ps -A -o pid=,ppid=,comm=`. */
export interface ProcessTable {
  children: Map<number, number[]>;
  comm: Map<number, string>;
}

export function parseProcessTable(out: string): ProcessTable {
  const children = new Map<number, number[]>();
  const comm = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    comm.set(pid, basename(m[3]));
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return { children, comm };
}

/** The process table, or undefined when `ps` fails. */
export function listProcesses(): Promise<ProcessTable | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (err, stdout) =>
      resolve(err ? undefined : parseProcessTable(stdout)),
    );
  });
}

/** `pid` or the first descendant (a few levels down, past wrapper shells) that satisfies `match`; undefined when none does. */
export function findDescendant(table: ProcessTable, pid: number, match: (comm: string) => boolean, depth = 4): number | undefined {
  let level = [pid];
  for (let d = 0; d <= depth && level.length; d++) {
    const found = level.find((p) => match(table.comm.get(p) ?? ''));
    if (found !== undefined) return found;
    level = level.flatMap((p) => table.children.get(p) ?? []);
  }
  return undefined;
}

