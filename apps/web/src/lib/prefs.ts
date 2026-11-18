/**
 * The songs a singer prefers (prefs.ts in the protocol), from the singer's side: the languages and
 * countries kept on their account (Settings → Songs you prefer), remembered on this device so the
 * Tracks portal has them the moment it opens, loaded from the service once per session, saved
 * whole on every change. A singer who set nothing is asked on the spot — the Recommended tab and
 * the public catalog show a dropdown — and the pick is kept for the session on this device alone
 * (sessionStorage), never on the account: Settings is where a preference is set once.
 */
import { emptyPrefs, hasPrefs, normalizePrefs, prefsLanguages, SONG_COUNTRIES, type SongPrefs } from '@singersvoice/protocol';
import { computed, signal } from '@preact/signals';
import { api, controlConfigured } from './api.ts';

const KEY = 'sv.songPrefs';
const PICK_KEY = 'sv.songPick';

function readLocal(): SongPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalizePrefs(JSON.parse(raw)) : emptyPrefs();
  } catch {
    return emptyPrefs();
  }
}

function readPick(): string {
  try {
    return sessionStorage.getItem(PICK_KEY) ?? '';
  } catch {
    return '';
  }
}

/** The preference as last known (this device's copy until the service answers). */
export const songPrefs = signal<SongPrefs>(readLocal());
/** Whether the service has answered this session (until then the device's copy stands). */
export const prefsLoaded = signal(false);
/**
 * What a singer without a preference picked in the dropdown, for this session: `language:Hindi` or
 * `country:India` (empty: nothing picked).
 */
export const songPick = signal<string>(readPick());

/** The languages the preference reaches — or, with no preference set, the ones the session's pick reaches. */
export const preferredLanguages = computed<string[]>(() => {
  const p = songPrefs.value;
  if (hasPrefs(p)) return prefsLanguages(p);
  return pickLanguages(songPick.value);
});

/** The languages a dropdown pick stands for. */
export function pickLanguages(pick: string): string[] {
  const [kind, name] = pick.split(':', 2);
  if (kind === 'language' && name) return [name];
  if (kind === 'country' && name) return SONG_COUNTRIES.find((c) => c.name === name)?.languages ?? [];
  return [];
}

/** The pick's own name for a line ("Hindi", "India"). */
export const pickName = (pick: string): string => pick.split(':', 2)[1] ?? '';

export function setSongPick(pick: string): void {
  songPick.value = pick;
  try {
    if (pick) sessionStorage.setItem(PICK_KEY, pick);
    else sessionStorage.removeItem(PICK_KEY);
  } catch {
    /* no session storage */
  }
}

let loading: Promise<SongPrefs> | null = null;
/** The preference from the account, once per session (again on `force`); the device's copy follows. */
export function loadPrefs(force = false): Promise<SongPrefs> {
  if (!controlConfigured.value) return Promise.resolve(songPrefs.value);
  if (loading && !force) return loading;
  if (prefsLoaded.value && !force) return Promise.resolve(songPrefs.value);
  loading = api
    .get('GET /prefs', '/prefs')
    .then((r) => {
      remember(normalizePrefs(r.prefs));
      prefsLoaded.value = true;
      return songPrefs.value;
    })
    .catch(() => songPrefs.value)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The preference replaced whole, on the account and on this device. */
export async function savePrefs(next: SongPrefs): Promise<SongPrefs> {
  const clean = normalizePrefs(next);
  remember(clean); // at once: the portals follow before the service answers
  if (!controlConfigured.value) return clean;
  const r = await api.put('PUT /prefs', '/prefs', clean);
  remember(normalizePrefs(r.prefs));
  return songPrefs.value;
}

function remember(p: SongPrefs): void {
  songPrefs.value = p;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* no local storage */
  }
}

/** For tests and sign-out: back to nothing known. */
export function resetPrefs(): void {
  songPrefs.value = emptyPrefs();
  prefsLoaded.value = false;
  loading = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* no local storage */
  }
}
