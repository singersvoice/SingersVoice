/**
 * The singer's own stage backgrounds (24 Nov): the Backgrounds folder — Drive › SingersVoice › Backgrounds, or this
 * device's store — is the record. It holds the pictures the singer uploads from their device and a copy of every
 * built-in picture (seeded once per account, each stamped with the built-in's id, so the folder shows the whole set
 * the singer sees). The picker (components/BackgroundPicker.tsx) lists the built-in pictures (drawn from the bundle:
 * every device has them, and a live meet's shared stage can only name those) and the uploads (drawn from their
 * files, fetched once and kept in IndexedDB), lets the singer upload more, and select and delete any — an upload
 * goes to the Drive bin; a built-in is hidden on this account (`hiddenBackgrounds`, synced with the app settings)
 * and its folder copy binned, until "Restore built-in backgrounds".
 *
 * Uploads are brought down to the stage's size before they go up (at most 1920 px across, WebP where the browser
 * writes it, JPEG otherwise): a phone's photo of several megabytes becomes a few hundred kilobytes.
 */
import type { BackgroundItem, BackgroundsIndex } from '@singersvoice/protocol';
import { signal } from '@preact/signals';
import { idb, STORES } from './idb.ts';
import { asset } from './nav.ts';
import type { BackgroundEntry } from './storage/types.ts';
import { accountUserId, provider } from '../state/session.ts';
import { appSettings, updateApp } from '../state/settings.ts';

/** An upload's id in the app settings and the picker: `mybg:` and the store's id. */
export const MY_BACKGROUND_PREFIX = 'mybg:';
export const isMyBackground = (id: string): boolean => id.startsWith(MY_BACKGROUND_PREFIX);

/** The built-in pictures (public/backgrounds/index.json), once loaded. */
export const stockBackgrounds = signal<BackgroundItem[]>([]);
/** The singer's uploads as picker items (their `src` and `thumb` are object URLs of the picture), null until listed. */
export const myBackgrounds = signal<BackgroundItem[] | null>(null);
/** Whether the Backgrounds folder is being listed or seeded right now (the picker shows it). */
export const backgroundsBusy = signal<string | null>(null);

let stockLoading: Promise<void> | null = null;
export function loadStockBackgrounds(): Promise<void> {
  if (stockLoading) return stockLoading;
  stockLoading = fetch(asset('backgrounds/index.json'))
    .then((r) => r.json() as Promise<BackgroundsIndex>)
    .then((j) => {
      stockBackgrounds.value = j.items;
    })
    .catch(() => {
      stockBackgrounds.value = [];
    });
  return stockLoading;
}

/** The maximum size an upload is brought to (the stage's own). */
const MAX_W = 1920;
const MAX_H = 1080;
const THUMB_W = 320;
const THUMB_H = 180;
/** An upload past this many bytes after scaling is refused (a picture, not a poster). */
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/** A picture scaled to fit the stage, re-encoded (WebP where the browser writes it, JPEG otherwise). */
export async function fitPicture(file: Blob, maxW = MAX_W, maxH = MAX_H): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  try {
    const k = Math.min(1, maxW / bmp.width, maxH / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('No canvas here');
    ctx.drawImage(bmp, 0, 0, w, h);
    const encode = (type: string, q: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));
    let out = await encode('image/webp', 0.86);
    if (!out || out.type !== 'image/webp') out = await encode('image/jpeg', 0.88);
    if (!out) throw new Error('The picture could not be encoded');
    return out;
  } finally {
    bmp.close();
  }
}

/** A 16:9 thumbnail of a picture (cover), as an object URL. */
async function thumbUrl(blob: Blob): Promise<string> {
  try {
    const bmp = await createImageBitmap(blob);
    try {
      const c = document.createElement('canvas');
      c.width = THUMB_W;
      c.height = THUMB_H;
      const ctx = c.getContext('2d');
      if (!ctx) return URL.createObjectURL(blob);
      const k = Math.max(THUMB_W / bmp.width, THUMB_H / bmp.height);
      const w = bmp.width * k;
      const h = bmp.height * k;
      ctx.drawImage(bmp, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
      const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
      return URL.createObjectURL(out ?? blob);
    } finally {
      bmp.close();
    }
  } catch {
    return URL.createObjectURL(blob);
  }
}

const cacheKey = (id: string) => `bgblob:${id}`;

/** The picture of an upload: from the IndexedDB cache, else fetched from the store and cached. */
async function pictureOf(entry: BackgroundEntry): Promise<Blob | null> {
  const p = provider.peek();
  if (p.kind === 'local') return p.getBackground(entry.id);
  const cached = await idb.get<Blob>(STORES.config, cacheKey(entry.id)).catch(() => undefined);
  if (cached instanceof Blob && cached.size > 0) return cached;
  const blob = await p.getBackground(entry.id);
  if (blob && blob.size > 0) await idb.put(STORES.config, cacheKey(entry.id), blob).catch(() => undefined);
  return blob;
}

const urls = new Map<string, { src: string; thumb: string }>();
function release(id: string): void {
  const u = urls.get(id);
  if (u) {
    URL.revokeObjectURL(u.src);
    URL.revokeObjectURL(u.thumb);
    urls.delete(id);
  }
}

async function itemOf(entry: BackgroundEntry, blob: Blob): Promise<BackgroundItem> {
  const id = `${MY_BACKGROUND_PREFIX}${entry.id}`;
  let u = urls.get(id);
  if (!u) {
    u = { src: URL.createObjectURL(blob), thumb: await thumbUrl(blob) };
    urls.set(id, u);
  }
  return { id, kind: 'image', src: u.src, thumb: u.thumb, label: entry.name };
}

let listing: Promise<void> | null = null;
/**
 * The Backgrounds folder listed: the uploads become picker items (their pictures fetched once); the built-in copies
 * are counted (so a missing one is seeded). Signed out of Drive, "this device" is the folder.
 */
export function loadMyBackgrounds(force = false): Promise<void> {
  if (listing && !force) return listing;
  listing = (async () => {
    backgroundsBusy.value = 'listing';
    try {
      const p = provider.peek();
      await p.ready();
      const entries = await p.listBackgrounds();
      const items: BackgroundItem[] = [];
      for (const e of entries.filter((x) => !x.stock)) {
        const blob = await pictureOf(e).catch(() => null);
        if (blob) items.push(await itemOf(e, blob));
      }
      for (const id of [...urls.keys()]) if (!items.some((i) => i.id === id)) release(id);
      myBackgrounds.value = items;
      await seedStock(entries).catch((e) => console.warn('backgrounds: the built-in pictures were not all copied to the folder', e));
    } catch (e) {
      console.warn('backgrounds: the folder could not be listed', e);
      if (myBackgrounds.peek() === null) myBackgrounds.value = [];
    } finally {
      backgroundsBusy.value = null;
    }
  })();
  return listing;
}

/** Once per account (and again after a restore): a copy of every built-in picture not yet in the folder, stamped with its id. */
async function seedStock(entries: BackgroundEntry[]): Promise<void> {
  const account = accountUserId.peek() || 'device';
  const key = `sv.bg.seeded.${account}`;
  await loadStockBackgrounds();
  const stock = stockBackgrounds.peek().filter((b) => b.kind === 'image');
  const hidden = new Set(appSettings.peek().hiddenBackgrounds);
  const have = new Set(entries.map((e) => e.stock).filter(Boolean));
  const missing = stock.filter((b) => !have.has(b.id) && !hidden.has(b.id));
  let seeded = '';
  try {
    seeded = localStorage.getItem(key) ?? '';
  } catch {
    /* no storage */
  }
  if (!missing.length || (seeded === SEED_VERSION && have.size > 0)) return;
  backgroundsBusy.value = 'seeding';
  const p = provider.peek();
  for (const b of missing) {
    const r = await fetch(asset(`backgrounds/${b.src}`));
    if (!r.ok) continue;
    await p.saveBackground(b.label, await r.blob(), { stock: b.id });
  }
  try {
    localStorage.setItem(key, SEED_VERSION);
  } catch {
    /* no storage */
  }
}
/** Bump when the built-in set changes, so every account gets the new pictures copied in. */
const SEED_VERSION = '2';

/** A picture from the device into the folder (scaled first); the new item's id (`mybg:…`). */
export async function uploadBackground(file: File, onProgress?: (label: string) => void): Promise<string> {
  onProgress?.(`Preparing ${file.name}`);
  const blob = await fitPicture(file);
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is too big even scaled down`);
  const p = provider.peek();
  await p.ready();
  onProgress?.(`Uploading ${file.name}`);
  const name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Background';
  const entry = await p.saveBackground(name, blob);
  if (p.kind !== 'local') await idb.put(STORES.config, cacheKey(entry.id), blob).catch(() => undefined);
  const item = await itemOf(entry, blob);
  myBackgrounds.value = [item, ...(myBackgrounds.peek() ?? []).filter((i) => i.id !== item.id)];
  return item.id;
}

/**
 * Backgrounds deleted: an upload is removed from the folder (the Drive bin) and the cache; a built-in is hidden on this
 * account and its copy in the folder removed. Returns the ids gone.
 */
export async function deleteBackgrounds(ids: string[]): Promise<string[]> {
  const p = provider.peek();
  await p.ready();
  const mine = ids.filter(isMyBackground).map((id) => id.slice(MY_BACKGROUND_PREFIX.length));
  const stock = ids.filter((id) => !isMyBackground(id) && stockBackgrounds.peek().some((b) => b.id === id));
  if (mine.length) {
    await p.deleteBackgrounds(mine);
    for (const id of mine) {
      await idb.del(STORES.config, cacheKey(id)).catch(() => undefined);
      release(`${MY_BACKGROUND_PREFIX}${id}`);
    }
    myBackgrounds.value = (myBackgrounds.peek() ?? []).filter((i) => !mine.includes(i.id.slice(MY_BACKGROUND_PREFIX.length)));
  }
  if (stock.length) {
    updateApp({ hiddenBackgrounds: [...new Set([...appSettings.peek().hiddenBackgrounds, ...stock])] });
    const entries = await p.listBackgrounds().catch(() => [] as BackgroundEntry[]);
    const copies = entries.filter((e) => e.stock && stock.includes(e.stock)).map((e) => e.id);
    if (copies.length) await p.deleteBackgrounds(copies).catch((e) => console.warn('backgrounds: a built-in copy stayed in the folder', e));
  }
  return [...mine.map((id) => `${MY_BACKGROUND_PREFIX}${id}`), ...stock];
}

/** The built-in pictures hidden on this account shown again, and copied back into the folder. */
export async function restoreStockBackgrounds(): Promise<void> {
  updateApp({ hiddenBackgrounds: [] });
  try {
    localStorage.removeItem(`sv.bg.seeded.${accountUserId.peek() || 'device'}`);
  } catch {
    /* no storage */
  }
  await loadMyBackgrounds(true);
}
