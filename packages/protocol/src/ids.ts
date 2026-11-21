/** Short, URL-safe, time-sortable ids: `<base36 ms>-<6 random>` (e.g. `m9x1k2q-7f3a1z`). */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  let r = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(6);
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const b of bytes) r += alphabet[b % alphabet.length];
  return `${prefix}${t}-${r}`;
}

/**
 * A credential (a resume token, a stream token): 24 crypto-random bytes as URL-safe base64 — 192 bits,
 * nothing of the clock in it. `newId` is for ids (sortable, short); never for a secret.
 */
export function newToken(bytes = 24): string {
  const a = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('no secure random source');
  c.getRandomValues(a);
  // URL-safe base64 by hand (no btoa in every runtime the protocol is typed for).
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = '';
  for (let i = 0; i < a.length; i += 3) {
    const n = (a[i]! << 16) | ((a[i + 1] ?? 0) << 8) | (a[i + 2] ?? 0);
    s += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    if (i + 1 < a.length) s += alphabet[(n >> 6) & 63]!;
    if (i + 2 < a.length) s += alphabet[n & 63]!;
  }
  return s;
}

/** An https:// link of a sane size, or null: what a link given by a client may be before it is kept and shown to others. */
export function httpsLink(v: unknown, max = 500): string | null {
  if (typeof v !== 'string' || !v || v.length > max) return null;
  // https://host[/path][?query][#hash] — a host of letters, digits, dots and dashes; nothing that is not a URL (no javascript:, no spaces, no control characters).
  return /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s\u0000-\u001f]*)?$/.test(v) ? v : null;
}

/** File-system / Drive safe name: keeps letters (any script), digits, space, dash, underscore and dot. */
export function safeName(input: string, fallback = 'untitled'): string {
  const cleaned = input
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
