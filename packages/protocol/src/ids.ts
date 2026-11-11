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
