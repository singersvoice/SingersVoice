/**
 * Publishing mode — privileged users push a meet's composed stream to YouTube, Facebook,
 * Instagram, Twitch and/or the in-house watch portal. Destinations hold the RTMP(S) ingest
 * details; a publish job is the request the session container executes (encoder → RTMPS).
 */
export type DestinationKind = 'youtube' | 'facebook' | 'instagram' | 'twitch' | 'inhouse';

export const DESTINATIONS: { kind: DestinationKind; label: string; ingestHint: string; keyLabel: string; needsKey: boolean }[] = [
  { kind: 'youtube', label: 'YouTube Live', ingestHint: 'rtmps://a.rtmps.youtube.com:443/live2', keyLabel: 'Stream key (YouTube Studio → Go live → Stream key)', needsKey: true },
  { kind: 'facebook', label: 'Facebook Live', ingestHint: 'rtmps://live-api-s.facebook.com:443/rtmp/', keyLabel: 'Stream key (Live Producer → Streaming software)', needsKey: true },
  { kind: 'instagram', label: 'Instagram Live', ingestHint: 'rtmps://edgetee-upload-…instagram.com:443/rtmp/', keyLabel: 'Stream key (Instagram Live Producer, professional accounts)', needsKey: true },
  { kind: 'twitch', label: 'Twitch', ingestHint: 'rtmps://live.twitch.tv/app', keyLabel: 'Primary stream key (Creator Dashboard → Settings → Stream)', needsKey: true },
  { kind: 'inhouse', label: 'In-house portal', ingestHint: 'LL-HLS on Cloudflare Stream / R2 — no key needed', keyLabel: '', needsKey: false },
];

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
