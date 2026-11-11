import type { BuildResult } from 'esbuild';

export function webPage(root: string): Promise<{ html: string; js: string; css: string }>;
export function webBuild(root: string, options: { outdir: string; write?: boolean }): Promise<BuildResult>;
