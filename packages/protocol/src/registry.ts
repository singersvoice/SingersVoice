/**
 * The master track database (the SVT DB's track registry): one record per karaoke track singers
 * have sung — from YouTube, from a singer's own Drive, from the public catalog — with its metadata,
 * a shareable Google Drive URL and when it was last sung by anyone, so every singer can find what
 * others have sung and sing it from their own Drive.
 *
 *   track id   — 12 characters: 8 random (an alphabet without 0/O/1/I) + the month it was made (YYMM),
 *                the same way everywhere (`newRegistryId`); the service mints them, nobody else
 *   dedupe     — one record per source file (`sourceKey`: the YouTube video, the Drive folder, the
 *                catalog entry); a singer's copy of a record is a *copy* of it, never a second record
 *   access     — the global "last accessed" is the most recent successful access by anyone (UTC);
 *                every singer's own history is kept beside it; searches never count
 */

export type TrackSource = 'youtube' | 'drive' | 'catalog';

/** The Drive ids a device needs to fetch a track's files (the folder is shared anyone-with-the-link). */
export interface TrackFileRefs {
  folderId: string;
  jsonId: string;
  audioId: string;
  audioMime: string;
  videoId?: string;
  videoMime?: string;
}

export interface TrackRecord {
  /** 12 characters, see `newRegistryId`. */
  trackId: string;
  source: TrackSource;
  /** `yt:<videoId>` · `drive:<folderId>` · `catalog:<catalogTrackId>` — one record per key. */
  sourceKey: string;
  /** The song's search name. */
  song: string;
  artists: string;
  movie: string;
  year: number | null;
  language: string;
  /** The shareable Google Drive URL (the owner's shared track folder). */
  driveUrl: string;
  refs: TrackFileRefs;
  durationMs: number;
  singerCount: number;
  hasVideo: boolean;
  youtubeId: string | null;
  thumbnail: string;
  ownerUserId: string;
  ownerName: string;
  catalogTrackId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The most recent successful access by anyone (UTC ISO), null until somebody sings it. */
  lastAccessedAt: string | null;
  accessCount: number;
  /** Distinct singers who accessed it. */
  singers: number;
  /** Singers' copies registered (their own shared folders — the files are fetched from any of them). */
  copies: number;
  /** Set when every known file source failed; cleared when a fetch or a new copy succeeds. */
  unavailable: boolean;
  /** The requesting singer's own history and copy (filled in by the service). */
  mine?: TrackAccessMine | null;
}

export interface TrackAccessMine {
  lastAccessedAt: string;
  count: number;
  /** The id of my copy in my own library, when I registered one. */
  copyTrackId: string | null;
}

export interface RegisterTrackRequest {
  source: TrackSource;
  /** Left out: made from the source (`yt:<youtubeId>` · `catalog:<catalogTrackId>` · `drive:<refs.folderId>`). */
  sourceKey?: string;
  song: string;
  artists?: string;
  movie?: string;
  year?: number | null;
  language?: string;
  driveUrl: string;
  refs: TrackFileRefs;
  durationMs?: number;
  singerCount?: number;
  youtubeId?: string | null;
  thumbnail?: string;
  catalogTrackId?: string | null;
  /** The id of the registering singer's own copy in their library. */
  copyTrackId?: string;
}

export interface TrackAccessRequest {
  /** sing: opened for performance · play: previewed / played. */
  how: 'sing' | 'play';
}

export interface TrackCopyRequest {
  refs: TrackFileRefs;
  driveUrl: string;
  copyTrackId: string;
}

export interface TrackMetaPatch {
  song?: string;
  artists?: string;
  movie?: string;
  year?: number | null;
  language?: string;
}

/** Records with the same song name, one group: the versions by artist, movie, language, source. */
export interface TrackSearchGroup {
  songKey: string;
  song: string;
  lastAccessedAt: string | null;
  versions: TrackRecord[];
}

export interface TrackSearchResponse {
  groups: TrackSearchGroup[];
  /** Groups matching in all. */
  total: number;
  nextCursor: string | null;
}

export interface TrackHistoryResponse {
  items: TrackRecord[];
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REGISTRY_ID = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\d{4}$/;
export const isRegistryId = (s: unknown): s is string => typeof s === 'string' && REGISTRY_ID.test(s);

/** The 4-character date component of an id: the month it was minted, YYMM (UTC). */
export function registryIdDate(now: Date = new Date()): string {
  return `${String(now.getUTCFullYear() % 100).padStart(2, '0')}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A new 12-character track id: 8 random characters (crypto-random, an alphabet without 0/O/1/I) + YYMM. */
export function newRegistryId(now: Date = new Date(), random: (n: number) => Uint8Array = cryptoBytes): string {
  const bytes = random(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  return s + registryIdDate(now);
}

function cryptoBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** The source key a record is deduplicated by. */
export function registrySourceKey(r: { source: TrackSource; youtubeId?: string | null; catalogTrackId?: string | null; refs: Pick<TrackFileRefs, 'folderId'> }): string {
  if (r.source === 'youtube' && r.youtubeId) return `yt:${r.youtubeId}`;
  if (r.source === 'catalog' && r.catalogTrackId) return `catalog:${r.catalogTrackId}`;
  return `drive:${r.refs.folderId}`;
}

/** Words that name a karaoke file rather than the song. */
const NOISE = /\b(karaoke|instrumental|backing\s*track|with\s+lyrics|lyrics?|lyrical|official|hd|hq|4k|1080p|720p|video|audio|version|cover|remix|full\s+song|song|track)\b/gi;

/**
 * The key that groups records of the same song: the name lowercased, without the karaoke-file words,
 * brackets, punctuation and extra spaces ("Ammo Ammaayena (Karaoke Version) [HD]" → "ammo ammaayena").
 */
export function songKey(song: string): string {
  return String(song ?? '')
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Languages a karaoke title tends to name (the first found is the song's). */
const LANGUAGES = ['Telugu', 'Tamil', 'Hindi', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Punjabi', 'Gujarati', 'Odia', 'Urdu', 'English', 'Spanish', 'Portuguese', 'French', 'Italian', 'German', 'Korean', 'Japanese', 'Mandarin', 'Cantonese', 'Arabic', 'Turkish', 'Russian', 'Tagalog', 'Vietnamese', 'Thai', 'Indonesian', 'Sinhala', 'Nepali'];

export interface SongMeta {
  song: string;
  artists: string;
  movie: string;
  year: number | null;
  language: string;
}

/**
 * What a karaoke video's title says, as best it can be read: "Song | Movie | Artist | 2019 | Telugu Karaoke"
 * (film songs are often named like this), "Song - Artist (Karaoke Version)", "Song (From "Movie")", a year
 * in brackets, a language word. Anything it cannot tell stays empty — a singer can fix it later.
 */
export function parseSongTitle(title: string, channel = ''): SongMeta {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim();
  const meta: SongMeta = { song: '', artists: '', movie: '', year: null, language: '' };
  const year = t.match(/\b(19[3-9]\d|20[0-4]\d)\b/);
  if (year) meta.year = Number(year[1]);
  const lang = LANGUAGES.find((l) => new RegExp(`\\b${l}\\b`, 'i').test(t));
  if (lang) meta.language = lang;
  const from = t.match(/\(\s*from\s+["“']?([^"”')]+?)["”']?\s*\)/i) ?? t.match(/\bfrom\s+(?:the\s+(?:movie|film)\s+)?["“]([^"”]+)["”]/i);
  if (from) {
    meta.movie = from[1]!.trim();
    t = t.replace(from[0], ' ');
  }
  // What is read is taken out of the name: the year, the language word.
  if (year) t = t.replace(year[0], ' ');
  if (lang) t = t.replace(new RegExp(`\\b${lang}\\b`, 'i'), ' ');
  // Pipes (or " - " runs) split the title into parts: the first is the song, the rest name the movie, singers, year, language.
  const parts = t
    .split(/\s*\|\s*|\s+[-–—]\s+|\s*\/\s*/)
    .map((p) => p.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (parts.length) {
    meta.song = parts[0]!;
    const rest = parts.slice(1).filter((p) => !/^\d{4}$/.test(p) && !LANGUAGES.some((l) => l.toLowerCase() === p.toLowerCase()) && p.length > 1);
    if (!meta.movie && rest.length >= 2) meta.movie = rest[0]!;
    if (rest.length) meta.artists = (rest.length >= 2 ? rest.slice(1) : rest).join(', ');
  }
  if (!meta.song) meta.song = t.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim() || t;
  meta.song = meta.song.replace(/\s*[-–—:|]\s*$/, '').trim();
  if (!meta.artists && channel && !/karaoke|lyrics|official|records|music|hits|sing/i.test(channel)) meta.artists = channel.trim();
  return meta;
}

/** A Google Drive URL and nothing else (what the registry keeps as "shareable URL"). */
export const isDriveUrl = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/(drive|docs)\.google\.com\/[^\s]*$/i.test(u) && u.length <= 300;

/** A record's one-line description for a list: "Artist · Movie · 2019 · Telugu". */
export function trackRecordLine(r: Pick<TrackRecord, 'artists' | 'movie' | 'year' | 'language'>): string {
  return [r.artists, r.movie, r.year ? String(r.year) : '', r.language].filter(Boolean).join(' · ');
}
