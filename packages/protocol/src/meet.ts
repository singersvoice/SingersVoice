/**
 * Live meets — a shareable room (like a Zoom/Teams meeting link) with up to 10 performers on
 * stage and any number of audience members with chat. The control plane keeps the room state;
 * clients poll it (1 s in lobby/countdown, 3 s while live/idle) — no socket required, so the
 * same API runs on Node and on Cloudflare Workers.
 *
 * Rules: anyone signed in can create a meet; anyone with the link can join; a meet self-expires
 * after MEET_IDLE_EXPIRY_MS without activity (joins, heartbeats, chat, slot changes, start/stop).
 * Every performance on stage is a personal session: each performer records locally and keeps
 * the take in their own Drive (`Performances/Live/<meet>`).
 */
export const MAX_PERFORMERS = 10;
/** Open meets (lobby / countdown / live) one account may host at a time. */
export const MAX_OPEN_MEETS = 3;
export const MEET_IDLE_EXPIRY_MS = 5 * 60 * 1000;
export const MEET_HEARTBEAT_MS = 15 * 1000;
export const MEET_POLL_LOBBY_MS = 1000;
export const MEET_POLL_IDLE_MS = 3000;

/** 'publisher' = a privileged account's show view (Publishing mode): receives the performers' video, never on stage. */
export type MeetRole = 'host' | 'performer' | 'audience' | 'publisher';
export type MeetState = 'lobby' | 'countdown' | 'live' | 'ended' | 'expired';

/**
 * Transport state of the backing track, shared by every device. The track position at server
 * time T is `offsetMs + (T − kickstartEpochMs)` while playing and `pausedAtMs` while paused;
 * `epoch` increments on every start/resume/restart so clients re-schedule exactly once per cue.
 */
export interface MeetPlayback {
  state: 'idle' | 'playing' | 'paused';
  /** Track position (ms) at `kickstartEpochMs`: 0 for the first start, the paused position on resume. */
  offsetMs: number;
  /** Track position (ms) frozen by the host's pause. */
  pausedAtMs: number;
  /**
   * A pause is cued like a kickstart: the host's pause takes effect at this server instant, so every
   * device stops at the same track position instead of whenever its next poll happens to land.
   */
  pauseAtEpochMs: number | null;
  epoch: number;
}

/** WebRTC signalling between performers, relayed by the SVT DB (no socket needed). */
export type MeetSignalType = 'offer' | 'answer' | 'ice' | 'bye';
export interface MeetSignal {
  seq: number;
  meetId: string;
  from: string;
  to: string;
  type: MeetSignalType;
  /** JSON payload (SDP or ICE candidate). */
  data: string;
  sentAt: string;
}

export interface StageSlot {
  slot: number; // 1..10
  participantId: string | null;
  displayName: string;
  picture: string;
  ready: boolean;
  muted: boolean;
  cameraOn: boolean;
  /** Last reported clock drift (ms) and RTT for the sync monitor. */
  driftMs: number | null;
  rttMs: number | null;
}

/** Who may step on stage: 'ask' = audience asks and the host lets them on (default); 'open' = anyone takes a free slot. */
export type StagePolicy = 'ask' | 'open';

/** An audience member asking the host to sing. */
export interface StageRequest {
  participantId: string;
  displayName: string;
  picture: string;
  askedAt: string;
}

/** A song on the meet's set list — the karaoke queue (`trackId` = the picker's own copy, `catalogTrackId` = the public entry every device loads). */
export interface SetListEntry {
  id: string;
  trackId: string | null;
  catalogTrackId: string | null;
  trackTitle: string;
  durationMs: number;
  pickedBy: string;
  pickedByName: string;
  addedAt: string;
}

/** What a song pick carries (from a library track or a catalog entry). */
export interface SongPick {
  trackId: string | null;
  catalogTrackId: string | null;
  trackTitle: string;
  durationMs?: number;
}

export interface Meet {
  meetId: string;
  /** 6-letter join code shown next to the link. */
  joinCode: string;
  title: string;
  hostUserId: string;
  hostName: string;
  trackId: string | null;
  trackTitle: string;
  /** Public catalog entry used to fetch lyrics/audio on every device (null = host's private track). */
  catalogTrackId: string | null;
  state: MeetState;
  backgroundId: string;
  stage: StageSlot[];
  audienceCount: number;
  performerCount: number;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  /** Shared instant the backing track starts (or resumes), ms since epoch (the "GMT kickstart"). */
  kickstartEpochMs: number | null;
  playback: MeetPlayback;
  /** Set when the host stops or the song ends. */
  endedAt: string | null;
  /** Public stream for the audience (LL-HLS URL or YouTube embed), when a session container publishes it. */
  streamUrl: string | null;
  /** Meet-wide privacy: anyone with the link can join (always true in this increment). */
  openJoin: boolean;
  /** Who may step on stage (see StagePolicy). */
  stagePolicy: StagePolicy;
  /** Audience members waiting for the host's permission to sing. */
  requests: StageRequest[];
  /** Songs queued after the current one (`trackId` / `catalogTrackId` / `trackTitle` above). */
  setList: SetListEntry[];
  /** Songs sung so far in this meet (the current one counts once it started). */
  songCount: number;
}

export interface Participant {
  participantId: string;
  userId: string;
  displayName: string;
  picture: string;
  role: MeetRole;
  slot: number | null;
  /** This member's "ask to sing": pending until the host decides; declined until they ask again. */
  stageRequest: 'none' | 'pending' | 'declined';
  joinedAt: string;
  lastSeenAt: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  meetId: string;
  participantId: string;
  displayName: string;
  text: string;
  sentAt: string;
}

export interface MeetRecording {
  meetId: string;
  participantId: string;
  userId: string;
  displayName: string;
  slot: number | null;
  performanceId: string;
  driveFolderLink: string | null;
  durationMs: number;
  createdAt: string;
}

/**
 * The saved performance of one song of a meet: the show — every singer on stage over the stage
 * background with the whole mix — recorded on the host's device, kept in the host's Drive
 * (`Performances/Live`) and shared with everyone who was in the meet: it is listed in each
 * member's Performances, with a link anyone can open.
 */
export interface MeetPerformance {
  performanceId: string;
  meetId: string;
  meetTitle: string;
  hostUserId: string;
  hostName: string;
  songTitle: string;
  trackId: string;
  singers: { slot: number; displayName: string; userId?: string }[];
  /** The performance folder (manifest, vocal, video) — anyone with the link. */
  link: string | null;
  /** The video itself, for watching in a browser. */
  videoLink: string | null;
  durationMs: number;
  bytes: number;
  mimeType: string;
  createdAt: string;
}

export interface RegisterPerformanceRequest {
  resumeToken: string;
  performanceId: string;
  songTitle: string;
  trackId: string;
  singers: { slot: number; displayName: string; userId?: string }[];
  link: string | null;
  videoLink: string | null;
  durationMs: number;
  bytes: number;
  mimeType: string;
}

/** NTP-style clock offset from a request/response pair. offset = server − local. */
export function clockOffsetMs(sentAt: number, serverEpochMs: number, receivedAt: number): { offsetMs: number; rttMs: number } {
  const rttMs = receivedAt - sentAt;
  const offsetMs = serverEpochMs - (sentAt + rttMs / 2);
  return { offsetMs, rttMs };
}

/** Median of several samples, ignoring the slowest third (typical NTP practice). */
export function bestClockOffset(samples: { offsetMs: number; rttMs: number }[]): { offsetMs: number; rttMs: number } {
  if (!samples.length) return { offsetMs: 0, rttMs: 0 };
  const sorted = [...samples].sort((a, b) => a.rttMs - b.rttMs);
  const keep = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.67)));
  const offsets = keep.map((s) => s.offsetMs).sort((a, b) => a - b);
  const mid = offsets[Math.floor(offsets.length / 2)]!;
  return { offsetMs: mid, rttMs: keep[0]!.rttMs };
}

export function emptyStage(): StageSlot[] {
  return Array.from({ length: MAX_PERFORMERS }, (_, i) => ({
    slot: i + 1,
    participantId: null,
    displayName: '',
    picture: '',
    ready: false,
    muted: false,
    cameraOn: true,
    driftMs: null,
    rttMs: null,
  }));
}

export function meetIsOpen(m: Pick<Meet, 'state'>): boolean {
  return m.state === 'lobby' || m.state === 'countdown' || m.state === 'live';
}

export function idlePlayback(): MeetPlayback {
  return { state: 'idle', offsetMs: 0, pausedAtMs: 0, pauseAtEpochMs: null, epoch: 0 };
}

/** Track position (ms) every device agrees on at server time `serverNowMs`; null before the first start. */
export function playbackPositionMs(m: Pick<Meet, 'kickstartEpochMs' | 'playback'>, serverNowMs: number): number | null {
  const pb = m.playback ?? idlePlayback();
  if (pb.state === 'paused') return pb.pausedAtMs;
  if (pb.state === 'playing' && m.kickstartEpochMs !== null) {
    if (pb.pauseAtEpochMs !== null && serverNowMs >= pb.pauseAtEpochMs) return pb.pausedAtMs;
    return pb.offsetMs + Math.max(0, serverNowMs - m.kickstartEpochMs);
  }
  return null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newJoinCode(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** Hard cap on a live take so an idle stage can never record forever. */
export const MAX_LIVE_TAKE_MS = 15 * 60 * 1000;
