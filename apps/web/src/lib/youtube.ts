/**
 * YouTube, run by the app (the YouTube Data API v3, with the publisher's own Google sign-in and one
 * extra permission — Destinations → Connect YouTube): the HLS stream key is made once (a reusable
 * stream of the channel), every show gets a broadcast of its own with its public link
 * (youtube.com/watch?v=…) the moment the publisher taps Go live, the stream's status is YouTube's
 * own word while the show runs (receiving / not receiving, live), and the broadcast is ended on Stop.
 * Nothing to paste, nothing to look up in YouTube Studio. See docs/GOOGLE_OAUTH.md for the two
 * switches in the Google Cloud console this needs (the API enabled, the scope on the consent screen).
 */
import { YOUTUBE_SCOPE, youtubeBroadcastUrl } from '@singersvoice/protocol';
import { loadStoredToken, requestToken, YOUTUBE_WANTED_KEY, type GoogleToken } from './google.ts';

const API = 'https://www.googleapis.com/youtube/v3';
/** Fetch, replaceable by the tests. */
export let youtubeFetch: typeof fetch = (...a) => fetch(...a);
export function _setYoutubeFetch(f: typeof fetch | null): void {
  youtubeFetch = f ?? ((...a) => fetch(...a));
}

export type YoutubePrivacy = 'public' | 'unlisted' | 'private';

/** Whether a token carries the YouTube permission (and is still good). */
export const youtubeGranted = (t: GoogleToken | null): t is GoogleToken => Boolean(t && t.expiresAt > Date.now() && t.scope.split(' ').includes(YOUTUBE_SCOPE));

/** Connect YouTube: the Google screen once more, with the YouTube permission; from now on every token carries it. Must run from a tap. */
export async function connectYoutube(hint?: string): Promise<GoogleToken> {
  try {
    localStorage.setItem(YOUTUBE_WANTED_KEY, '1');
  } catch {
    /* no storage: the permission is asked for each time */
  }
  return requestToken({ prompt: 'consent', hint, youtube: true });
}

export function forgetYoutube(): void {
  try {
    localStorage.removeItem(YOUTUBE_WANTED_KEY);
  } catch {
    /* nothing to forget */
  }
}

/** A token with the YouTube permission: the stored one, else a silent re-issue (needs a user gesture on iOS). */
export async function youtubeToken(hint?: string): Promise<GoogleToken> {
  const stored = loadStoredToken();
  if (youtubeGranted(stored)) return stored;
  const t = await requestToken({ prompt: '', hint, youtube: true });
  if (!youtubeGranted(t)) throw new YoutubeError('YouTube access is missing — Connect YouTube again under Publishing › Destinations', 'insufficientPermissions');
  return t;
}

export class YoutubeError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

/** YouTube's reasons, in the publisher's words. */
export function youtubeReason(reason: string, fallback: string): string {
  switch (reason) {
    case 'liveStreamingNotEnabled':
      return 'Live streaming is not enabled on this YouTube channel yet — turn it on in YouTube Studio (Create → Go live, verify the channel); YouTube takes up to 24 hours the first time';
    case 'insufficientPermissions':
    case 'authError':
    case 'forbidden':
      return 'YouTube access is missing — Connect YouTube again under Publishing › Destinations';
    case 'quotaExceeded':
    case 'rateLimitExceeded':
      return "YouTube's daily API allowance is used up — try again tomorrow, or paste a stream key and your live link by hand";
    case 'accessNotConfigured':
      return 'The YouTube Data API is not enabled for this app yet — Google Cloud console → APIs & Services → Library → YouTube Data API v3 → Enable (docs/GOOGLE_OAUTH.md)';
    default:
      return fallback;
  }
}

async function call<T>(token: GoogleToken, method: 'GET' | 'POST' | 'PUT', path: string, params: Record<string, string>, body?: unknown): Promise<T> {
  const q = new URLSearchParams(params).toString();
  const r = await youtubeFetch(`${API}/${path}?${q}`, {
    method,
    headers: { Authorization: `Bearer ${token.accessToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!r.ok) {
    const e = (json as { error?: { message?: string; errors?: { reason?: string }[] } } | null)?.error;
    const reason = e?.errors?.[0]?.reason ?? (r.status === 401 ? 'authError' : r.status === 403 ? 'forbidden' : `http_${r.status}`);
    throw new YoutubeError(youtubeReason(reason, `YouTube: ${e?.message ?? `HTTP ${r.status}`}`), reason);
  }
  return json as T;
}

interface StreamItem {
  id: string;
  snippet?: { title?: string };
  cdn?: { ingestionType?: string; ingestionInfo?: { streamName?: string; ingestionAddress?: string } };
  status?: { streamStatus?: string; healthStatus?: { status?: string } };
}
interface BroadcastItem {
  id: string;
  status?: { lifeCycleStatus?: string; privacyStatus?: string };
}

/** Whether a stream key is the one the service keeps, by the hint the service hands out (its last characters, "…abcd"). */
export function keyMatchesHint(streamKey: string, keyHint: string): boolean {
  const tail = keyHint.replace(/^…/, '').trim();
  return tail.length > 0 && streamKey.endsWith(tail);
}

export interface HlsStream {
  streamId: string;
  /** The stream key (YouTube's "stream name"): kept by the service, encrypted; never shown whole again. */
  streamKey: string;
  ingestionAddress: string;
}

/**
 * The channel's reusable HLS stream — found, or made now (one per channel, "SingersVoice"). A channel may hold
 * several HLS streams (one made in YouTube Studio, say): the one whose key the service keeps (`keyHint`, its last
 * characters) comes first, then the app's own, so the broadcast is bound to the very stream the show is sent to —
 * bound to another, the show would go live on that stream's own broadcast (private, as YouTube Studio makes them).
 */
export async function ensureHlsStream(token: GoogleToken, keyHint = ''): Promise<HlsStream> {
  const list = await call<{ items?: StreamItem[] }>(token, 'GET', 'liveStreams', { part: 'id,snippet,cdn,status', mine: 'true', maxResults: '50' });
  const hls = (list.items ?? []).filter((i) => i.cdn?.ingestionType === 'hls' && i.cdn.ingestionInfo?.streamName);
  let item = (keyHint ? hls.find((i) => keyMatchesHint(i.cdn!.ingestionInfo!.streamName!, keyHint)) : undefined) ?? hls.find((i) => i.snippet?.title === 'SingersVoice') ?? hls[0];
  if (!item) {
    item = await call<StreamItem>(token, 'POST', 'liveStreams', { part: 'id,snippet,cdn,contentDetails,status' }, {
      snippet: { title: 'SingersVoice', description: 'The SingersVoice stage, streamed by the app (HLS)' },
      cdn: { ingestionType: 'hls', resolution: 'variable', frameRate: 'variable' },
      contentDetails: { isReusable: true },
    });
  }
  const key = item.cdn?.ingestionInfo?.streamName;
  if (!key) throw new YoutubeError('YouTube made a stream without a key — try Connect YouTube again', 'noStreamKey');
  return { streamId: item.id, streamKey: key, ingestionAddress: item.cdn?.ingestionInfo?.ingestionAddress ?? '' };
}

export interface Broadcast {
  broadcastId: string;
  watchUrl: string;
}

/**
 * A broadcast for this show — made now, bound to the HLS stream, set to go live by itself when the stream arrives
 * and to end when it stops. Its visibility is read back and put right if YouTube did not take it (a private video
 * is one nobody can open by its link).
 */
export async function startBroadcast(token: GoogleToken, o: { title: string; streamId: string; privacy: YoutubePrivacy; description?: string }): Promise<Broadcast> {
  const b = await call<BroadcastItem>(token, 'POST', 'liveBroadcasts', { part: 'id,snippet,status,contentDetails' }, {
    snippet: { title: o.title.slice(0, 100) || 'SingersVoice live', description: (o.description ?? 'Live on SingersVoice').slice(0, 5000), scheduledStartTime: new Date().toISOString() },
    status: { privacyStatus: o.privacy, selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true, recordFromStart: true, monitorStream: { enableMonitorStream: false }, latencyPreference: 'low' },
  });
  await call<unknown>(token, 'POST', 'liveBroadcasts/bind', { id: b.id, part: 'id', streamId: o.streamId });
  if (b.status?.privacyStatus && b.status.privacyStatus !== o.privacy) await setBroadcastPrivacy(token, b.id, o.privacy);
  return { broadcastId: b.id, watchUrl: youtubeBroadcastUrl(b.id) };
}

/** Change a broadcast's visibility (unlisted: anyone with the link; public: on the channel for everyone). */
export async function setBroadcastPrivacy(token: GoogleToken, broadcastId: string, privacy: YoutubePrivacy): Promise<void> {
  await call<unknown>(token, 'PUT', 'liveBroadcasts', { part: 'id,status' }, { id: broadcastId, status: { privacyStatus: privacy } });
}

export interface YoutubeStatus {
  /** created · ready · testing · live · complete · revoked · (unknown) */
  broadcast: string;
  /** active · inactive · ready · error · (unknown) */
  stream: string;
  /** good · ok · bad · noData · (unknown) */
  health: string;
  /** public · unlisted · private · (unknown) — who can open the link. */
  privacy?: string;
}

/** YouTube's own word on the show: the broadcast's life cycle and visibility, and whether the stream is coming in. */
export async function youtubeStatus(token: GoogleToken, broadcastId: string, streamId: string): Promise<YoutubeStatus> {
  const [b, s] = await Promise.all([
    call<{ items?: BroadcastItem[] }>(token, 'GET', 'liveBroadcasts', { part: 'status', id: broadcastId }),
    call<{ items?: StreamItem[] }>(token, 'GET', 'liveStreams', { part: 'status', id: streamId }),
  ]);
  const bs = b.items?.[0]?.status;
  return { broadcast: bs?.lifeCycleStatus ?? 'unknown', stream: s.items?.[0]?.status?.streamStatus ?? 'unknown', health: s.items?.[0]?.status?.healthStatus?.status ?? 'unknown', ...(bs?.privacyStatus ? { privacy: bs.privacyStatus } : {}) };
}

export interface YoutubeWord {
  text: string;
  ok: boolean;
  /** YouTube says the video is private: nobody can open its link (the bar offers to make it unlisted). */
  privateVideo?: boolean;
}

/** The status in the publisher's words, for the bar: the visibility first — a private video is the one thing viewers cannot get past. */
export function youtubeWord(s: YoutubeStatus): YoutubeWord {
  const receiving = s.stream === 'active' && s.health !== 'noData';
  if (s.privacy === 'private' && s.broadcast !== 'complete' && s.broadcast !== 'revoked') return { text: 'YouTube: the video is PRIVATE — nobody can open the link', ok: false, privateVideo: true };
  const seen = s.privacy === 'unlisted' ? ' · unlisted (anyone with the link)' : s.privacy === 'public' ? ' · public' : '';
  if (s.broadcast === 'live') return { text: `YouTube: live${seen} · stream ${receiving ? (s.health === 'good' ? 'good' : s.health) : 'not coming in'}`, ok: receiving };
  if (s.broadcast === 'complete' || s.broadcast === 'revoked') return { text: `YouTube: the broadcast is ${s.broadcast === 'complete' ? 'over — the video stays at the link' : 'revoked'}`, ok: false };
  if (receiving) return { text: `YouTube: receiving the stream (${s.health}) · going live…${seen}`, ok: true };
  return { text: `YouTube: not receiving the stream yet${seen}`, ok: false };
}

/** End the broadcast (Stop publishing); a broadcast that never went live, or is over already, is left as it is. */
export async function endBroadcast(token: GoogleToken, broadcastId: string): Promise<void> {
  try {
    await call<unknown>(token, 'POST', 'liveBroadcasts/transition', { broadcastStatus: 'complete', id: broadcastId, part: 'status' });
  } catch (e) {
    if (e instanceof YoutubeError && /Transition|transition|invalidTransition|redundantTransition/.test(e.reason)) return;
    throw e;
  }
}
