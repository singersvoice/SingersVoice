/**
 * Publishing mode — privileged users push a meet's composed stream to YouTube, Facebook,
 * Instagram, Twitch and/or the in-house watch portal. Destinations hold the ingest details; a
 * publish job is one broadcast of one meet.
 *
 * How the picture and sound travel today: the publisher's own browser (the show view) encodes the
 * show — H.264 + AAC, one-second MPEG-TS segments — and PUTs each segment to the service, which
 * keeps a rolling window for the in-house portal (an HLS playlist anyone can play) and forwards it,
 * with a playlist, to YouTube's HLS ingestion. No media server. Facebook, Instagram and Twitch take
 * RTMP(S) only, which a browser cannot speak: with the RTMP relay deployed (services/relay,
 * docs/RELAY.md) the service hands every segment on to it and one ffmpeg per show writes them to
 * each RTMP target — YouTube included, at its ultra-low latency; without a relay those three stay
 * queued and YouTube runs through HLS ingestion (half a minute behind).
 */
export type DestinationKind = 'youtube' | 'facebook' | 'instagram' | 'twitch' | 'inhouse';

export const DESTINATIONS: {
  kind: DestinationKind;
  label: string;
  /** The platform's short name, for buttons ("YouTube link"). */
  short: string;
  ingestHint: string;
  keyLabel: string;
  needsKey: boolean;
  /** The browser alone can feed it (YouTube's HLS ingestion, the watch page); the others need the relay (services/relay), which also gives YouTube its low-latency RTMP path. */
  browserLive: boolean;
  /** What the live link looks like there — the page viewers open to watch you (the in-house watch page is made by the service). */
  watchHint: string;
}[] = [
  { kind: 'youtube', label: 'YouTube Live', short: 'YouTube', ingestHint: 'rtmps://a.rtmps.youtube.com:443/live2', keyLabel: 'Stream key (YouTube Studio → Go live → Stream key)', needsKey: true, browserLive: true, watchHint: 'https://www.youtube.com/@YourChannel/live' },
  { kind: 'facebook', label: 'Facebook Live', short: 'Facebook', ingestHint: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyLabel: 'Stream key (Live Producer → Streaming software)', needsKey: true, browserLive: false, watchHint: 'https://www.facebook.com/YourPage/live' },
  { kind: 'instagram', label: 'Instagram Live', short: 'Instagram', ingestHint: 'rtmps://edgetee-upload-…instagram.com:443/rtmp/', keyLabel: 'Stream key (Instagram Live Producer, professional accounts)', needsKey: true, browserLive: false, watchHint: 'https://www.instagram.com/yourname/live/' },
  { kind: 'twitch', label: 'Twitch', short: 'Twitch', ingestHint: 'rtmps://live.twitch.tv/app', keyLabel: 'Primary stream key (Creator Dashboard → Settings → Stream)', needsKey: true, browserLive: false, watchHint: 'https://www.twitch.tv/yourchannel' },
  { kind: 'inhouse', label: 'In-house portal', short: 'Watch page', ingestHint: 'The watch page — no key needed', keyLabel: '', needsKey: false, browserLive: true, watchHint: '' },
];

/**
 * A YouTube link of any shape the publisher may have copied → the page viewers open, or null when it
 * is not one of YouTube's: a Studio page (`studio.youtube.com/video/<id>/livestreaming` — the owner's
 * dashboard, which viewers cannot open), `youtu.be/<id>`, `youtube.com/live/<id>` and `watch?v=<id>`
 * all become `youtube.com/watch?v=<id>`; a channel (`/@handle`, `/channel/<id>`, `/c/<name>`,
 * `/user/<name>`) becomes its `/live` page (always the channel's current live stream).
 */
export function youtubeWatchUrl(url: string): string | null {
  const m = /^https?:\/\/(?:www\.|m\.)?([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const parts = (m[2] ?? '').split('/').filter(Boolean);
  const query = m[3] ?? '';
  const id = (x: string | undefined): string | null => (x && /^[A-Za-z0-9_-]{6,64}$/.test(x) ? x : null);
  const watch = (x: string) => `https://www.youtube.com/watch?v=${x}`;
  if (host === 'youtu.be') return id(parts[0]) ? watch(parts[0]!) : null;
  if (host === 'studio.youtube.com') return parts[0] === 'video' && id(parts[1]) ? watch(parts[1]!) : null;
  if (host !== 'youtube.com') return null;
  if (parts[0] === 'watch') {
    const v = /(?:^|&)v=([^&]+)/.exec(query)?.[1];
    return id(v) ? watch(v!) : null;
  }
  if (parts[0] === 'live') return id(parts[1]) ? watch(parts[1]!) : null;
  if (parts[0]?.startsWith('@') && parts[0].length > 1) return `https://www.youtube.com/${parts[0]}/live`;
  if ((parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') && parts[1]) return `https://www.youtube.com/${parts[0]}/${parts[1]}/live`;
  return null;
}

/**
 * A platform's live link as the publisher typed it → the https page viewers open, '' when empty,
 * null when it is not a link: a bare YouTube handle (`@channel`, or the channel name) becomes its
 * `/live` page (always the channel's current live stream), a bare Twitch channel its page, a bare
 * Facebook page / Instagram name its live page; a YouTube link of any shape becomes the page
 * viewers open (`youtubeWatchUrl`); anything else must be an https URL.
 */
export function normalizeWatchUrl(kind: DestinationKind, input: string): string | null {
  const v = input.trim();
  if (!v) return '';
  if (/^https?:\/\/\S+$/i.test(v)) {
    const https = v.replace(/^http:\/\//i, 'https://');
    if (kind === 'youtube' && /youtu\.?be/i.test(https)) return youtubeWatchUrl(https) ?? https;
    return https;
  }
  if (/[\s/?#]/.test(v)) return null;
  const name = v.replace(/^@/, '');
  if (!/^[\w.-]{1,64}$/.test(name)) return null;
  switch (kind) {
    case 'youtube':
      return `https://www.youtube.com/@${name}/live`;
    case 'twitch':
      return `https://www.twitch.tv/${name}`;
    case 'facebook':
      return `https://www.facebook.com/${name}/live`;
    case 'instagram':
      return `https://www.instagram.com/${name}/live/`;
    default:
      return null;
  }
}

/** The destinations the RTMP relay (services/relay) carries — everything that takes RTMP(S). With a relay configured, YouTube goes this way too (its ultra-low-latency setting is RTMP only). */
export const RELAY_KINDS: DestinationKind[] = ['youtube', 'facebook', 'instagram', 'twitch'];

/** The destinations a publish job can feed from the publisher's browser: through the service alone, or through the relay when there is one. */
export const fedDestinations = (wanted: DestinationKind[], relay: boolean): DestinationKind[] => wanted.filter((k) => DESTINATIONS.find((d) => d.kind === k)?.browserLive || (relay && RELAY_KINDS.includes(k)));

/** YouTube's HLS ingestion endpoint; the stream key goes in `cid`, the file name is appended to `file=`. */
export const YOUTUBE_HLS_INGEST = 'https://a.upload.youtube.com/http_upload_hls';
/**
 * The Google permission that lets the app run the publisher's YouTube channel for them (YouTube Data API v3:
 * the HLS stream key made once, a broadcast made per show with its public link, the stream's own status
 * read, the broadcast ended on Stop) — asked for once, under Destinations → Connect YouTube.
 */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
/** The public page of a YouTube broadcast. */
export const youtubeBroadcastUrl = (broadcastId: string): string => `https://www.youtube.com/watch?v=${broadcastId}`;
/** Segments kept per job for the in-house portal (the playlist lists them all): a dozen seconds of show. */
export const LIVE_KEEP = 12;
/** A live job that has not received a segment for this long is no longer live (the publisher's tab is gone). */
export const LIVE_STALE_MS = 20_000;
/**
 * The target segment length the publisher's browser cuts at — a keyframe every second. Latency is
 * made of segments: one in the making, one on the way, a few in the viewer's buffer — one-second
 * segments put the watch page about 4 s behind the stage and YouTube (RTMP through the relay,
 * ultra-low latency) 3–5 s, at a little more bitrate for the extra keyframes. YouTube's HLS
 * ingestion asks for 1–4 s segments.
 */
export const LIVE_SEGMENT_S = 1;

export interface Destination {
  kind: DestinationKind;
  label: string;
  enabled: boolean;
  ingestUrl: string;
  /** Never returned in full by the API: only the last 4 characters. */
  keyHint: string;
  /** Where viewers watch you on this platform (your channel's live page): the live-link button of a show on air. Absent on the in-house portal (the service makes its watch page). */
  watchUrl?: string;
  /** YouTube, connected: the app runs the channel through the YouTube API — the key was made by it, each show gets a broadcast and its own link. */
  auto?: boolean;
  updatedAt: string;
}

export interface DestinationUpdate {
  enabled: boolean;
  ingestUrl?: string;
  /** Full key; stored encrypted server-side, omitted to keep the existing one. */
  streamKey?: string;
  label?: string;
  /** The live link (see `normalizeWatchUrl`); omitted to keep the existing one, '' to clear it. */
  watchUrl?: string;
  /** See `Destination.auto`; omitted to keep the existing value. */
  auto?: boolean;
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
  /** The RTMP relay (services/relay): off = none configured or no RTMP destination; ok = it took the last segment; error = it could not. */
  relay?: 'off' | 'starting' | 'ok' | 'error';
  relayNote?: string;
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
  /** The public page of this show on each platform, where the app made it (a YouTube broadcast of its own): the live-link buttons prefer these to the destination's standing link. */
  links?: Partial<Record<DestinationKind, string>>;
  /** The YouTube broadcast and stream this show goes out as, when the app made them (ended on Stop; their status read while live). */
  youtube?: { broadcastId: string; streamId: string };
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
  /** The public page of this show on a platform where the app made it (see `PublishJob.links`). */
  links?: Partial<Record<DestinationKind, string>>;
  /** The YouTube broadcast and stream the app made for this show (see `PublishJob.youtube`). */
  youtube?: { broadcastId: string; streamId: string };
}

/** The plans an account can be on. Publishing mode is part of `publisher` (and of a privileged admin account). */
export type PlanId = 'free' | 'publisher';

/** Account record kept in the SVT DB (name/picture mirror the Google profile). */
export interface UserRecord {
  userId: string;
  email: string;
  name: string;
  picture: string;
  /** An admin: Publishing mode without a plan, and the right to grant plans. The first account ever seen is one. */
  privileged: boolean;
  plan: PlanId;
  /** When the plan lapses unless renewed (null = no end), ISO. */
  planUntil: string | null;
  /** Publishing mode is open to this account: privileged, or on an active Publisher plan. */
  canPublish: boolean;
  createdAt: string;
  lastSeenAt: string;
}

/** `GET /billing`: where this account stands and what the Publisher plan costs. */
export interface BillingStatus {
  plan: PlanId;
  planUntil: string | null;
  canPublish: boolean;
  privileged: boolean;
  /** The service can start a Checkout (Stripe is configured). */
  checkout: boolean;
  /** This account has a Stripe customer, so the portal (change card, cancel, invoices) is available. */
  portal: boolean;
  /** The Publisher price as Stripe has it (minor units, e.g. 1499 = $14.99), or null when unknown. */
  price: { amount: number; currency: string; interval: 'day' | 'week' | 'month' | 'year' } | null;
  plans: Record<PlanId, { title: string; blurb: string }>;
}
