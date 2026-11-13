/**
 * Publishing mode — privileged users push a meet's composed stream to YouTube, Facebook,
 * Instagram, Twitch and/or the in-house watch portal. Destinations hold the ingest details; a
 * publish job is one broadcast of one meet.
 *
 * How the picture and sound travel today: the publisher's own browser (the show view) encodes the
 * show — H.264 + AAC, two-second MPEG-TS segments — and PUTs each segment to the service, which
 * keeps a rolling window for the in-house portal (an HLS playlist anyone can play) and forwards it,
 * with a playlist, to YouTube's HLS ingestion. No media server. Facebook, Instagram and Twitch take
 * RTMP(S) only, which a browser cannot speak: those stay queued for a session container.
 */
export type DestinationKind = 'youtube' | 'facebook' | 'instagram' | 'twitch' | 'inhouse';

export const DESTINATIONS: { kind: DestinationKind; label: string; ingestHint: string; keyLabel: string; needsKey: boolean; /** The browser can feed it today (HLS ingestion); the others wait for the session container. */ browserLive: boolean }[] = [
  { kind: 'youtube', label: 'YouTube Live', ingestHint: 'rtmps://a.rtmps.youtube.com:443/live2', keyLabel: 'Stream key (YouTube Studio → Go live → Stream key)', needsKey: true, browserLive: true },
  { kind: 'facebook', label: 'Facebook Live', ingestHint: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyLabel: 'Stream key (Live Producer → Streaming software)', needsKey: true, browserLive: false },
  { kind: 'instagram', label: 'Instagram Live', ingestHint: 'rtmps://edgetee-upload-…instagram.com:443/rtmp/', keyLabel: 'Stream key (Instagram Live Producer, professional accounts)', needsKey: true, browserLive: false },
  { kind: 'twitch', label: 'Twitch', ingestHint: 'rtmps://live.twitch.tv/app', keyLabel: 'Primary stream key (Creator Dashboard → Settings → Stream)', needsKey: true, browserLive: false },
  { kind: 'inhouse', label: 'In-house portal', ingestHint: 'The watch page — no key needed', keyLabel: '', needsKey: false, browserLive: true },
];

/** YouTube's HLS ingestion endpoint; the stream key goes in `cid`, the file name is appended to `file=`. */
export const YOUTUBE_HLS_INGEST = 'https://a.upload.youtube.com/http_upload_hls';
/** Segments kept per job for the in-house portal (the playlist lists them all). */
export const LIVE_KEEP = 8;
/** A live job that has not received a segment for this long is no longer live (the publisher's tab is gone). */
export const LIVE_STALE_MS = 20_000;
/** The target segment length the publisher's browser cuts at (a keyframe every two seconds). */
export const LIVE_SEGMENT_S = 2;

export interface Destination {
  kind: DestinationKind;
  label: string;
  enabled: boolean;
  ingestUrl: string;
  /** Never returned in full by the API: only the last 4 characters. */
  keyHint: string;
  updatedAt: string;
}

export interface DestinationUpdate {
  enabled: boolean;
  ingestUrl?: string;
  /** Full key; stored encrypted server-side, omitted to keep the existing one. */
  streamKey?: string;
  label?: string;
}

export type PublishJobState = 'requested' | 'starting' | 'live' | 'stopping' | 'stopped' | 'failed';

/** What the publisher's browser has delivered so far, and how YouTube took it. */
export interface PublishJobLive {
  segments: number;
  bytes: number;
  lastSegmentAt: string | null;
  /** off = not a destination of this job; ok = YouTube accepted the last segment; rejected = the key is wrong (401) or the segment refused (400); error = YouTube unreachable / 5xx. */
  youtube: 'off' | 'waiting' | 'ok' | 'rejected' | 'error';
  youtubeNote: string;
  /** The segments carry sound (AAC); false when the publisher's browser could only encode the picture. */
  audio?: boolean;
}

export interface PublishJob {
  jobId: string;
  meetId: string;
  meetTitle: string;
  ownerUserId: string;
  destinations: DestinationKind[];
  title: string;
  description: string;
  state: PublishJobState;
  /** Where the audience can watch (in-house), once live. */
  watchUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  events: { at: string; state: PublishJobState; note: string }[];
  /** Absent on jobs made before browser publishing existed. */
  live?: PublishJobLive;
}

/** One segment of a live job as the in-house portal lists it. */
export interface LiveSegmentInfo {
  seq: number;
  name: string;
  durationMs: number;
  createdAt: string;
}

/** `GET /watch/:id/live` — is the show on, and where is its playlist. */
export interface LiveStatus {
  live: boolean;
  jobId: string | null;
  segments: number;
  lastSegmentAt: string | null;
  /** Relative to the service origin: `/watch/<meet>/live.m3u8`. */
  playlistPath: string | null;
  /** The stream has sound of its own (else the page plays the stage mix for sound). */
  audio: boolean;
}

export interface PublishJobRequest {
  meetId: string;
  destinations: DestinationKind[];
  title: string;
  description: string;
}

/** Account record kept in the SVT DB (name/picture mirror the Google profile). */
export interface UserRecord {
  userId: string;
  email: string;
  name: string;
  picture: string;
  privileged: boolean;
  createdAt: string;
  lastSeenAt: string;
}
