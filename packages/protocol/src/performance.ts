import type { VoxForgeParams } from './audio.ts';
import type { JoinLayer } from './join.ts';

export type PerformanceState = 'temp' | 'kept';
export type PerformanceMode = 'offline' | 'live';

export interface FileEntry {
  /** File name inside the performance folder. */
  name: string;
  mimeType: string;
  size: number;
  /** Hex SHA-256 of the bytes, computed before upload. */
  sha256: string;
  /** Drive file id once uploaded. */
  driveId?: string;
  /** Drive-reported md5 after upload (verified against the local md5). */
  md5?: string;
}

/**
 * What a performance's video is: a 'take' is this singer's own camera; a 'show' is the broadcast
 * picture — every singer on stage cut out over the stage background, with the whole mix (backing
 * track + every vocal) as its sound — exactly what Publishing mode shows. A meet's show, recorded
 * on the host's device, is the one saved performance of that song, shared with everyone in the meet.
 */
export type PerformanceKind = 'take' | 'show';

export interface PerformanceSinger {
  slot: number;
  displayName: string;
  userId?: string;
}

/**
 * A chapter of a filmed event (the host's "Full meet" film, the publisher's "Broadcast" footage): the
 * film is cut into chapters as the stage goes — a new one every time a song starts (a restart or a
 * new song too), one for every pause, one for the stage between songs — and every chapter is a
 * performance of its own (its own file, its own timestamp), so no song is ever merged with the next
 * or lost with it. `eventId` ties the chapters of one filming together; `index` orders them.
 */
export type ChapterKind = 'song' | 'pause' | 'stage';

export interface PerformanceChapter {
  eventId: string;
  /** What the filming is called ("Full meet", "Broadcast"). */
  eventTitle: string;
  index: number;
  kind: ChapterKind;
  /** The song this chapter belongs to (a song chapter, a pause in it), when any. */
  trackId: string;
  trackTitle: string;
  /** The meet's playback epoch the song chapter started with (a restart is a new epoch). */
  songEpoch: number;
  /** When the chapter starts: the wall clock, and the offset from the event's start. */
  startedAt: string;
  startMs: number;
}

/** A joined take's place in the chain: the performance it was sung over and the layers it inherited (join.ts has the arithmetic). */
export interface PerformanceJoin {
  fromPerformanceId: string;
  fromOwnerName: string;
  /** Every earlier singer, with their cut-out's frame 0 on THIS show's clock. */
  layers: JoinLayer[];
  /** This show's frame 0 on the song's timeline (real ms) and the pace the song was first sung at — what the next joiner's lyrics line up by. */
  offsetMs: number;
  tempo: number;
}

/** singersvoice.performance.v2 — `manifest.json` inside each performance folder. */
export interface PerformanceManifest {
  schema: 'singersvoice.performance.v2';
  performanceId: string;
  mode: PerformanceMode;
  state: PerformanceState;
  /** Missing in older manifests = 'take'. */
  kind?: PerformanceKind;
  /** The meet this was sung in (live mode): its title, who was on stage, who hosted. */
  meetTitle?: string;
  singers?: PerformanceSinger[];
  hostName?: string;
  /** A chapter of a filmed event (see `PerformanceChapter`); absent on a song's show and on a take. */
  chapter?: PerformanceChapter;
  /** A take sung over another performance (join.ts): which one, and every earlier singer on this show's clock. */
  join?: PerformanceJoin;
  /** ISO date; Temp performances are deleted after `expiresAt`. */
  createdAt: string;
  expiresAt: string | null;
  trackId: string;
  trackTitle: string;
  trackArtist: string;
  /** Which singer slot this device sang. */
  singerSlot: number;
  meetId: string | null;
  durationMs: number;
  /** Timeline origin: absolute wall-clock the backing track started (ms since epoch) and the audio clock offsets. */
  timeline: {
    startedAtEpochMs: number;
    /** Vocal WAV sample 0 is this many ms after the backing-track start (can be negative). */
    vocalOffsetMs: number;
    /** Video frame 0 is this many ms after the backing-track start. */
    videoOffsetMs: number | null;
    /** The singer's cut-out video (`cutout.*`, alpha-packed — what a joiner's stage draws them from): its frame 0 this many ms after the backing-track start. */
    cutoutOffsetMs?: number | null;
    /** Estimated output latency compensation applied at record time, ms. */
    latencyCompMs: number;
    sampleRate: number;
  };
  /** Backing-track playback settings used. */
  playback: { tempo: number; keyShift: number; backingGain: number };
  fx: VoxForgeParams;
  /** The device that made it; `build` is the app build (the deployed commit), so a file can be read against the code that wrote it. */
  device: { userAgent: string; platform: string; headphones: boolean | null; build?: string };
  files: FileEntry[];
  notes: string;
}

export const TEMP_RETENTION_DAYS = 7;

export function tempExpiry(from = new Date()): string {
  return new Date(from.getTime() + TEMP_RETENTION_DAYS * 86400000).toISOString();
}

const cleanName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-12 2047" — the moment in the saving device's own time zone (the manifest keeps the ISO instant). */
export function localStamp(iso: string, now = new Date(iso)): string {
  if (Number.isNaN(now.getTime())) return iso.slice(0, 16).replace('T', ' ').replace(':', '');
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

/**
 * A take's folder in Drive, sortable by time and readable in a file list:
 * "2026-11-12 2047 Ammo · Friday Meet [mwe8q644-onrv6m] (abc123)" for a meet song (the meet's title and
 * id, so every take of that meet is found together), "2026-11-12 2047 Ammo (abc123)" for a Studio take.
 */
export function performanceFolderName(m: Pick<PerformanceManifest, 'createdAt' | 'trackTitle' | 'performanceId'> & { meetId?: string | null; meetTitle?: string | null }): string {
  const meet = m.meetId ? ` · ${cleanName(m.meetTitle || 'meet')} [${m.meetId.replace(/^meet-/, '')}]` : '';
  return `${localStamp(m.createdAt)} ${cleanName(m.trackTitle) || 'Performance'}${meet} (${m.performanceId.slice(-6)})`;
}

/** "Full meet 03 · Ammo" — a chapter's title as a file list shows it: the event, the chapter's number, what it is. */
export function chapterTitle(c: Pick<PerformanceChapter, 'eventTitle' | 'index' | 'kind' | 'trackTitle'>, title: string): string {
  return `${c.eventTitle} ${pad2(c.index)} · ${title}`;
}

/**
 * The saved show's file name as the people a Drive link reaches will see it: the song, the meet
 * (with its id, when it was one) and the moment — "Ammo · Friday Meet [mwe8q644-onrv6m] · 2026-11-12 2047.mp4"
 * rather than "video.mp4".
 */
export function performanceVideoName(m: Pick<PerformanceManifest, 'createdAt' | 'trackTitle'> & { meetId?: string | null; meetTitle?: string | null; chapter?: PerformanceChapter }, ext: string): string {
  const meet = m.meetId ? `${cleanName(m.meetTitle || 'meet')} [${m.meetId.replace(/^meet-/, '')}]` : m.meetTitle ? cleanName(m.meetTitle) : '';
  const stamp = m.chapter ? localStamp(m.chapter.startedAt).replace(/(\d\d)(\d\d)$/, '$1$2') : localStamp(m.createdAt);
  const parts = [m.chapter ? chapterTitle(m.chapter, cleanName(m.trackTitle) || 'Chapter') : cleanName(m.trackTitle) || 'Performance', meet, stamp].filter(Boolean);
  return `${parts.join(' · ')}.${ext}`;
}
