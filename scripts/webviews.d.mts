import type { BuildOptions } from 'esbuild';

export const WEBVIEWS: string[];
export function webviewBuild(root: string): BuildOptions & { entryPoints: Record<string, string> };
