/** `path` without trailing slashes (`/` stays `/`). */
export const trimSlashes = (path: string): string => path.replace(/(.)\/+$/, '$1');

/** True when `path` is `dir` or below it (`dir` without a trailing slash; `/` holds every absolute path). */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`);
}
