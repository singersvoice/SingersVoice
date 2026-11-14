import { newId, safeName } from './ids.ts';

/** Singer slots 1..10 (max performers on stage). Slot 0 = everyone (chorus). */
export type SingerSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export const MAX_SINGER_SLOTS = 10;

/** Slot colours (1–5 match the SVOld palette: green, blue, purple, orange, magenta). */
export const SLOT_COLORS: Record<SingerSlot, string> = {
  0: '#E6E1F0',
  1: '#38D39F',
  2: '#4EA8FF',
  3: '#B388FF',
  4: '#FFA447',
  5: '#FF5FB2',
  6: '#FFE066',
  7: '#5CE1E6',
  8: '#FF7A59',
  9: '#9BE564',
  10: '#C7B3FF',
};

export interface LyricLine {
  /** Start of the line on the track timeline, ms. */
  startMs: number;
  /** End of the line, ms (>= startMs). */
  endMs: number;
  text: string;
  singerSlot: SingerSlot;
  /** Optional word timings for karaoke fill (enhanced LRC). */
  words?: { startMs: number; text: string }[];
}

export type TrackLayerKind = 'backing' | 'guide' | 'harmony' | 'click';

export interface TrackLayer {
  /** L1..L4 */
  id: 'L1' | 'L2' | 'L3' | 'L4';
  kind: TrackLayerKind;
  /** File name inside the track folder (e.g. backing.mp3). */
  file: string;
  mimeType: string;
  /** Default gain 0..1 applied when the layer is on. */
  gain: number;
  enabledByDefault: boolean;
}

/** singersvoice.track.v2 — the JSON saved as `track.json` inside `SingersVoice/Tracks/<title>/`. */
export interface TrackPackageV2 {
  schema: 'singersvoice.track.v2';
  trackId: string;
  title: string;
  artist: string;
  genre: string;
  language: string;
  bpm: number | null;
  keySignature: string;
  durationMs: number;
  layers: TrackLayer[];
  lyrics: LyricLine[];
  /** How many singer slots the lyrics use (1..10). */
  singerCount: number;
  /** Free-form notes shown in the library card. */
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** Where the package came from (trackmaker, import-v1, import-lrc). */
  origin: 'trackmaker' | 'import-v1' | 'import-lrc' | 'unknown';
}

/** The SVOld TrackMaker JSON (singersvoice.trackmaker.v1). Only the fields we read. */
export interface TrackMakerV1 {
  schema: 'singersvoice.trackmaker.v1';
  trackId?: string;
  title?: string;
  artist?: string;
  durationMs?: number;
  genre?: string;
  language?: string;
  bpm?: number;
  keySignature?: string;
  lyrics?: { startMs: number; endMs: number; text: string; singerSlot?: number }[];
  savedAt?: string;
}

/** Longest track the Sing screen accepts (15 minutes). */
export const MAX_TRACK_DURATION_MS = 15 * 60 * 1000;

export function clampSlot(n: unknown): SingerSlot {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 1;
  return Math.max(0, Math.min(MAX_SINGER_SLOTS, v)) as SingerSlot;
}

/**
 * One lyric line is one row of text. SVOld's editor left stray `\`, `//` and `??` runs inside
 * lines (shown as syllable-by-syllable breaks — never intended); those and any embedded line
 * breaks collapse to a single space. A lone `/` ("rock/roll") is kept.
 */
export function cleanLyricText(text: string): string {
  return String(text ?? '')
    .replace(/[\\/]*\\[\\/]*|\/{2,}/g, ' ')
    .replace(/\?{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sort by start, clamp to >=0, make ends monotonic, clip to duration when known. */
export function normalizeLyrics(lines: LyricLine[], durationMs?: number): LyricLine[] {
  const out = lines
    .map((l) => ({
      startMs: Math.max(0, Math.round(Number(l.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(l.endMs) || 0)),
      text: cleanLyricText(l.text),
      singerSlot: clampSlot(l.singerSlot),
      ...(l.words ? { words: l.words } : {}),
    }))
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!;
    const next = out[i + 1];
    if (cur.endMs <= cur.startMs) cur.endMs = next ? next.startMs : cur.startMs + 3000;
    if (next && cur.endMs > next.startMs) cur.endMs = next.startMs;
    if (durationMs && durationMs > 0) {
      cur.startMs = Math.min(cur.startMs, durationMs);
      cur.endMs = Math.min(cur.endMs, durationMs);
    }
  }
  return out;
}

export function singerCountOf(lines: LyricLine[]): number {
  let max = 1;
  for (const l of lines) if (l.singerSlot > max) max = l.singerSlot;
  return max;
}

export function createTrack(partial: Partial<TrackPackageV2> = {}): TrackPackageV2 {
  const now = new Date().toISOString();
  const lyrics = normalizeLyrics(partial.lyrics ?? [], partial.durationMs);
  return {
    schema: 'singersvoice.track.v2',
    trackId: partial.trackId ?? newId('trk-'),
    title: safeName(partial.title ?? '', 'Untitled track'),
    artist: (partial.artist ?? '').trim(),
    genre: (partial.genre ?? '').trim(),
    language: (partial.language ?? '').trim(),
    bpm: partial.bpm ?? null,
    keySignature: (partial.keySignature ?? '').trim(),
    durationMs: Math.max(0, Math.round(partial.durationMs ?? 0)),
    layers: partial.layers ?? [],
    lyrics,
    singerCount: partial.singerCount ?? singerCountOf(lyrics),
    notes: partial.notes ?? '',
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
    origin: partial.origin ?? 'trackmaker',
  };
}

/** Import an SVOld `*.trackmaker.json` into a v2 package (audio layer added by the caller). */
export function importTrackV1(v1: TrackMakerV1): TrackPackageV2 {
  if (v1.schema !== 'singersvoice.trackmaker.v1') throw new Error('Not a singersvoice.trackmaker.v1 file');
  const lyrics = (v1.lyrics ?? []).map((l) => ({
    startMs: l.startMs,
    endMs: l.endMs,
    text: cleanV1Text(l.text),
    singerSlot: clampSlot(l.singerSlot ?? 1),
  }));
  return createTrack({
    trackId: v1.trackId ? `trk-${v1.trackId}` : undefined,
    title: v1.title,
    artist: v1.artist,
    genre: v1.genre,
    language: v1.language,
    bpm: v1.bpm ?? null,
    keySignature: v1.keySignature,
    durationMs: v1.durationMs,
    lyrics,
    createdAt: v1.savedAt,
    origin: 'import-v1',
  });
}

/** SVOld lyric text → one clean row (its stray `\`, `//`, `??` markers are dropped). */
export function cleanV1Text(text: string): string {
  return cleanLyricText(text);
}

/** Re-normalize a stored package (older saves may carry multi-row lines); safe to call on every load. */
export function normalizeTrack(pkg: TrackPackageV2): TrackPackageV2 {
  const lyrics = normalizeLyrics(pkg.lyrics ?? [], pkg.durationMs);
  return { ...pkg, lyrics, singerCount: pkg.singerCount || singerCountOf(lyrics) };
}

export type SlotPattern = 'solo' | 'alternate' | 'duet-verse' | 'all';

/** Plain lyric text → lines (blank lines separate sections, kept as `''` markers removed). */
export function splitLyricsText(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Assign singer slots to a list of lines by pattern. */
export function assignSlots(count: number, singers: number, pattern: SlotPattern): SingerSlot[] {
  const n = Math.max(1, Math.min(MAX_SINGER_SLOTS, singers));
  const out: SingerSlot[] = [];
  for (let i = 0; i < count; i++) {
    switch (pattern) {
      case 'solo':
        out.push(1);
        break;
      case 'alternate':
        out.push(((i % n) + 1) as SingerSlot);
        break;
      case 'duet-verse':
        // 4-line verses alternate between singers; every 4th verse everyone sings.
        {
          const verse = Math.floor(i / 4);
          out.push(verse % (n + 1) === n ? 0 : (((verse % n) + 1) as SingerSlot));
        }
        break;
      case 'all':
        out.push(0);
        break;
    }
  }
  return out;
}

/** Spread lines evenly between two timestamps (used by the Track Maker "auto-space" action). */
export function autoSpace(lines: LyricLine[], fromIndex: number, toIndex: number, startMs: number, endMs: number): LyricLine[] {
  const copy = lines.map((l) => ({ ...l }));
  const n = toIndex - fromIndex + 1;
  if (n <= 0 || endMs <= startMs) return copy;
  const step = (endMs - startMs) / n;
  for (let i = 0; i < n; i++) {
    const l = copy[fromIndex + i]!;
    l.startMs = Math.round(startMs + i * step);
    l.endMs = Math.round(startMs + (i + 1) * step);
  }
  return normalizeLyrics(copy);
}

/** Index of the line active at `tMs`, or -1 before the first line. Between lines → the previous line. */
export function activeLineIndex(lines: LyricLine[], tMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.startMs <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface LyricsWindow {
  /** Index of the active line (-1 before the song starts). */
  active: number;
  /** Lines to render: 1 done + active + 3 upcoming by default. */
  items: { index: number; line: LyricLine; state: 'done' | 'active' | 'upcoming' }[];
  /** 0..1 progress through the active line. */
  progress: number;
  /** ms until the next line starts (for the cue deck / count-in). */
  msToNext: number;
}

/** The characters of a line that are sung (no spaces, no punctuation) — what its pace is measured by. */
export const sungChars = (text: string): number => text.replace(/[\s\p{P}]/gu, '').length;

/** Pace bounds (ms per sung character): faster than a rap, slower than a held note per letter. */
const PACE_MIN_MS = 40;
const PACE_MAX_MS = 400;
/** The pace assumed when the song has too few timed lines to measure one. */
export const PACE_DEFAULT_MS = 120;

/**
 * How fast this song is sung: the median milliseconds per sung character over its timed lines. A
 * line's timing spans from its start to the next line's start, so it includes the pause after it;
 * the median line is a typical line, and the lines with a long pause are the ones the fill must not
 * stretch across. Per song, so a Telugu line (a syllable a character) and an English one (two or
 * three characters a syllable) each measure their own pace.
 */
export function lyricsPace(lines: LyricLine[]): number {
  const rates: number[] = [];
  for (const l of lines) {
    const chars = sungChars(l.text);
    const span = l.endMs - l.startMs;
    if (chars >= 3 && span >= 300) rates.push(span / chars);
  }
  if (rates.length < 3) return PACE_DEFAULT_MS;
  rates.sort((a, b) => a - b);
  return Math.max(PACE_MIN_MS, Math.min(PACE_MAX_MS, rates[Math.floor(rates.length / 2)]!));
}

/** How long a line is actually sung: its characters at the song's pace, never past the line's own span. */
export function sungSpanMs(line: LyricLine, paceMsPerChar: number): number {
  const span = Math.max(1, line.endMs - line.startMs);
  return Math.max(1, Math.min(span, Math.max(600, sungChars(line.text) * paceMsPerChar)));
}

export interface LyricsWindowOptions {
  /** Lines light up this many ms before they start (a breath to read them), their fill still starting on time. */
  leadMs?: number;
  /** The song's pace (`lyricsPace`): the active line fills over the time its words take, not over the pause after them. */
  paceMsPerChar?: number;
}

export function lyricsWindow(lines: LyricLine[], tMs: number, before = 1, after = 3, opts: LyricsWindowOptions = {}): LyricsWindow {
  const active = activeLineIndex(lines, tMs + (opts.leadMs ?? 0));
  const items: LyricsWindow['items'] = [];
  const first = Math.max(0, active - before);
  const last = Math.min(lines.length - 1, (active < 0 ? -1 : active) + after);
  for (let i = first; i <= last; i++) {
    const line = lines[i]!;
    items.push({ index: i, line, state: i < active ? 'done' : i === active ? 'active' : 'upcoming' });
  }
  let progress = 0;
  if (active >= 0) {
    const l = lines[active]!;
    const span = opts.paceMsPerChar ? sungSpanMs(l, opts.paceMsPerChar) : Math.max(1, l.endMs - l.startMs);
    progress = Math.max(0, Math.min(1, (tMs - l.startMs) / span));
  }
  const next = lines[active + 1];
  const msToNext = next ? Math.max(0, next.startMs - tMs) : Number.POSITIVE_INFINITY;
  return { active, items, progress, msToNext };
}

/** Lines sung by `slot` (or everyone) that start after `tMs` — the personal cue deck. */
export function cueDeck(lines: LyricLine[], tMs: number, slot: SingerSlot, count = 3): LyricLine[] {
  const out: LyricLine[] = [];
  for (const l of lines) {
    if (l.startMs < tMs) continue;
    if (l.singerSlot === slot || l.singerSlot === 0) out.push(l);
    if (out.length >= count) break;
  }
  return out;
}

// ---------- LRC ----------

const LRC_TIME = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parse (enhanced) LRC. Singer markers `v1:`/`v2:`/`M:`/`F:`/`D:` at the line start map to slots. */
export function parseLrc(text: string): { lines: LyricLine[]; meta: Record<string, string> } {
  const meta: Record<string, string> = {};
  const raw: { startMs: number; text: string; slot: SingerSlot }[] = [];
  for (const row of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = row.match(/^\[([a-zA-Z]+):(.*)\]$/);
    if (m) {
      meta[m[1]!.toLowerCase()] = m[2]!.trim();
      continue;
    }
    const times: number[] = [];
    let body = row;
    let hit: RegExpExecArray | null;
    LRC_TIME.lastIndex = 0;
    while ((hit = LRC_TIME.exec(row))) {
      const ms = Number(hit[1]) * 60000 + Number(hit[2]) * 1000 + (hit[3] ? Number(hit[3].padEnd(3, '0')) : 0);
      times.push(ms);
      body = body.replace(hit[0], '');
    }
    if (!times.length) continue;
    let slot: SingerSlot = 1;
    const sm = body.match(/^\s*(?:v(\d{1,2})|([MFD])):\s*/i);
    if (sm) {
      slot = sm[1] ? clampSlot(Number(sm[1])) : sm[2]!.toUpperCase() === 'M' ? 1 : sm[2]!.toUpperCase() === 'F' ? 2 : 0;
      body = body.slice(sm[0].length);
    }
    // Enhanced-LRC word timings <mm:ss.xx>.
    body = body.replace(/<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g, '').replace(/\s+/g, ' ').trim();
    for (const t of times) raw.push({ startMs: t, text: body, slot });
  }
  raw.sort((a, b) => a.startMs - b.startMs);
  const lines: LyricLine[] = raw.map((r, i) => ({
    startMs: r.startMs,
    endMs: raw[i + 1]?.startMs ?? r.startMs + 3000,
    text: r.text,
    singerSlot: r.slot,
  }));
  return { lines: normalizeLyrics(lines), meta };
}

export function toLrc(track: Pick<TrackPackageV2, 'title' | 'artist' | 'lyrics'>): string {
  const out = [`[ti:${track.title}]`, `[ar:${track.artist}]`, `[re:SingersVoice]`, `[ve:2]`];
  for (const l of track.lyrics) {
    const m = Math.floor(l.startMs / 60000);
    const s = Math.floor((l.startMs % 60000) / 1000);
    const cs = Math.floor((l.startMs % 1000) / 10);
    const tag = `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
    const slot = l.singerSlot === 0 ? 'D: ' : `v${l.singerSlot}: `;
    out.push(`${tag}${slot}${l.text.replace(/\n/g, ' / ')}`);
  }
  return out.join('\n') + '\n';
}

export interface TrackIssue {
  level: 'error' | 'warn';
  message: string;
}

export function validateTrack(t: TrackPackageV2): TrackIssue[] {
  const issues: TrackIssue[] = [];
  if (t.schema !== 'singersvoice.track.v2') issues.push({ level: 'error', message: 'Wrong schema' });
  if (!t.title.trim()) issues.push({ level: 'error', message: 'Title is required' });
  if (!t.durationMs) issues.push({ level: 'error', message: 'Audio duration unknown' });
  if (t.durationMs > MAX_TRACK_DURATION_MS) issues.push({ level: 'error', message: 'Tracks are limited to 15 minutes' });
  if (!t.layers.length) issues.push({ level: 'error', message: 'A backing track audio file is required' });
  if (!t.lyrics.length) issues.push({ level: 'warn', message: 'No lyrics yet — the Sing screen will show a blank stage' });
  const unsynced = t.lyrics.filter((l) => l.startMs === 0 && l.endMs === 0).length;
  if (unsynced) issues.push({ level: 'warn', message: `${unsynced} line(s) have no timing` });
  for (let i = 1; i < t.lyrics.length; i++) {
    if (t.lyrics[i]!.startMs < t.lyrics[i - 1]!.endMs) {
      issues.push({ level: 'warn', message: `Lines ${i} and ${i + 1} overlap` });
      break;
    }
  }
  return issues;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatMsPrecise(ms: number): string {
  const base = formatMs(ms);
  const hundredths = Math.floor((Math.max(0, ms) % 1000) / 10);
  return `${base}.${String(hundredths).padStart(2, '0')}`;
}
