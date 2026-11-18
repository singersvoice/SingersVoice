/**
 * What a singer likes to sing (Settings → Songs you prefer): languages, and countries — a country stands
 * for the languages its songs are mostly in. The preference shapes the Recommended tab and the public
 * catalog (the songs in those languages first); a singer who set nothing is asked on the spot, with a
 * dropdown, and the answer shows the entries without being kept.
 *
 * Bookmarks: any entry a singer meets — a song of the track database, a public catalog entry, a
 * YouTube result — kept under their account with one tap (a toggle), listed on their Bookmarks tab,
 * and, on a live stage, shared: every singer on stage sees every other singer's bookmarks under
 * Recommended (and in the song picker), so five singers see five singers' songs.
 */
import { SONG_LANGUAGES } from './registry.ts';
import type { YtSearchItem } from './ytTracks.ts';

export interface SongCountry {
  name: string;
  /** The languages its songs are mostly in, the commonest first. */
  languages: string[];
}

export const SONG_COUNTRIES: SongCountry[] = [
  { name: 'India', languages: ['Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Punjabi', 'Gujarati', 'Odia', 'Urdu'] },
  { name: 'United States', languages: ['English', 'Spanish'] },
  { name: 'United Kingdom', languages: ['English'] },
  { name: 'Canada', languages: ['English', 'French'] },
  { name: 'Australia', languages: ['English'] },
  { name: 'Pakistan', languages: ['Urdu', 'Punjabi'] },
  { name: 'Bangladesh', languages: ['Bengali'] },
  { name: 'Sri Lanka', languages: ['Sinhala', 'Tamil'] },
  { name: 'Nepal', languages: ['Nepali', 'Hindi'] },
  { name: 'United Arab Emirates', languages: ['Arabic', 'Hindi', 'Malayalam', 'Urdu'] },
  { name: 'Saudi Arabia', languages: ['Arabic'] },
  { name: 'Egypt', languages: ['Arabic'] },
  { name: 'Spain', languages: ['Spanish'] },
  { name: 'Mexico', languages: ['Spanish'] },
  { name: 'Brazil', languages: ['Portuguese'] },
  { name: 'Portugal', languages: ['Portuguese'] },
  { name: 'France', languages: ['French'] },
  { name: 'Italy', languages: ['Italian'] },
  { name: 'Germany', languages: ['German'] },
  { name: 'Russia', languages: ['Russian'] },
  { name: 'Turkey', languages: ['Turkish'] },
  { name: 'South Korea', languages: ['Korean'] },
  { name: 'Japan', languages: ['Japanese'] },
  { name: 'China', languages: ['Mandarin', 'Cantonese'] },
  { name: 'Taiwan', languages: ['Mandarin'] },
  { name: 'Hong Kong', languages: ['Cantonese'] },
  { name: 'Philippines', languages: ['Tagalog', 'English'] },
  { name: 'Vietnam', languages: ['Vietnamese'] },
  { name: 'Thailand', languages: ['Thai'] },
  { name: 'Indonesia', languages: ['Indonesian'] },
  { name: 'Malaysia', languages: ['Malay', 'Tamil', 'Mandarin'] },
  { name: 'Singapore', languages: ['English', 'Mandarin', 'Tamil', 'Malay'] },
];

export interface SongPrefs {
  languages: string[];
  countries: string[];
}

export const emptyPrefs = (): SongPrefs => ({ languages: [], countries: [] });

/** The preference as kept: known languages and countries only, each once, at most a dozen of each. */
export function normalizePrefs(raw: unknown): SongPrefs {
  const r = (raw ?? {}) as { languages?: unknown; countries?: unknown };
  const pick = (v: unknown, known: string[]) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x)))].filter((x) => known.includes(x)).slice(0, 12) : []);
  return {
    languages: pick(r.languages, SONG_LANGUAGES),
    countries: pick(
      r.countries,
      SONG_COUNTRIES.map((c) => c.name),
    ),
  };
}

export const hasPrefs = (p: SongPrefs | null | undefined): boolean => Boolean(p && (p.languages.length || p.countries.length));

/** Every language the preference reaches: the languages picked, then the countries' languages, each once. */
export function prefsLanguages(p: SongPrefs | null | undefined): string[] {
  if (!p) return [];
  const out: string[] = [];
  const add = (l: string) => {
    if (!out.includes(l)) out.push(l);
  };
  for (const l of p.languages) add(l);
  for (const c of p.countries) for (const l of SONG_COUNTRIES.find((x) => x.name === c)?.languages ?? []) add(l);
  return out;
}

/** "Hindi, Telugu & English", for a line. */
export function languagesLine(langs: string[]): string {
  if (!langs.length) return '';
  if (langs.length === 1) return langs[0]!;
  return `${langs.slice(0, -1).join(', ')} & ${langs[langs.length - 1]}`;
}

// ---- bookmarks ----

/** What a bookmark points at: a song of the track database, a public catalog entry, a YouTube result not yet sung by anyone. */
export type BookmarkKind = 'registry' | 'catalog' | 'youtube';

export interface Bookmark {
  /** `<kind>:<ref>` — one bookmark per song per singer. */
  key: string;
  kind: BookmarkKind;
  ref: string;
  title: string;
  artist: string;
  language: string;
  durationMs: number;
  thumbnail: string;
  /** The ids a stage needs to load the song (the track database's, the catalog's), when known. */
  registryId: string | null;
  catalogTrackId: string | null;
  /** A YouTube result, as found — fetched into a singer's Drive when sung. */
  youtube: YtSearchItem | null;
  createdAt: string;
}

export type BookmarkInput = Omit<Bookmark, 'key' | 'createdAt'>;

export const bookmarkKey = (kind: BookmarkKind, ref: string): string => `${kind}:${ref}`;

/** A bookmark on a live stage: whose it is (every singer on stage who kept it). */
export interface StageBookmark extends Bookmark {
  by: { userId: string; displayName: string }[];
}

/** The bookmark as kept: strings trimmed and bounded, the kind known, the ref present. */
export function normalizeBookmark(raw: unknown): BookmarkInput | null {
  const r = (raw ?? {}) as Partial<BookmarkInput>;
  const kind = r.kind;
  if (kind !== 'registry' && kind !== 'catalog' && kind !== 'youtube') return null;
  const ref = String(r.ref ?? '').trim().slice(0, 120);
  if (!ref) return null;
  const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const yt = r.youtube && typeof r.youtube === 'object' ? (r.youtube as Partial<YtSearchItem>) : null;
  const ytId = str(yt?.id, 20);
  return {
    kind,
    ref,
    title: str(r.title, 200),
    artist: str(r.artist, 200),
    language: str(r.language, 40),
    durationMs: Math.max(0, Math.round(Number(r.durationMs) || 0)),
    thumbnail: str(r.thumbnail, 400),
    registryId: r.registryId ? str(r.registryId, 40) : null,
    catalogTrackId: r.catalogTrackId ? str(r.catalogTrackId, 80) : null,
    youtube:
      yt && ytId
        ? { id: ytId, title: str(yt.title, 200), channel: str(yt.channel, 120), thumbnail: str(yt.thumbnail, 400), durationMs: Math.max(0, Math.round(Number(yt.durationMs) || 0)), views: Number.isFinite(Number(yt.views)) && yt.views !== null && yt.views !== undefined ? Number(yt.views) : null, url: `https://www.youtube.com/watch?v=${ytId}` }
        : null,
  };
}
