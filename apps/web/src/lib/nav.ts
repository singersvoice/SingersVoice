/** Base-path aware links/navigation (GitHub Pages serves the app under /SingersVoice/). */
export function normalizeBase(b: string): string {
  return b.endsWith('/') ? b : `${b}/`;
}

export const BASE = normalizeBase(import.meta.env.BASE_URL || '/');

export const hrefFor = (p: string, base: string): string => normalizeBase(base) + p.replace(/^\//, '');
export const href = (p: string): string => hrefFor(p, BASE);
export const asset = href;

/** Path relative to the app base, always starting with '/'. */
export function relPathFor(fullPath: string, base: string): string {
  const b = normalizeBase(base).replace(/\/$/, '');
  const p = b && fullPath.startsWith(b) ? fullPath.slice(b.length) : fullPath;
  return p || '/';
}
export const relPath = (fullPath: string): string => relPathFor(fullPath, BASE);

let routeFn: ((url: string, replace?: boolean) => void) | null = null;
export function bindRouter(fn: (url: string, replace?: boolean) => void): void {
  routeFn = fn;
}
export function go(p: string, replace = false): void {
  if (routeFn) routeFn(href(p), replace);
  else window.location.assign(href(p));
}
