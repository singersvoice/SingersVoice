/**
 * sv-control — the SVT DB API (Hono). Runs unchanged on Node (@hono/node-server) and on
 * Cloudflare Workers; storage and auth are injected per runtime.
 *
 * Portals it serves (each independent of the others):
 *   /catalog/*      Tracks portal — public track catalog (SVT DB) backed by owners' Drive links
 *   /meets/*        Live Meets — rooms, stage slots, GMT kickstart, chat, recordings, 5-min idle expiry
 *   /watch/*        In-house watch portal (public, no sign-in)
 *   /publishing/*   Publishing mode — destinations + publish jobs (privileged users)
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  DESTINATIONS,
  MAX_OPEN_MEETS,
  bookmarkKey,
  type BookmarkKind,
  meetIsOpen,
  newId,
  newToken,
  httpsLink,
  normalizeWatchUrl,
  type CatalogPublishRequest,
  type CatalogTrack,
  isDriveUrl,
  isRegistryId,
  registrySourceKey,
  youtubeVideoId,
  type RegisterTrackRequest,
  type TrackAccessRequest,
  type TrackCopyRequest,
  type TrackFileRefs,
  type TrackMetaPatch,
  type ChatMessage,
  type ChatRequest,
  type CreateMeetRequest,
  type Destination,
  type DestinationKind,
  type DestinationUpdate,
  type HeartbeatRequest,
  type IceServer,
  type JoinMeetRequest,
  type Meet,
  type MeetSnapshot,
  type Participant,
  type PublishJob,
  type PublishJobRequest,
  type ReadyRequest,
  type InviteRequest,
  type JoinLayer,
  MAX_LAYERS,
  type MeetPerformance,
  type MixBatch,
  type RegisterPerformanceRequest,
  type RegisterRecordingRequest,
  type SignalRequest,
  type SlotRequest,
  type DecideRequest,
  type SongPick,
  type StartMeetRequest,
  type UserRecord,
  type PlanId,
  asPlanId,
  mediaOfEntitlement,
  periodEnd,
  periodKey,
  periodLabel,
  periodResetsAt,
  planOf,
  type AdminBillingOverview,
  type BillingSettings,
  type ClubStatus,
  type PlansResponse,
  type SubscriberRow,
  type SubscriptionStanding,
  displayCode,
  newCouponCode,
  normalizeCode,
  type AdminCouponsResponse,
  type CouponSettings,
  discountCents,
  freeUntil,
  moneyLabel,
  offerOnSale,
  promoPreview,
  promoRefusal,
  type PlanOffer,
  type PlanOfferInput,
  type PromoCode,
  type PromoCodeInput,
  CAPTION_MAX,
  SOCIAL_NETWORKS,
  type AdminSocialStatus,
  type AdminSocialUpdate,
  type SocialNetwork,
  type SocialPage,
  type SocialPost,
  type SocialStatus,
  LIVE_STALE_MS,
  RELAY_KINDS,
  YOUTUBE_HLS_INGEST,
  fedDestinations,
  type LiveSegmentInfo,
  type LiveStatus,
  type PublishJobLive,
  youtubeWatchUrl,
  YT_SEARCH_LIMIT,
  yearFrom,
  daysLeft,
  type AdminUserUpdate,
  type AdminUsersResponse,

  type PerformanceChapter,
  type YtFetchRequest,
  type YtJob,
  type YtSearchResponse,
  type YtStatus,
} from '@singersvoice/protocol';
import type { Authenticator } from './auth.ts';
import type { SecretBox } from './crypto.ts';
import { MeetEvents, type RoomViews } from './events.ts';
import { normalizeTvCode, TV_SIGNAL_MAX_BYTES, TvScreens, type TvSide } from './tv.ts';
import { fbPostVideo, fbVideoUrl, igContainerStatus, igCreateReel, igPublish, metaAuthorizeUrl, metaConfigured, metaExchange, metaPages, pkce, randomToken, xAuthorizeUrl, xConfigured, xCreatePost, xExchange, xMe, xPostUrl, xRefresh, xRevoke, xUploadVideo, type MetaPage, type SocialConfig } from './social.ts';
import { addSong, claimSlot, decideRequest, ensureMeet, isBanned, isHost, kick, newMeet, nextSong, pause, reconcile, reportClock, requestStage, resume, setBackground, setReady, setStagePolicy, songAction, start, stop, tick, touch, touchForHeartbeat, visibleParticipants, withdrawRequest, seek, canTransport } from './meets.ts';
import { hlsPlaylist, SEGMENT_NAME, sendToYoutube, youtubeWindow } from './live.ts';
import { fetchPublicDriveFile } from './driveFiles.ts';
import { chargeFacts, createCheckoutSession, createCoupon, createPortalSession, createRefund, retrieveCheckoutSession, retrieveSubscription, stripeConfigured, subscriptionKeepsPlan, unixIso, verifyStripeSignature, type BillingConfig, type StripeCheckoutSession, type StripeSubscription } from './billing.ts';
import { relayJson, relayNote, relaySegment, relayStart, relayStop, type RelayConfig, type RelayOutcome, type RelayTarget } from './relay.ts';
import type { SocialApps, SqlStore, StoredParticipant } from './store/sql.ts';

export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/** ICE_SERVERS env: a JSON array of RTCIceServer ({urls, username?, credential?}); invalid or empty → STUN defaults. */
export function parseIceServers(raw: string | undefined): IceServer[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || !v.length) return undefined;
    const out = v.filter((x): x is IceServer => Boolean(x && typeof x === 'object' && (x as IceServer).urls));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface AppDeps {
  /** ICE servers handed to performers (ICE_SERVERS env, JSON array); STUN only by default. */
  iceServers?: IceServer[];
  store: SqlStore;
  auth: Authenticator;
  secrets: SecretBox;
  runtime: 'node' | 'cloudflare';
  allowedOrigins: string[];
  privilegedEmails: string[];
  version: string;
  /** YouTube's HLS ingestion endpoint (YOUTUBE_HLS_BASE env; tests point it at the fake below). */
  youtubeHlsBase?: string;
  /** Node, tests and local dev only: accept YouTube-style PUTs at /fake/youtube/http_upload_hls and keep the files in this directory. */
  fakeYoutubeDir?: string;
  /** Optional Google API key (GOOGLE_API_KEY env): the service then reads published tracks through the Drive API instead of the public download page. */
  googleApiKey?: string;
  /** Tests: how the service reaches Drive for a published track's files. */
  fetchImpl?: typeof fetch;
  /** Stripe (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, APP_URL); without a key the Plans page shows the plans and says to ask the admin, who grants them. */
  billing?: BillingConfig;
  /** The RTMP relay (RELAY_URL, RELAY_SECRET — services/relay, docs/RELAY.md): low-latency YouTube, and Facebook / Instagram / Twitch at all. */
  relay?: RelayConfig;
  /** Work that finishes after the answer went out (YouTube's PUTs for a segment): the runtime's waitUntil where there is one; tests collect these to await them. */
  background?: (p: Promise<unknown>) => void;
  /** The coupon gate's default (COUPONS_REQUIRED env, on unless '0'): what a service that never set it on the Admin page does. */
  couponsRequired?: boolean;
  /** The networks clips are posted to (X_CLIENT_ID/SECRET, META_APP_ID/SECRET, SERVICE_URL — docs/SOCIAL.md); without them the Settings page offers the share sheet alone. */
  social?: SocialConfig;
}

type Vars = { deps: AppDeps; user: UserRecord };
type Env = { Bindings: Record<string, unknown>; Variables: Vars };

/** A Drive file or folder id. */
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;

/** A chapter as a client registered it, checked field by field (null when it is not one). */
function chapterOf(c: unknown): PerformanceChapter | null {
  if (!c || typeof c !== 'object') return null;
  const x = c as Record<string, unknown>;
  const kind = x.kind === 'song' || x.kind === 'pause' || x.kind === 'stage' ? x.kind : null;
  const eventId = typeof x.eventId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x.eventId) ? x.eventId : null;
  if (!kind || !eventId) return null;
  const startedAt = typeof x.startedAt === 'string' && !Number.isNaN(Date.parse(x.startedAt)) ? new Date(x.startedAt).toISOString() : new Date().toISOString();
  return { eventId, eventTitle: String(x.eventTitle ?? '').slice(0, 60), index: Math.max(0, Math.min(100_000, Math.round(Number(x.index) || 0))), kind, trackId: String(x.trackId ?? '').slice(0, 120), trackTitle: String(x.trackTitle ?? '').slice(0, 120), songEpoch: Math.max(0, Math.round(Number(x.songEpoch) || 0)), startedAt, startMs: Math.max(0, Math.round(Number(x.startMs) || 0)), ...(typeof x.songMs === 'number' && Number.isFinite(x.songMs) ? { songMs: Math.max(0, Math.round(x.songMs)) } : {}) };
}

const DEFAULT_ORIGINS = ['https://www.singersvoice.com', 'https://singersvoice.com', 'https://singersvoice.github.io', 'https://singersvoice.pages.dev', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];
/** A Cloudflare Pages preview of the site (a branch, a commit) is one of ours too. */
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.singersvoice\.pages\.dev$/;
const originAllowed = (origin: string, extra: readonly string[] = []): boolean => DEFAULT_ORIGINS.includes(origin) || extra.includes(origin) || PREVIEW_ORIGIN.test(origin);

/** An account whose meets are a club's: the club owner role with its plan in force (seats to name members). */
const clubOwnerOf = (u: UserRecord): boolean => u.role === 'club_owner' && u.entitlement.plan === 'club';

function err(c: Context<Env>, status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429, code: string, message: string) {
  return c.json({ error: message, code }, status);
}

const userTouch = new Map<string, number>();

/** What a SQLite-backed Durable Object says when the day's storage allowance is spent (free plan: rows written, rows read). */
const STORAGE_LIMIT = /exceeded allowed rows (written|read)|rows (written|read).*(limit|exceeded)|storage.*(limit|quota).*exceeded/i;

/** Seconds until the next 00:00 UTC, when a Durable Object's daily allowances start over. */
export function secondsToUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(60, Math.ceil((midnight - now) / 1000));
}

/** The storage budget, in the singer's terms: what cannot happen, until when, and that nothing saved is lost. */
export function storageLimitNote(runtimeMessage: string, retryAfterS: number): string {
  const h = Math.floor(retryAfterS / 3600);
  const m = Math.ceil((retryAfterS % 3600) / 60);
  const when = h > 0 ? `${h} h ${m} min` : `${m} min`;
  const what = /read/i.test(runtimeMessage) && !/written/i.test(runtimeMessage) ? 'read anything more' : 'save anything more';
  return `The SingersVoice service cannot ${what} today — its daily storage allowance is spent. It starts over at 00:00 UTC (in ${when}). Nothing already saved is lost.`;
}

const requestLog = typeof process !== 'undefined' && process.env?.SV_REQUEST_LOG === '1';

/** A device's event stream is kept this long at most; the browser opens it again at once (and fetches the state as it does). */
const EVENTS_MAX_MS = 20 * 60_000;
/** A comment line this often keeps the event stream's connection alive through proxies and the edge. */
const EVENTS_PING_MS = 25_000;
/** The event stream's own path: the resume token in its query is the credential (the browser's EventSource sends no headers). */
const EVENTS_PATH = /^\/meets\/[^/]+\/events$/;
/** A TV screen's own routes (tv.ts): the TV has no sign-in — its token is its credential; `tv=` in the query says a TV speaks. */
const TV_PATH = /^\/tv\/screens(\/[A-Za-z0-9]+\/(events|signal|bye))?$/;
/** New screens an address may register a minute (a TV page reloading is a few; a flood is not). */
const TV_CREATE_PER_MIN = 20;
const SOCIAL_CALLBACK = /^\/social\/(x|meta)\/callback$/;
const CHAT_WINDOW_MS = 10_000;
const CHAT_PER_WINDOW = 20;
/** Posts an account may start in an hour, and the clip's size (a Worker takes 100 MB in a request). */
const SOCIAL_POSTS_PER_HOUR = 12;
const SOCIAL_CLIP_MAX_BYTES = 95 * 1024 * 1024;

export function createApp(getDeps: (env: Record<string, unknown>) => Promise<AppDeps> | AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  /** Who listens to which meet (events.ts): handed the room after every change, so no device has to fetch it. */
  const events = new MeetEvents(roomViews);
  /** The TV screens and the handshake between a phone and its TV (tv.ts). */
  const tv = new TvScreens();
  const tvCreates = new Map<string, { n: number; at: number }>();
  /** Chat lines per participant in a short window (a flood is kept out; the host kicks a pest). */
  const chatRate = new Map<string, { n: number; at: number }>();

  // The dependencies first (no I/O: the CORS answer needs the allowed origins), then CORS — before anything that can
  // fail, so an error answer carries the headers too and the browser reads it instead of calling it "unreachable" —
  // then the schema.
  app.use('*', async (c, next) => {
    const deps = await getDeps(c.env ?? {});
    c.set('deps', deps);
    // A meet persisted closed (stopped, expired, however it got there): its signals go, its streams are handed the
    // last word and closed — once, from one place, whichever route or sweep closed it.
    if (!deps.store.onMeetClosed) {
      deps.store.onMeetClosed = (meetId) => {
        void deps.store.clearSignals(meetId);
        events.changed(meetId);
        void events.close(meetId);
      };
    }
    await next();
  });

  app.use(
    '*',
    cors({
      origin: (origin, c) => {
        // The public watch portal is read-only and carries no sign-in: any origin, so the Worker can
        // cache its answers at the edge for every viewer alike (see worker.ts).
        if (c.req.path.startsWith('/watch/')) return '*';
        return originAllowed(origin, c.get('deps')?.allowedOrigins ?? []) ? origin : DEFAULT_ORIGINS[0]!;
      },
      allowHeaders: ['Authorization', 'Content-Type', 'X-Dev-User', 'X-Dev-Name'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.use('*', async (c, next) => {
    // /health and /time answer even when the schema cannot be set up (the storage budget spent): they say so.
    if (c.req.path !== '/health' && c.req.path !== '/time') await c.get('deps').store.migrate();
    // SV_REQUEST_LOG=1 (dev / CI diagnostics): one line per request with its duration.
    const t0 = requestLog ? Date.now() : 0;
    await next();
    if (requestLog) console.log(`${new Date().toISOString().slice(11, 23)} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - t0}ms`);
  });

  // ---------- public ----------

  app.get('/health', async (c) => {
    const d = c.get('deps');
    await d.store.migrate().catch(() => undefined); // the storage's word below says what went wrong
    return c.json({ ok: true as const, service: 'sv-control' as const, version: d.version, runtime: d.runtime, now: Date.now(), storage: d.store.health() });
  });
  app.get('/time', (c) => c.json({ serverEpochMs: Date.now() }));

  app.get('/watch/:id', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (tick(meet)) await store.saveMeet(meet);
    const chat = await store.chatTail(meet.meetId, 50);
    const { meetId, title, hostName, trackTitle, catalogTrackId, state, backgroundId, stage, audienceCount, kickstartEpochMs, streamUrl, expiresAt } = meet;
    return c.json({ meet: { meetId, title, hostName, trackTitle, catalogTrackId, state, backgroundId, stage, audienceCount, kickstartEpochMs, streamUrl, expiresAt }, chat, serverEpochMs: Date.now() });
  });
  // The stage mix, for the public watch page too (the host shares that link on purpose). A listener polling
  // (the fallback) or streaming (below) is what makes the host's device send the mix at all: the first one
  // in and the last one out are told to the room at once.
  app.get('/watch/:id/mix', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const since = Math.max(0, Number(c.req.query('since')) || 0);
    const before = store.mixListening(meet.meetId);
    const r = await store.listMix(meet.meetId, since);
    if (!before && store.mixListening(meet.meetId)) events.changed(meet.meetId);
    return c.json({ ...r, serverEpochMs: Date.now() });
  });
  // The mix as a stream: one request for the whole listen, every batch the moment the host's device sends it.
  app.get('/watch/:id/mix/stream', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (!meetIsOpen(meet)) return err(c, 410, 'meet_closed', 'This meet has ended');
    const since = Math.max(0, Number(c.req.query('since')) || 0);
    return streamSSE(c, async (stream) => {
      let over = false;
      let wake: (() => void) | null = null;
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: string) => {
        writes = writes.then(() => stream.writeSSE({ event, data })).catch(() => undefined);
        return writes;
      };
      const before = store.mixListening(meet.meetId);
      const off = store.streamMix(meet.meetId, since, (b) => void send('batch', JSON.stringify(b)));
      if (!off) {
        await send('end', '');
        return;
      }
      if (!before) events.changed(meet.meetId);
      const stop = () => {
        over = true;
        wake?.();
      };
      stream.onAbort(stop);
      c.req.raw.signal?.addEventListener('abort', () => stream.abort(), { once: true });
      await send('hello', JSON.stringify({ serverEpochMs: Date.now() }));
      const until = Date.now() + EVENTS_MAX_MS;
      while (!over && !stream.aborted && Date.now() < until) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, EVENTS_PING_MS);
        });
        wake = null;
        if (!over && !stream.aborted) {
          if (!store.mixListening(meet.meetId) && !store.live.meets.has(meet.meetId)) break; // the meet closed
          await send('ping', '');
        }
      }
      off();
      if (!store.mixListening(meet.meetId)) events.changed(meet.meetId);
      await writes;
    });
  });

  // The show itself, as the publisher's browser delivers it: an HLS playlist of the last few segments.
  const liveJob = async (store: SqlStore, meetId: string): Promise<PublishJob | null> => {
    const jobs = await store.liveJobsForMeet(meetId);
    return jobs.find((j) => j.state === 'live' && j.live?.lastSegmentAt && Date.now() - Date.parse(j.live.lastSegmentAt) < LIVE_STALE_MS) ?? null;
  };
  app.get('/watch/:id/live', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const job = await liveJob(store, meet.meetId);
    const status: LiveStatus = {
      live: job !== null,
      jobId: job?.jobId ?? null,
      segments: job?.live?.segments ?? 0,
      lastSegmentAt: job?.live?.lastSegmentAt ?? null,
      playlistPath: job ? `/watch/${meet.meetId}/live.m3u8` : null,
      audio: job?.live?.audio ?? false,
    };
    return c.json(status);
  });
  app.get('/watch/:id/live.m3u8', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const job = await liveJob(store, meet.meetId);
    if (!job) return err(c, 404, 'not_live', 'The show is not on');
    const segments = await store.listLiveSegments(job.jobId);
    if (!segments.length) return err(c, 404, 'not_live', 'No segment yet');
    return c.body(hlsPlaylist(segments, (name) => `live/${name}`), 200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  });
  app.get('/watch/:id/live/:name', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const name = c.req.param('name');
    if (!SEGMENT_NAME.test(name)) return err(c, 400, 'bad_name', 'Not a segment name');
    const job = await liveJob(store, meet.meetId);
    const bytes = job ? await store.getLiveSegment(job.jobId, name) : null;
    if (!bytes) return err(c, 404, 'no_segment', 'That segment is gone');
    return c.body(bytes as unknown as ArrayBuffer, 200, { 'Content-Type': 'video/MP2T', 'Cache-Control': 'max-age=60' });
  });

  // A stand-in for YouTube's ingestion endpoint (tests, local runs): keeps what it is sent in a directory.
  app.put('/fake/youtube/http_upload_hls', async (c) => {
    const { fakeYoutubeDir, runtime } = c.get('deps');
    if (!fakeYoutubeDir || runtime !== 'node') return err(c, 404, 'not_found', 'Not found');
    const file = c.req.query('file') ?? '';
    if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.includes('..')) return c.body('bad file', 400);
    if (!c.req.query('cid')) return c.body('no key', 401);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(fakeYoutubeDir, { recursive: true });
    await fs.writeFile(path.join(fakeYoutubeDir, path.basename(file)), bytes);
    return c.body('', 200);
  });

  // ---------- auth ----------

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/health' || path === '/time' || path === '/billing/webhook' || path.startsWith('/watch/') || path.startsWith('/fake/') || c.req.method === 'OPTIONS') return next();
    if (c.req.method === 'GET' && SOCIAL_CALLBACK.test(path)) return next(); // a network sends the browser back here: by the state it carries (below)
    if (c.req.method === 'GET' && EVENTS_PATH.test(path)) return next(); // the stream: by resume token (below)
    if (TV_PATH.test(path) && ((c.req.method === 'POST' && path === '/tv/screens') || (c.req.method === 'GET' && path.endsWith('/events')) || c.req.query('tv'))) return next(); // a TV (by its token), a screen's stream (by either side's token): below
    const deps = c.get('deps');
    const id = await deps.auth(c.req.raw);
    if (!id) return err(c, 401, 'unauthenticated', 'Sign in with Google to use SingersVoice');
    const privilegedByEnv = deps.privilegedEmails.includes(id.email.toLowerCase());
    const last = userTouch.get(id.userId) ?? 0;
    let user: UserRecord | null = null;
    if (Date.now() - last > 5 * 60 * 1000) {
      // The account's row follows the sign-in (the name, the picture, when last seen) a few times an hour — and when
      // that write cannot happen (the storage budget spent) the account as it stands is good enough to go on with.
      try {
        user = await deps.store.upsertUser({ userId: id.userId, email: id.email, name: id.name, picture: id.picture, ...(privilegedByEnv ? { privileged: true } : {}) });
        userTouch.set(id.userId, Date.now());
      } catch (e) {
        user = await deps.store.getUser(id.userId);
        if (!user) throw e;
      }
    } else {
      user = await deps.store.getUser(id.userId);
    }
    if (!user) user = await deps.store.upsertUser({ userId: id.userId, email: id.email, name: id.name, picture: id.picture });
    c.set('user', user);
    // An account a super admin blocked for good gets nothing but its own standing (/me) — on every request.
    if (user.blocked && user.role !== 'super_admin' && path !== '/me') return err(c, 403, 'blocked', 'This account is blocked from SingersVoice');
    // The coupon gate (coupons.ts): an account that is not in gets nothing but its own standing (/me) and the way to enter
    // a code (/coupon) — on every request, so a coupon changed, expired or withdrawn by the admin denies at once.
    if (!user.access.ok && path !== '/me' && path !== '/coupon') return err(c, 403, 'coupon_required', user.access.note || 'A coupon is needed to use SingersVoice — ask the SingersVoice admin');
    await next();
  });

  app.get('/me', (c) => c.json({ user: c.get('user') }));

  /** The singer's own details: a phone number (optional; '' takes it off). */
  app.patch('/me', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { phone?: unknown };
    if (typeof body.phone === 'string') {
      const phone = body.phone.replace(/[^\d+() .-]/g, '').trim().slice(0, 32);
      await store.setUserPhone(user.userId, phone);
    }
    return c.json({ user: (await store.getUser(user.userId))! });
  });

  // ---------- blocks: who a singer keeps out of their meets ----------

  app.get('/blocks', async (c) => c.json({ blocks: await c.get('deps').store.listBlocks(c.get('user').userId) }));

  /** Block somebody by their SingersVoice number, their email, or their id: they never get into this singer's meets (and are removed from the open ones). */
  app.put('/blocks', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { svNo?: unknown; email?: unknown; userId?: unknown };
    let target: UserRecord | null = null;
    if (typeof body.userId === 'string' && body.userId) target = await store.getUser(body.userId);
    else if (typeof body.svNo === 'number' || (typeof body.svNo === 'string' && body.svNo)) {
      const n = Number(String(body.svNo).replace(/^sv-?/i, ''));
      if (Number.isInteger(n) && n > 0) target = await store.getUserBySvNo(n);
    } else if (typeof body.email === 'string' && body.email.includes('@')) target = await store.getUserByEmail(body.email.trim());
    if (!target) return err(c, 404, 'no_such_singer', 'No singer with that number or address — ask them for their SingersVoice number (Settings → Account)');
    if (target.userId === user.userId) return err(c, 400, 'self', 'You cannot block yourself');
    await store.block(user.userId, target.userId);
    // Out of this host's open meets now.
    for (const m of await store.listMeetsForUser(user.userId, 100)) {
      if (m.hostUserId !== user.userId || !meetIsOpen(m)) continue;
      const p = await store.getParticipantByUser(m.meetId, target.userId, 'member');
      if (!p) continue;
      ensureMeet(m);
      m.bannedUserIds = [...new Set([...(m.bannedUserIds ?? []), target.userId])];
      await store.removeParticipant(m.meetId, p.participantId);
      reconcile(m, await store.listParticipants(m.meetId));
      touch(m);
      await store.saveMeet(m);
      events.changed(m.meetId);
    }
    const blocks = await store.listBlocks(user.userId);
    return c.json({ blocks, blocked: blocks.find((b) => b.userId === target!.userId)! });
  });

  /** Unblock: they may come into this singer's meets again — the open ones included (a block's removal is undone with it). */
  app.delete('/blocks/:userId', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const target = c.req.param('userId');
    await store.unblock(user.userId, target);
    for (const m of await store.listMeetsForUser(user.userId, 100)) {
      if (m.hostUserId !== user.userId || !meetIsOpen(m) || !m.bannedUserIds?.includes(target)) continue;
      ensureMeet(m);
      m.bannedUserIds = m.bannedUserIds.filter((id) => id !== target);
      await store.saveMeet(m);
      events.changed(m.meetId);
    }
    return c.json({ blocks: await store.listBlocks(user.userId) });
  });

  // ---------- TV screens (tv.ts): the handshake between a singer's phone and the TV showing their stage ----------

  /** The TV registers a screen: its code (shown big, and as a QR) and its token (kept to itself). No sign-in; a few a minute per address. */
  app.post('/tv/screens', (c) => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    const now = Date.now();
    const slot = tvCreates.get(ip);
    if (slot && now - slot.at < 60_000) {
      if (slot.n >= TV_CREATE_PER_MIN) return c.json({ error: 'Too many screens from this address — wait a minute', code: 'rate_limited' }, 429);
      slot.n++;
    } else tvCreates.set(ip, { n: 1, at: now });
    if (tvCreates.size > 10_000) tvCreates.clear();
    const s = tv.create();
    return c.json({ code: s.code, token: s.token });
  });

  /** The singer takes a screen (the code on the TV): theirs from now on; the phone's stream token comes back. */
  app.post('/tv/screens/:code/claim', (c) => {
    const user = c.get('user');
    const code = normalizeTvCode(c.req.param('code'));
    const screen = tv.get(code);
    if (!screen) return err(c, 404, 'no_screen', 'No TV shows that code — open www.singersvoice.com/tv on the TV and read the code there');
    const s = tv.claim(code, { userId: user.userId, name: user.name });
    if (!s) return err(c, 409, 'screen_taken', 'That TV is showing somebody else’s stage');
    return c.json({ code: s.code, phoneToken: s.phoneToken });
  });

  /** The phone lets the screen go: the TV shows its code again. */
  app.post('/tv/screens/:code/release', (c) => {
    const user = c.get('user');
    const s = tv.get(c.req.param('code'));
    if (!s) return c.json({ ok: true });
    if (s.claimedBy && s.claimedBy.userId !== user.userId) return err(c, 403, 'not_yours', 'That TV is not yours');
    tv.release(s.code);
    return c.json({ ok: true });
  });

  /** The TV's own good-bye (its page closing): the screen is forgotten and the phone told. */
  app.post('/tv/screens/:code/bye', (c) => {
    const got = tv.sideOf(c.req.param('code'), c.req.query('tv') ?? '');
    if (got?.side === 'tv') tv.close(got.screen.code);
    return c.json({ ok: true });
  });

  /**
   * A signal from one side to the other (an offer, an answer, a candidate — whatever JSON the client's link speaks),
   * delivered on the other side's stream. The TV says who it is with its token (`?tv=`); the phone with its account.
   */
  app.post('/tv/screens/:code/signal', async (c) => {
    const code = c.req.param('code');
    const tvToken = c.req.query('tv') ?? '';
    let side: TvSide;
    const screen = tv.get(code);
    if (!screen) return err(c, 404, 'no_screen', 'That TV is gone');
    if (tvToken) {
      const got = tv.sideOf(code, tvToken);
      if (!got || got.side !== 'tv') return err(c, 403, 'bad_token', 'Not this TV’s token');
      side = 'tv';
    } else {
      const user = c.get('user');
      if (!screen.claimedBy || screen.claimedBy.userId !== user.userId) return err(c, 403, 'not_yours', 'That TV is not yours');
      side = 'phone';
    }
    const text = await c.req.text();
    if (text.length > TV_SIGNAL_MAX_BYTES) return err(c, 400, 'too_big', 'The signal is too big');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return err(c, 400, 'bad_request', 'A JSON signal, please');
    }
    return c.json({ delivered: tv.signal(code, side, data) });
  });

  /**
   * A screen's event stream, one per side (`?side=tv&tv=<token>`, `?side=phone&pt=<phoneToken>`): `hello`, then
   * `claimed` / `released` (to the TV), `signal` (either way), `closed` (the screen is gone), a ping every 25 s.
   */
  app.get('/tv/screens/:code/events', (c) => {
    const code = c.req.param('code');
    const want = c.req.query('side') === 'phone' ? 'phone' : 'tv';
    const got = tv.sideOf(code, (want === 'tv' ? c.req.query('tv') : c.req.query('pt')) ?? '');
    if (!got || got.side !== want) return err(c, want === 'tv' ? 410 : 403, want === 'tv' ? 'no_screen' : 'not_yours', want === 'tv' ? 'This screen is gone — make a new code' : 'That TV is not yours');
    const screen = got.screen;
    return streamSSE(c, async (stream) => {
      let seq = 0;
      let over = false;
      let wake: (() => void) | null = null;
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: string, retry?: number) => {
        writes = writes.then(() => stream.writeSSE({ event, data, ...(event === 'hello' ? {} : { id: String(++seq) }), ...(retry ? { retry } : {}) })).catch(() => undefined);
        return writes;
      };
      const off = tv.subscribe(
        screen.code,
        want,
        (ev) => void send(ev.type, JSON.stringify(ev)),
        () => {
          over = true;
          wake?.();
        },
      );
      stream.onAbort(() => {
        over = true;
        wake?.();
      });
      c.req.raw.signal?.addEventListener('abort', () => stream.abort(), { once: true });
      await send('hello', JSON.stringify({ code: screen.code, claimedBy: screen.claimedBy?.name ?? null, otherSide: tv.listening(screen.code, want === 'tv' ? 'phone' : 'tv') }), 1500);
      const until = Date.now() + EVENTS_MAX_MS;
      while (!over && !stream.aborted && Date.now() < until) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, EVENTS_PING_MS);
        });
        wake = null;
        if (!over && !stream.aborted) await send('ping', '');
      }
      off();
      await writes;
    });
  });

  // ---------- coupons: the gate (coupons.ts) ----------

  /** The singer enters the coupon the admin gave them: kept on the account, and the account's standing answered (in, or why not). */
  app.post('/coupon', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { code?: string };
    const code = normalizeCode(String(body.code ?? ''));
    if (!code) return err(c, 400, 'bad_request', 'Enter the coupon');
    await deps.store.setUserCoupon(user.userId, code);
    const after = (await deps.store.getUser(user.userId))!;
    return c.json({ user: after });
  });

  // ---------- Tracks portal: public catalog ----------

  /** `languages=Hindi,Telugu` keeps to the entries in those languages (the singer's preference, prefs.ts). */
  const languagesQuery = (c: Context<Env>): string[] =>
    (c.req.query('languages') ?? '')
      .split(',')
      .map((l) => l.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 24);

  app.get('/catalog/tracks', async (c) => {
    const { store } = c.get('deps');
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    const mine = c.req.query('mine') === '1';
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 24)));
    const offset = Math.max(0, Number(c.req.query('cursor') ?? 0));
    const { items, total } = await store.listCatalog(q, offset, limit, mine ? c.get('user').userId : undefined, languagesQuery(c));
    return c.json({ items, total, nextCursor: offset + items.length < total ? String(offset + items.length) : null });
  });

  app.get('/catalog/tracks/:id', async (c) => {
    const track = await c.get('deps').store.getCatalogTrack(c.req.param('id'));
    return track ? c.json({ track }) : err(c, 404, 'no_track', 'Track is not in the catalog');
  });

  // A published track's files, fetched from the owner's Drive by the service (a browser with another
  // account's token cannot read them, and Drive's download page has no CORS): "Add to my Drive" and
  // a meet's song on a device that does not own it come through here when no API key is at hand.
  app.get('/catalog/tracks/:id/file/:which', async (c) => {
    const { store, googleApiKey, fetchImpl } = c.get('deps');
    const track = await store.getCatalogTrack(c.req.param('id'));
    if (!track) return err(c, 404, 'no_track', 'Track is not in the catalog');
    const which = c.req.param('which');
    const fileId = which === 'json' ? track.trackJsonId : which === 'audio' ? track.audioId : which === 'video' ? (track.videoId ?? '') : '';
    if (!fileId) return err(c, which === 'video' ? 404 : 400, which === 'video' ? 'no_video' : 'bad_request', which === 'video' ? 'This track has no video' : 'The file is json, audio or video');
    try {
      const file = await fetchPublicDriveFile(fileId, { apiKey: googleApiKey, fetchImpl });
      const contentType = which === 'json' ? 'application/json' : which === 'video' ? track.videoMime || 'video/mp4' : track.audioMime || file.contentType;
      return new Response(file.body, { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600', ...(file.size ? { 'Content-Length': String(file.size) } : {}) } });
    } catch (e) {
      return err(c, 404, 'not_shared', `This song could not be fetched from ${track.ownerName}'s Drive: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  app.post('/catalog/tracks', async (c) => {
    const body = (await c.req.json().catch(() => null)) as CatalogPublishRequest | null;
    if (!body?.trackId || !body.title || !body.driveFolderId || !body.trackJsonId || !body.audioId) return err(c, 400, 'bad_request', 'trackId, title, driveFolderId, trackJsonId and audioId are required');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(body.trackId)) || ![body.driveFolderId, body.trackJsonId, body.audioId].every((id) => DRIVE_FILE_ID.test(String(id)))) return err(c, 400, 'bad_request', 'trackId and the Drive ids must be ids');
    if (body.driveFolderLink && !httpsLink(body.driveFolderLink, 300)) return err(c, 400, 'bad_request', 'driveFolderLink must be an https link');
    const user = c.get('user');
    const existing = await c.get('deps').store.getCatalogTrack(body.trackId);
    if (existing && existing.ownerUserId !== user.userId) return err(c, 409, 'not_owner', 'Another user owns this catalog entry');
    const now = new Date().toISOString();
    const track: CatalogTrack = {
      trackId: body.trackId,
      ownerUserId: user.userId,
      ownerName: user.name,
      title: String(body.title).slice(0, 120),
      artist: String(body.artist ?? '').slice(0, 120),
      genre: String(body.genre ?? '').slice(0, 60),
      language: String(body.language ?? '').slice(0, 60),
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      singerCount: Math.max(1, Math.min(10, Number(body.singerCount) || 1)),
      lineCount: Math.max(0, Number(body.lineCount) || 0),
      driveFolderId: body.driveFolderId,
      driveFolderLink: httpsLink(body.driveFolderLink, 300) ?? `https://drive.google.com/drive/folders/${body.driveFolderId}`,
      trackJsonId: body.trackJsonId,
      audioId: body.audioId,
      audioMime: body.audioMime || 'audio/mpeg',
      ...(body.videoId && DRIVE_FILE_ID.test(String(body.videoId)) ? { videoId: String(body.videoId), videoMime: String(body.videoMime || 'video/mp4').slice(0, 60) } : {}),
      publishedAt: now,
      updatedAt: now,
      pulls: 0,
    };
    return c.json({ track: await c.get('deps').store.publishTrack(track) }, existing ? 200 : 201);
  });

  app.delete('/catalog/tracks/:id', async (c) => {
    const ok = await c.get('deps').store.unpublishTrack(c.req.param('id'), c.get('user').userId);
    return ok ? c.json({ ok: true as const }) : err(c, 404, 'no_track', 'Not in the catalog (or not yours)');
  });

  app.post('/catalog/tracks/:id/pull', async (c) => {
    const { store } = c.get('deps');
    const t = await store.getCatalogTrack(c.req.param('id'));
    if (!t) return err(c, 404, 'no_track', 'Track is not in the catalog');
    return c.json({ ok: true as const, pulls: await store.countPull(t.trackId) });
  });

  // ---------- Tracks portal: the master track database (registry.ts) ----------
  //
  // One record per karaoke track singers have sung — from YouTube, from a singer's Drive, from the catalog —
  // with its metadata, the owner's shareable Drive URL and when anyone last sang it. Every signed-in singer
  // searches it and sings from it; the files come from the owner's shared Drive, or from any singer's shared
  // copy when the owner's is gone. An access is counted only when the device reports a successful one.

  const TRACK_SOURCES = new Set(['youtube', 'drive', 'catalog']);
  const cleanRefs = (x: unknown): TrackFileRefs | null => {
    const r = (x ?? {}) as Partial<TrackFileRefs>;
    if (!DRIVE_FILE_ID.test(String(r.folderId ?? '')) || !DRIVE_FILE_ID.test(String(r.jsonId ?? '')) || !DRIVE_FILE_ID.test(String(r.audioId ?? ''))) return null;
    return {
      folderId: String(r.folderId),
      jsonId: String(r.jsonId),
      audioId: String(r.audioId),
      audioMime: String(r.audioMime || 'audio/mpeg').slice(0, 60),
      ...(r.videoId && DRIVE_FILE_ID.test(String(r.videoId)) ? { videoId: String(r.videoId), videoMime: String(r.videoMime || 'video/mp4').slice(0, 60) } : {}),
    };
  };
  const registryId = (c: Context<Env>): string | null => {
    const id = c.req.param('id');
    return isRegistryId(id) ? id : null;
  };

  app.get('/tracks/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
    const offset = Math.max(0, Number(c.req.query('cursor') ?? 0));
    return c.json(await c.get('deps').store.searchRegistry(q, offset, limit, c.get('user').userId));
  });

  app.get('/tracks/history', async (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
    return c.json({ items: await c.get('deps').store.registryHistory(c.get('user').userId, limit) });
  });

  /** Recommendations: the songs in the given languages (nothing given: every song), the most sung first, grouped by song. */
  app.get('/tracks/recommended', async (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
    const offset = Math.max(0, Number(c.req.query('cursor') ?? 0));
    return c.json(await c.get('deps').store.searchRegistry('', offset, limit, c.get('user').userId, { languages: languagesQuery(c), popular: true }));
  });

  // ---------- songs a singer prefers, bookmarks (prefs.ts) ----------

  app.get('/prefs', async (c) => c.json({ prefs: await c.get('deps').store.getPrefs(c.get('user').userId) }));

  app.put('/prefs', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'Send the languages and countries');
    return c.json({ prefs: await c.get('deps').store.setPrefs(c.get('user').userId, body) });
  });

  app.get('/bookmarks', async (c) => c.json({ items: await c.get('deps').store.listBookmarks(c.get('user').userId) }));

  app.put('/bookmarks/:key', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { kind?: string; ref?: string } | null;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'Send the bookmark');
    if (bookmarkKey(String(body.kind ?? '') as BookmarkKind, String(body.ref ?? '').trim().slice(0, 120)) !== c.req.param('key')) return err(c, 400, 'bad_request', 'The key is the kind and the ref');
    const bookmark = await c.get('deps').store.putBookmark(c.get('user').userId, body);
    return bookmark ? c.json({ bookmark }) : err(c, 400, 'bad_request', 'Not a bookmark: a song of the track database, a catalog entry or a YouTube result');
  });

  app.delete('/bookmarks/:key', async (c) => {
    await c.get('deps').store.deleteBookmark(c.get('user').userId, c.req.param('key'));
    return c.json({ ok: true });
  });

  app.get('/tracks/:id', async (c) => {
    const id = registryId(c);
    const track = id ? await c.get('deps').store.getRegistryTrack(id, c.get('user').userId) : null;
    return track ? c.json({ track }) : err(c, 404, 'no_track', 'This song is not in the SingersVoice track database');
  });

  // The track's files from any singer's shared Drive: the owner's first, then every registered copy — so a song
  // outlives the one Drive it came from. A song nobody's Drive hands over any more is marked unavailable.
  app.get('/tracks/:id/file/:which', async (c) => {
    const { store, googleApiKey, fetchImpl } = c.get('deps');
    const id = registryId(c);
    const track = id ? await store.getRegistryTrack(id) : null;
    if (!track || !id) return err(c, 404, 'no_track', 'This song is not in the SingersVoice track database');
    const which = c.req.param('which');
    if (which !== 'json' && which !== 'audio' && which !== 'video') return err(c, 400, 'bad_request', 'The file is json, audio or video');
    let last = '';
    for (const src of await store.trackFileSources(id)) {
      const fileId = which === 'json' ? src.refs.jsonId : which === 'audio' ? src.refs.audioId : (src.refs.videoId ?? '');
      if (!fileId) continue;
      try {
        const file = await fetchPublicDriveFile(fileId, { apiKey: googleApiKey, fetchImpl });
        if (track.unavailable) await store.setTrackUnavailable(id, false);
        const contentType = which === 'json' ? 'application/json' : which === 'video' ? src.refs.videoMime || 'video/mp4' : src.refs.audioMime || file.contentType;
        return new Response(file.body, { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600', ...(file.size ? { 'Content-Length': String(file.size) } : {}) } });
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    if (which === 'video' && !track.hasVideo) return err(c, 404, 'no_video', 'This song has no video');
    await store.setTrackUnavailable(id, true);
    return err(c, 404, 'not_shared', `This song's files are no longer shared from any singer's Drive${last ? ` (${last})` : ''}`);
  });

  app.post('/tracks/register', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<RegisterTrackRequest> | null;
    const refs = cleanRefs(body?.refs);
    const song = String(body?.song ?? '').replace(/\s+/g, ' ').trim();
    if (!body || !TRACK_SOURCES.has(String(body.source)) || !refs) return err(c, 400, 'bad_request', 'source, song and the Drive file ids (folderId, jsonId, audioId) are required');
    if (!isDriveUrl(body.driveUrl)) return err(c, 400, 'bad_request', 'driveUrl must be a Google Drive link');
    const youtubeId = body.youtubeId ? youtubeVideoId(String(body.youtubeId)) : null;
    if (body.source === 'youtube' && !youtubeId) return err(c, 400, 'bad_request', 'A YouTube track names its video');
    const user = c.get('user');
    const { store } = c.get('deps');
    // A source the database holds already needs no name (the record has one); a new one does.
    const catalogTrackId = body.catalogTrackId ? String(body.catalogTrackId).slice(0, 120) : null;
    const sourceKey = body.sourceKey && /^(yt|drive|catalog):[A-Za-z0-9_-]{1,128}$/.test(String(body.sourceKey)) ? String(body.sourceKey) : registrySourceKey({ source: body.source as RegisterTrackRequest['source'], youtubeId, catalogTrackId, refs });
    if (!song && !(await store.getRegistryBySource(sourceKey))) return err(c, 400, 'bad_request', 'The song needs a name');
    const r = await store.registerTrack({
      source: body.source as RegisterTrackRequest['source'],
      song,
      artists: String(body.artists ?? ''),
      movie: String(body.movie ?? ''),
      year: body.year === null || body.year === undefined ? null : Number(body.year),
      language: String(body.language ?? ''),
      driveUrl: body.driveUrl,
      refs,
      durationMs: Number(body.durationMs ?? 0),
      singerCount: Number(body.singerCount ?? 1),
      youtubeId,
      thumbnail: /^https:\/\/[^\s]{1,300}$/.test(String(body.thumbnail ?? '')) ? String(body.thumbnail) : '',
      catalogTrackId,
      sourceKey,
      ...(body.copyTrackId ? { copyTrackId: String(body.copyTrackId).slice(0, 120) } : {}),
      ownerUserId: user.userId,
      ownerName: user.name,
    });
    return c.json(r, r.created ? 201 : 200);
  });

  app.post('/tracks/:id/access', async (c) => {
    const id = registryId(c);
    const body = (await c.req.json().catch(() => null)) as Partial<TrackAccessRequest> | null;
    const how = body?.how === 'play' ? 'play' : body?.how === 'sing' ? 'sing' : null;
    if (!id || !how) return err(c, 400, 'bad_request', 'how is sing or play');
    const track = await c.get('deps').store.recordTrackAccess(id, c.get('user').userId, how);
    return track ? c.json({ track }) : err(c, 404, 'no_track', 'This song is not in the SingersVoice track database');
  });

  app.post('/tracks/:id/copies', async (c) => {
    const id = registryId(c);
    const body = (await c.req.json().catch(() => null)) as Partial<TrackCopyRequest> | null;
    const refs = cleanRefs(body?.refs);
    if (!id || !refs || !isDriveUrl(body?.driveUrl) || !body?.copyTrackId) return err(c, 400, 'bad_request', 'The copy needs its Drive file ids, its Drive link and its id in your library');
    const track = await c.get('deps').store.recordTrackCopy(id, c.get('user').userId, { refs, driveUrl: body.driveUrl, copyTrackId: String(body.copyTrackId).slice(0, 120) });
    return track ? c.json({ track }) : err(c, 404, 'no_track', 'This song is not in the SingersVoice track database');
  });

  app.patch('/tracks/:id', async (c) => {
    const id = registryId(c);
    const { store } = c.get('deps');
    const user = c.get('user');
    const existing = id ? await store.getRegistryTrack(id) : null;
    if (!existing || !id) return err(c, 404, 'no_track', 'This song is not in the SingersVoice track database');
    if (existing.ownerUserId !== user.userId && user.role !== 'super_admin') return err(c, 403, 'not_owner', 'Only the singer who registered this song (or a super admin) can change its details');
    const body = (await c.req.json().catch(() => null)) as Partial<TrackMetaPatch> | null;
    if (!body) return err(c, 400, 'bad_request', 'song, artists, movie, year or language');
    const patch: TrackMetaPatch = {};
    if (typeof body.song === 'string') patch.song = body.song;
    if (typeof body.artists === 'string') patch.artists = body.artists;
    if (typeof body.movie === 'string') patch.movie = body.movie;
    if (typeof body.language === 'string') patch.language = body.language;
    if (body.year === null || typeof body.year === 'number') patch.year = body.year;
    const track = await store.patchRegistryTrack(id, patch);
    return track ? c.json({ track }) : err(c, 404, 'no_track', 'This song is not in the SingersVoice track database');
  });

  // ---------- Tracks portal: YouTube song tracks (through the relay) ----------

  const noRelay = (c: Context<Env>) => err(c, 404, 'no_relay', 'YouTube song tracks need the relay (docs/RELAY.md) — it is not deployed');
  app.get('/yt', async (c) => {
    const { relay } = c.get('deps');
    if (!relay) return c.json({ available: false, ytdlp: null, note: 'The relay is not deployed (docs/RELAY.md)' } satisfies YtStatus);
    const r = await relayJson<YtStatus>(relay, '/yt', { method: 'GET', timeoutMs: 15_000 }); // a stopped Fly machine starts on this call: a few seconds
    if (!r.body) return c.json({ available: false, ytdlp: null, note: r.error } satisfies YtStatus);
    return c.json({ available: Boolean(r.body.available), ytdlp: r.body.ytdlp ?? null, note: r.body.note ?? '' } satisfies YtStatus);
  });
  app.get('/yt/search', async (c) => {
    const { relay } = c.get('deps');
    if (!relay) return noRelay(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, 120);
    if (!q) return c.json({ items: [] } satisfies YtSearchResponse);
    const r = await relayJson<YtSearchResponse>(relay, `/yt/search?q=${encodeURIComponent(q)}`, { method: 'GET', timeoutMs: 50_000 });
    if (!r.body) return c.json({ error: r.error, code: r.status === 0 ? 'relay_down' : 'search_failed' }, 502);
    return c.json({ items: Array.isArray(r.body.items) ? r.body.items.slice(0, YT_SEARCH_LIMIT) : [] } satisfies YtSearchResponse);
  });
  // The singer's own Google token (the one this request came in with — the same one the browser uses for Drive) goes
  // with the job, so the relay uploads into the singer's Drive; it travels only between the two services.
  app.post('/yt/fetch', async (c) => {
    const { relay } = c.get('deps');
    if (!relay) return noRelay(c);
    const body = (await c.req.json().catch(() => null)) as YtFetchRequest | null;
    const videoId = String(body?.videoId ?? '').trim();
    const trackId = String(body?.trackId ?? '').trim();
    const folderId = String(body?.folderId ?? '').trim();
    const name = String(body?.name ?? '').trim().slice(0, 100);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return err(c, 400, 'bad_request', 'videoId must be a YouTube video id');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(trackId)) return err(c, 400, 'bad_request', 'trackId is required');
    if (!DRIVE_FILE_ID.test(folderId)) return err(c, 400, 'bad_request', 'folderId must be a Drive folder id');
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return err(c, 400, 'no_token', 'A Google sign-in is needed: the files go into your own Drive');
    const r = await relayJson<{ job: YtJob }>(relay, '/yt/fetch', { method: 'POST', body: { videoId, trackId, folderId, name, token }, timeoutMs: 15_000 });
    if (!r.body?.job) return c.json({ error: r.error, code: r.status === 503 ? 'relay_busy' : r.status === 0 ? 'relay_down' : 'fetch_failed' }, r.status === 503 ? 503 : 502);
    return c.json({ job: r.body.job }, 202);
  });
  app.get('/yt/jobs/:id', async (c) => {
    const { relay } = c.get('deps');
    if (!relay) return noRelay(c);
    const id = c.req.param('id');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return err(c, 400, 'bad_request', 'Not a job id');
    const r = await relayJson<{ job: YtJob }>(relay, `/yt/jobs/${encodeURIComponent(id)}`, { method: 'GET', timeoutMs: 8000 });
    if (!r.body?.job) return r.status === 404 ? err(c, 404, 'no_job', 'That download is not known (jobs are kept for an hour)') : c.json({ error: r.error, code: 'relay_down' }, 502);
    return c.json({ job: r.body.job });
  });

  // ---------- Live Meets ----------

  const publicOf = ({ resumeToken: _t, meetId: _m, videoTickAt: _v, ...p }: StoredParticipant): Participant => p;

  /**
   * The meet ends — by the host, or when it expires: the one way to its end, and the same whether asked once or
   * ten times at once (a meet already closed is left as it is). Persisting it closed is what releases everything
   * of it: the store's `onMeetClosed` clears the signals and hands every stream the last word, then closes them.
   */
  async function closeMeet(store: SqlStore, meet: Meet, now = Date.now()): Promise<boolean> {
    if (!meetIsOpen(meet)) return false;
    stop(meet, now);
    await store.saveMeet(meet);
    return true;
  }

  /**
   * An account's standing changed under the admin's hand (a plan granted or revoked, a role, the month's hours): every
   * seat of theirs in an open meet carries the picture permission as it stands now, and the rooms are told at once —
   * not at the device's next heartbeat, half a minute away.
   */
  async function refreshUserInMeets(store: SqlStore, userId: string): Promise<void> {
    userTouch.delete(userId);
    const user = await store.getUser(userId);
    if (!user) return;
    const media = user.role === 'audio' ? 'audio' : mediaOfEntitlement(user.entitlement);
    for (const [meetId, e] of store.live.meets) {
      let changed = false;
      for (const p of [...e.participants.values()]) {
        if (p.userId !== userId || p.role === 'publisher' || p.media === media) continue;
        const next = { ...p, media, videoTickAt: p.slot !== null && media === 'dual' ? new Date().toISOString() : undefined };
        await store.saveParticipant(next);
        changed = true;
      }
      if (changed) events.changed(meetId);
    }
  }

  /**
   * The meet as it stands this instant: time-driven state advanced (the count-in over, a cued pause landed, the
   * idle expiry), the people still heard from, the slots of those who are not freed — written and told when
   * that moved anything. Every snapshot and every room event starts here.
   */
  async function roomOf(store: SqlStore, meetId: string): Promise<{ meet: Meet; active: StoredParticipant[] } | null> {
    const meet = await store.getMeet(meetId);
    if (!meet) return null;
    ensureMeet(meet);
    let changed = tick(meet);
    const stored = await store.listParticipants(meetId);
    const rec = reconcile(meet, stored);
    changed = changed || rec.changed;
    if (changed) {
      await store.saveMeet(meet);
      events.changed(meetId);
    }
    return { meet, active: rec.active as StoredParticipant[] };
  }

  async function snapshot(c: Context<Env>, meetId: string, you?: StoredParticipant, chatSince?: number): Promise<MeetSnapshot | null> {
    const { store } = c.get('deps');
    const room = await roomOf(store, meetId);
    if (!room) return null;
    const { meet, active } = room;
    const participants = visibleParticipants(meet, active, you && isHost(meet, you) ? Infinity : undefined).map((p) => publicOf(p as StoredParticipant));
    const chat = chatSince !== undefined ? await store.chatSince(meetId, chatSince) : await store.chatTail(meetId, 50);
    const [recordings, performances] = await Promise.all([store.listRecordings(meetId), store.listPerformancesForMeet(meetId)]);
    return { meet, participants, chat, recordings, performances, serverEpochMs: Date.now(), mixListening: store.mixListening(meetId), ...(you ? { you: publicOf(you) } : {}) };
  }

  /** The room for the event stream (events.ts): built once per change, the host's view and everyone else's. */
  async function roomViews(meetId: string): Promise<RoomViews | null> {
    const store = (await getDeps({})).store;
    const room = await roomOf(store, meetId);
    if (!room) return null;
    const { meet, active } = room;
    const [recordings, performances] = await Promise.all([store.listRecordings(meetId), store.listPerformancesForMeet(meetId)]);
    const base = { meet, recordings, performances, serverEpochMs: Date.now(), mixListening: store.mixListening(meetId) };
    return {
      host: { ...base, participants: visibleParticipants(meet, active, Infinity).map((p) => publicOf(p as StoredParticipant)) },
      public: { ...base, participants: visibleParticipants(meet, active).map((p) => publicOf(p as StoredParticipant)) },
    };
  }

  async function participantFromBody(c: Context<Env>, meetId: string, token: string | undefined): Promise<StoredParticipant | null> {
    if (!token) return null;
    const p = await c.get('deps').store.getParticipantByToken(meetId, token);
    return p && p.userId === c.get('user').userId ? p : null;
  }

  app.get('/meets', async (c) => {
    const { store } = c.get('deps');
    const meets = await store.listMeetsForUser(c.get('user').userId);
    for (const m of meets) if (tick(m)) await store.saveMeet(m);
    return c.json({ meets });
  });

  app.post('/meets', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<CreateMeetRequest>;
    const user = c.get('user');
    // At most MAX_OPEN_MEETS open meets per host: end one (from the meets list) to open another.
    const mine = await c.get('deps').store.listMeetsForUser(user.userId, 100);
    const open = mine.filter((m) => m.hostUserId === user.userId && meetIsOpen(m) && Date.parse(m.expiresAt) > Date.now());
    if (open.length >= MAX_OPEN_MEETS) return err(c, 409, 'too_many_meets', `You already host ${open.length} open meets — end one to create another`);
    const meet = newMeet({
      title: String(body.title ?? ''),
      hostUserId: user.userId,
      hostName: user.name,
      trackId: body.trackId ?? null,
      trackTitle: String(body.trackTitle ?? '').slice(0, 120),
      catalogTrackId: body.catalogTrackId ?? null,
      backgroundId: String(body.backgroundId ?? 'mytestbg1'),
    });
    // A club owner's meet is the club's: members only, unless the owner opens it (never on for anyone else's meet).
    if (clubOwnerOf(user)) meet.membersOnly = body.membersOnly !== false;
    await c.get('deps').store.createMeet(meet);
    return c.json({ meet }, 201);
  });

  /** Host maintenance by account (no participant token): end an open meet; delete a meet for good. */
  app.post('/meets/:id/end', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (meet.hostUserId !== c.get('user').userId) return err(c, 403, 'not_host', 'Only the host can end the meet');
    ensureMeet(meet);
    tick(meet);
    await closeMeet(store, meet);
    return c.json({ meet });
  });

  app.delete('/meets/:id', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (meet.hostUserId !== c.get('user').userId) return err(c, 403, 'not_host', 'Only the host can delete the meet');
    await store.deleteMeet(meet.meetId);
    return c.json({ ok: true as const });
  });

  app.get('/meets/code/:code', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeetByCode(c.req.param('code'));
    if (!meet) return err(c, 404, 'no_meet', 'No meet with that code');
    if (tick(meet)) await store.saveMeet(meet);
    return c.json({ meet });
  });

  app.get('/meets/:id', async (c) => {
    const { store } = c.get('deps');
    const you = await store.getParticipantByUser(c.req.param('id'), c.get('user').userId);
    const snap = await snapshot(c, c.req.param('id'), you ?? undefined);
    return snap ? c.json(snap) : err(c, 404, 'no_meet', 'Meet not found');
  });

  /** The bookmarks of every singer on the stage right now, each saying whose — for anyone in the meet (the stage, the audience, the host). */
  app.get('/meets/:id/bookmarks', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const user = c.get('user');
    if (meet.hostUserId !== user.userId && !(await store.getParticipantByUser(meet.meetId, user.userId, 'any'))) return err(c, 403, 'not_in_meet', 'Join the meet to see what its singers bookmarked');
    const onStage = meet.stage.filter((s) => s.participantId);
    const singers: { userId: string; displayName: string }[] = [];
    for (const slot of onStage) {
      const p = await store.getParticipant(meet.meetId, slot.participantId!);
      if (p && !singers.some((x) => x.userId === p.userId)) singers.push({ userId: p.userId, displayName: slot.displayName || p.displayName });
    }
    return c.json({ items: await store.bookmarksOf(singers) });
  });

  app.post('/meets/:id/join', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<JoinMeetRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    tick(meet);
    if (meet.state === 'expired') return err(c, 410, 'expired', 'This meet expired after 5 minutes without activity');
    if (meet.state === 'ended') return err(c, 410, 'ended', 'This meet has ended');
    // The host's own word on who may come: somebody they blocked never does; a club meet takes the club's members alone.
    if (user.userId !== meet.hostUserId && user.role !== 'super_admin') {
      if (await store.isBlocked(meet.hostUserId, user.userId)) return err(c, 403, 'blocked_by_host', 'The host of this meet has blocked you');
      if (meet.membersOnly && !(await store.isClubMember(meet.hostUserId, user.email))) return err(c, 403, 'members_only', `This is ${meet.hostName}'s club meet — members only. Ask ${meet.hostName} to add you to the club`);
    }
    if (isBanned(meet, user.userId)) return err(c, 403, 'removed', 'The host removed you from this meet');
    const now = new Date().toISOString();
    const publisher = body.role === 'publisher';
    if (publisher && !user.canPublish) return err(c, 403, 'publishing_closed', user.publishingNote || 'Publishing mode is closed to this account');
    // A publisher's show view is its own participant: the same account may be performing on another device.
    let p = body.resumeToken ? await store.getParticipantByToken(meet.meetId, body.resumeToken) : null;
    // A member (host / performer / audience) is one per account; every publisher view (the show view,
    // each Preview tile) is its own participant, resumed by its token only, so an admin can monitor a
    // meet and run its show view at the same time without the two fighting over one video link.
    if (!p && !publisher) p = await store.getParticipantByUser(meet.meetId, user.userId, 'member');
    if (p && (p.userId !== user.userId || (publisher ? p.role !== 'publisher' : p.role === 'publisher'))) p = null;
    if (!p) {
      p = {
        meetId: meet.meetId,
        participantId: newId('p-'),
        userId: user.userId,
        displayName: user.name,
        picture: user.picture,
        role: publisher ? 'publisher' : user.userId === meet.hostUserId ? 'host' : 'audience',
        media: user.media,
        slot: null,
        stageRequest: 'none',
        joinedAt: now,
        lastSeenAt: now,
        resumeToken: `rt-${newToken()}`,
      };
    }
    p.lastSeenAt = now;
    p.media = user.media; // the account's permission as it stands now (a role changed since the last visit)
    // The host is on stage the moment their meet starts (first arrival), and anyone asking to join as a
    // performer is seated when the rules allow it (the host, or an open stage); everyone else is audience.
    const firstArrival = p.joinedAt === now;
    if ((body.role === 'performer' || (firstArrival && user.userId === meet.hostUserId)) && p.slot === null && p.role !== 'publisher') {
      const free = meet.stage.find((s) => !s.participantId);
      if (free) claimSlot(meet, p, free.slot);
    }
    p.videoTickAt = p.slot !== null && p.media === 'dual' && !publisher ? now : undefined; // the video hours count from the seat
    touch(meet);
    await store.saveParticipant(p);
    if (!publisher) await store.addMember(meet.meetId, user.userId); // the shows of this meet are shared with everyone who was ever in it
    await store.saveMeet(meet);
    const snap = (await snapshot(c, meet.meetId, p))!;
    events.changed(meet.meetId);
    const { resumeToken: _t, meetId: _m, ...you } = p;
    return c.json({ meet: snap.meet, you, resumeToken: p.resumeToken, serverEpochMs: Date.now() });
  });

  /**
   * The push channel (events.ts): one event stream per device, open for as long as it is in the meet. `changed`
   * says the meet's state moved (the device fetches its snapshot now); `signal` says a WebRTC signal waits for
   * this device (it polls its signals now). The resume token in the query is the credential — the browser's
   * EventSource can send no header, and the token is the meet's own (never the Google token).
   */
  app.get('/meets/:id/events', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const token = (c.req.query('rt') ?? '').trim();
    const p = token ? await store.getParticipantByToken(meet.meetId, token) : null;
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (isBanned(meet, p.userId)) return err(c, 403, 'removed', 'The host removed you from this meet');
    if (!meetIsOpen(meet)) return err(c, 410, 'meet_closed', 'This meet has ended');
    return streamSSE(c, async (stream) => {
      let seq = 0;
      let over = false;
      let wake: (() => void) | null = null;
      // One writer, in order: an event told while the stream is closing still goes out before the close.
      let writes: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: string, retry?: number) => {
        writes = writes.then(() => stream.writeSSE({ event, data, ...(event === 'hello' ? {} : { id: String(++seq) }), ...(retry ? { retry } : {}) })).catch(() => undefined);
        return writes;
      };
      const off = events.subscribe(
        meet.meetId,
        p.participantId,
        isHost(meet, p),
        (ev) => void send(ev.type, JSON.stringify(ev)),
        () => {
          over = true;
          wake?.();
        },
      );
      stream.onAbort(() => {
        over = true;
        wake?.();
      });
      c.req.raw.signal?.addEventListener('abort', () => stream.abort(), { once: true });
      await send('hello', JSON.stringify({ participantId: p.participantId, serverEpochMs: Date.now() }), 1500);
      const until = Date.now() + EVENTS_MAX_MS;
      // The open stream is the device's presence: seen now, and at every ping, without a row written.
      store.touchParticipant(meet.meetId, p.participantId);
      while (!over && !stream.aborted && Date.now() < until) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, EVENTS_PING_MS);
        });
        wake = null;
        if (!over && !stream.aborted) {
          store.touchParticipant(meet.meetId, p.participantId);
          await send('ping', '');
        }
      }
      off();
      await writes;
    });
  });

  app.post('/meets/:id/heartbeat', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<HeartbeatRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (isBanned(meet, c.get('user').userId)) return err(c, 403, 'removed', 'The host removed you from this meet');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    const user = c.get('user');
    const nowMs = Date.now();
    p.lastSeenAt = new Date(nowMs).toISOString();
    // The picture follows the account as it stands now (a plan granted or run out, a role changed, a new month), and
    // the video hours count: on stage with the picture on, the seconds since the last heartbeat go to the plan's month
    // (the account's own, or the club's pool) — never more than two minutes at a stretch (a device that slept).
    if (p.role !== 'publisher') {
      const wasVideo = p.slot !== null && p.media === 'dual';
      const tickAt = wasVideo && p.videoTickAt ? Date.parse(p.videoTickAt) : NaN;
      const elapsed = Number.isFinite(tickAt) ? Math.min(120, Math.max(0, (nowMs - tickAt) / 1000)) : 0;
      if (elapsed > 0 && user.entitlement.videoLeftSeconds !== null) {
        const pool = user.entitlement.via === 'club' && user.entitlement.clubOwner ? user.entitlement.clubOwner.userId : user.userId;
        const used = await store.addVideoSeconds(pool, periodKey(nowMs), elapsed);
        if (used >= user.entitlement.videoHours * 3600) user.entitlement = { ...user.entitlement, video: false, videoUsedSeconds: used, videoLeftSeconds: 0, videoNote: user.entitlement.via === 'club' ? `${user.entitlement.clubOwner?.name ?? 'Your club'}'s club has used its ${user.entitlement.videoHours} video hours for ${periodLabel(user.entitlement.periodKey)} — the voice alone on stage until ${user.entitlement.resetsAt.slice(0, 10)}` : `Your ${user.entitlement.videoHours} video hours for ${periodLabel(user.entitlement.periodKey)} are used up — the voice alone on stage until ${user.entitlement.resetsAt.slice(0, 10)}` };
        else user.entitlement = { ...user.entitlement, videoUsedSeconds: used, videoLeftSeconds: Math.max(0, Math.round(user.entitlement.videoHours * 3600 - used)) };
      }
      p.media = user.role === 'audio' ? 'audio' : mediaOfEntitlement(user.entitlement);
      p.videoTickAt = p.slot !== null && p.media === 'dual' ? p.lastSeenAt : undefined;
    }
    // The participant row is what keeps them in the room; the meet row is rewritten only when the
    // heartbeat changed something worth it (a performer's clock, or an expiry extension that is due).
    const clockChanged = body.driftMs !== undefined || body.rttMs !== undefined ? reportClock(meet, p, body.driftMs ?? null, body.rttMs ?? null) : false;
    const touchDue = touchForHeartbeat(meet);
    await store.saveParticipant(p);
    if (clockChanged || touchDue) await store.saveMeet(meet);
    const snap = (await snapshot(c, meet.meetId, p, body.chatSince))!;
    // What the live layer owes the rows (the expiries, a broadcast's counters, video seconds), written when due —
    // never in the way of the answer: a flush that fails (the day's budget spent) is tried at the next one.
    store.flush().catch(() => undefined);
    const e = user.entitlement;
    const reason = e.video && user.role !== 'audio' ? '' : user.role === 'audio' ? 'role' : e.videoHours > 0 && (e.videoLeftSeconds ?? 1) <= 0 ? 'hours' : 'plan';
    return c.json({ ...snap, yourVideo: { leftSeconds: e.videoLeftSeconds, note: e.videoNote, reason } });
  });

  app.post('/meets/:id/slot', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<SlotRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    tick(meet);
    const r = claimSlot(meet, p, body.slot === null || body.slot === undefined ? null : Number(body.slot));
    if (!r.ok) {
      if (r.reason === 'ask_first') return err(c, 403, 'ask_first', 'Ask the host to sing — they let you on stage');
      return err(c, 409, r.reason ?? 'slot', r.reason === 'slot_taken' ? 'That stage slot is taken' : r.reason === 'song_in_progress' ? 'A song is running — you can step on stage once it is over' : r.reason === 'meet_closed' ? 'This meet has ended' : 'Cannot take that slot');
    }
    p.lastSeenAt = new Date().toISOString();
    p.videoTickAt = p.slot !== null && p.media === 'dual' ? p.lastSeenAt : undefined; // the video hours count from the seat, and stop with it
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  // ---- audience → singer: ask, and the host decides; the host also clears slots and sets the stage policy ----
  app.post('/meets/:id/requests', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    tick(meet);
    const r = requestStage(meet, p);
    if (!r.ok) return err(c, 409, r.reason ?? 'request', r.reason === 'on_stage' ? 'You are already on stage' : r.reason === 'open_stage' ? 'The stage is open — just take a slot' : r.reason === 'meet_closed' ? 'This meet has ended' : 'Cannot ask right now');
    p.lastSeenAt = new Date().toISOString();
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/requests/withdraw', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    withdrawRequest(meet, p);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/requests/:pid/decide', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<DecideRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host decides who sings');
    const target = await store.getParticipant(meet.meetId, c.req.param('pid'));
    if (!target || target.role === 'publisher') return err(c, 404, 'no_participant', 'They are no longer in the meet');
    tick(meet);
    const r = decideRequest(meet, target, Boolean(body.allow), body.slot === undefined ? undefined : Number(body.slot));
    if (!r.ok) return err(c, 409, r.reason ?? 'decide', r.reason === 'stage_full' ? 'The stage is full (10 singers)' : r.reason === 'slot_taken' ? 'That stage slot is taken' : r.reason === 'song_in_progress' ? 'A song is running — seat them once it is over' : 'Cannot seat them right now');
    touch(meet);
    await store.saveParticipant(target);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  app.post('/meets/:id/stage/:pid/remove', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host clears the stage');
    const target = await store.getParticipant(meet.meetId, c.req.param('pid'));
    if (!target) return err(c, 404, 'no_participant', 'They are no longer in the meet');
    claimSlot(meet, target, null);
    touch(meet);
    await store.saveParticipant(target);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  // ---- the song of the stage: one at a time (meets.ts has the rules) ----
  app.post('/meets/:id/songs', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; song?: Partial<SongPick> };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    tick(meet);
    const song = body.song ?? {};
    const r = addSong(meet, p, { trackId: song.trackId ? String(song.trackId) : null, catalogTrackId: song.catalogTrackId ? String(song.catalogTrackId) : null, registryId: isRegistryId(song.registryId) ? song.registryId : null, trackTitle: String(song.trackTitle ?? ''), durationMs: Number(song.durationMs ?? 0) });
    if (!r.ok) {
      if (r.reason === 'not_on_stage') return err(c, 403, 'not_on_stage', 'Step on stage (or host the meet) to pick songs');
      return err(c, 400, r.reason ?? 'bad_song', r.reason === 'meet_closed' ? 'This meet has ended' : 'Pick a track with a title');
    }
    p.lastSeenAt = new Date().toISOString();
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    // The song was there already: nothing added, the snapshot says where it is (the room tells the singer).
    if (r.duplicate) c.header('X-Song-Duplicate', r.duplicate);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/songs/next', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!canTransport(meet, p)) return err(c, 403, 'not_on_stage', 'Only the singers on stage (or the host) end the song');
    tick(meet);
    const r = nextSong(meet);
    if (!r.ok) return err(c, 409, r.reason ?? 'song', 'This meet has ended');
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/songs/:sid', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; action?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (body.action !== 'remove' && body.action !== 'choose') return err(c, 400, 'bad_action', 'action must be remove or choose');
    tick(meet);
    const r = songAction(meet, p, c.req.param('sid'), body.action);
    if (!r.ok) {
      if (r.reason === 'not_on_stage') return err(c, 403, 'not_on_stage', 'Step on stage (or host the meet) to choose the song');
      if (r.reason === 'no_song') return err(c, 404, 'no_song', 'That song is no longer put forward — the stage settled on another one');
      return err(c, 409, r.reason ?? 'song', 'This meet has ended');
    }
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/participants/:pid/kick', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    const target = await store.getParticipant(meet.meetId, c.req.param('pid'));
    if (!target) return err(c, 404, 'no_participant', 'They are no longer in the meet');
    const r = kick(meet, host, target);
    if (!r.ok) return err(c, r.reason === 'not_host' ? 403 : 409, r.reason ?? 'kick', r.reason === 'not_host' ? 'Only the host removes people from the meet' : r.reason === 'self' ? 'The host cannot remove themselves' : 'This meet has ended');
    await store.removeParticipant(meet.meetId, target.participantId);
    reconcile(meet, await store.listParticipants(meet.meetId));
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  /** The host removes somebody and blocks them from every meet of theirs, for good (`blocks`). */
  app.post('/meets/:id/participants/:pid/block', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host blocks people');
    const target = await store.getParticipant(meet.meetId, c.req.param('pid'));
    if (!target) return err(c, 404, 'no_participant', 'They are no longer in the meet');
    if (target.userId === host.userId) return err(c, 409, 'self', 'The host cannot block themselves');
    await store.block(host.userId, target.userId);
    const r = kick(meet, host, target);
    if (r.ok) await store.removeParticipant(meet.meetId, target.participantId);
    reconcile(meet, await store.listParticipants(meet.meetId));
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  /** The club owner's switch on their meet: members only (the club's rule), or open to anyone with the link. */
  app.post('/meets/:id/club', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; membersOnly?: unknown };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host sets who may come in');
    if (!clubOwnerOf(c.get('user'))) return err(c, 403, 'not_club', 'Members only is for a club owner’s meets');
    meet.membersOnly = Boolean(body.membersOnly);
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  app.post('/meets/:id/background', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; backgroundId?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    const r = setBackground(meet, p, String(body.backgroundId ?? ''));
    if (!r.ok) return err(c, r.reason === 'bad_background' ? 400 : r.reason === 'meet_closed' ? 409 : 403, r.reason ?? 'refused', r.reason === 'not_on_stage' ? 'Only the host and the singers on stage choose the background' : r.reason === 'meet_closed' ? 'This meet is over' : 'That is not a background');
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/policy', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; stagePolicy?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host sets who may step on stage');
    if (body.stagePolicy !== 'ask' && body.stagePolicy !== 'open') return err(c, 400, 'bad_policy', 'stagePolicy must be ask or open');
    setStagePolicy(meet, body.stagePolicy);
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  app.post('/meets/:id/ready', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<ReadyRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    setReady(meet, p, Boolean(body.ready));
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/chat', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<ChatRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    const text = String(body.text ?? '').trim().slice(0, 500);
    if (!text) return err(c, 400, 'empty', 'Say something');
    // A flood from one device (a stuck key, a script): a few lines a second at most.
    const slot = chatRate.get(p.participantId);
    const nowMs = Date.now();
    if (slot && nowMs - slot.at < CHAT_WINDOW_MS) {
      if (slot.n >= CHAT_PER_WINDOW) return err(c, 429, 'rate_limited', 'Slow down a little');
      slot.n++;
    } else chatRate.set(p.participantId, { n: 1, at: nowMs });
    if (chatRate.size > 10_000) chatRate.clear();
    const message: Omit<ChatMessage, 'seq'> = { id: newId('msg-'), meetId: meet.meetId, participantId: p.participantId, displayName: p.displayName, text, sentAt: new Date().toISOString() };
    const saved = await store.addChat(meet.meetId, message);
    touch(meet);
    await store.saveMeet(meet);
    events.chat(meet.meetId, saved);
    return c.json({ message: saved }, 201);
  });

  app.post('/meets/:id/start', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<StartMeetRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!canTransport(meet, p)) return err(c, 403, 'not_on_stage', 'Only the singers on stage (or the host) start the song');
    tick(meet);
    const r = start(meet, Number(body.leadMs ?? 5000));
    if (!r.ok) return err(c, 409, r.reason ?? 'start', r.reason === 'no_performers' ? 'Nobody is on stage yet' : r.reason === 'no_song' ? 'Pick a song first' : r.reason === 'choice_pending' ? 'More than one song is put forward — the stage chooses one first' : 'The meet is not in the lobby');
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/stop', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, p)) return err(c, 403, 'not_host', 'Only the host can end the meet');
    await closeMeet(store, meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  /**
   * Transport — pause freezes the shared position at a cued instant; resume / seek / restart cue a new
   * kickstart, so every device moves together whoever asked. The host and any singer on stage may
   * pause, resume, seek and restart (from the top) — a singer who fluffed the first line starts over for the stage.
   */
  for (const action of ['pause', 'resume', 'restart', 'seek'] as const) {
    app.post(`/meets/:id/${action}`, async (c) => {
      const { store } = c.get('deps');
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; leadMs?: number; fromMs?: number; toMs?: number };
      const meet = await store.getMeet(c.req.param('id'));
      if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
      const p = await participantFromBody(c, meet.meetId, body.resumeToken);
      if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
      if (!canTransport(meet, p)) return err(c, 403, 'not_host', 'Only the singers on stage control the song');
      ensureMeet(meet);
      tick(meet);
      const r =
        action === 'pause'
          ? pause(meet, Date.now(), Number(body.leadMs ?? 3000))
          : action === 'resume'
            ? resume(meet, Number(body.leadMs ?? 4000))
            : action === 'seek'
              ? seek(meet, Number(body.leadMs ?? 3000), Number(body.toMs ?? 0))
              : resume(meet, Number(body.leadMs ?? 3000), Date.now(), Math.max(0, Number(body.fromMs ?? 0)));
      if (!r.ok) return err(c, 409, r.reason ?? action, r.reason === 'not_started' ? 'Start the song first' : r.reason === 'already_playing' ? 'The song is already playing' : r.reason === 'pausing' ? 'A pause is on its way — seek once it landed' : r.reason === 'counting_in' ? 'The count-in is running — the song can be moved once it plays' : 'The song is not playing');
      await store.saveMeet(meet);
      events.changed(meet.meetId);
    return c.json((await snapshot(c, meet.meetId, p))!);
    });
  }

  /** Relay one WebRTC signal to another performer of the same meet. */
  app.post('/meets/:id/signal', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<SignalRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!meetIsOpen(meet)) return err(c, 410, 'meet_closed', 'This meet has ended');
    // Performer video is private to the stage: only performers and a publisher's show view may signal.
    if (p.slot === null && p.role !== 'publisher') return err(c, 403, 'not_on_stage', 'Only performers and the publisher exchange video');
    const to = String(body.to ?? '');
    const type = body.type;
    const data = typeof body.data === 'string' ? body.data : JSON.stringify(body.data ?? null);
    if (!to || !type || !['offer', 'answer', 'ice', 'bye'].includes(type)) return err(c, 400, 'bad_signal', 'to, type and data are required');
    if (data.length > 64_000) return err(c, 400, 'bad_signal', 'Signal too large');
    // They left (a publisher view closed, a singer gone): nothing to deliver, nothing to shout about.
    if (!(await store.getParticipant(meet.meetId, to))) return c.json({ seq: 0, gone: true });
    const sig = await store.addSignal(meet.meetId, { meetId: meet.meetId, from: p.participantId, to, type, data, sentAt: new Date().toISOString() });
    events.signal(meet.meetId, sig);
    return c.json({ seq: sig.seq });
  });

  /** Signals addressed to me since `since` (polled while on stage). */
  app.post('/meets/:id/signals', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; since?: number };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (p.slot === null && p.role !== 'publisher') return err(c, 403, 'not_on_stage', 'Only performers and the publisher exchange video');
    const signals = await store.signalsFor(meet.meetId, p.participantId, Number(body.since ?? 0));
    return c.json({ signals, serverEpochMs: Date.now() });
  });

  /** ICE servers for performer-to-performer video (STUN by default; TURN when the deployment sets ICE_SERVERS). */
  app.get('/ice', (c) => c.json({ iceServers: c.get('deps').iceServers ?? DEFAULT_ICE_SERVERS }));

  app.post('/meets/:id/leave', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return c.json({ ok: true as const });
    claimSlot(meet, p, null);
    await store.removeParticipant(meet.meetId, p.participantId);
    reconcile(meet, (await store.listParticipants(meet.meetId)).map((x) => x));
    await store.saveMeet(meet);
    events.changed(meet.meetId);
    return c.json({ ok: true as const });
  });

  // Takes save themselves in the background, after the song — by then the singer may have left the room
  // (or the meet may be over), so a take is registered by account: anyone who was ever in the meet.
  app.post('/meets/:id/recordings', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<RegisterRecordingRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p && !(await store.listMembers(meet.meetId)).some((m) => m.userId === user.userId)) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!body.performanceId) return err(c, 400, 'bad_request', 'performanceId is required');
    const recording = {
      meetId: meet.meetId,
      participantId: p?.participantId ?? '',
      userId: user.userId,
      displayName: p?.displayName ?? user.name,
      slot: p?.slot ?? (typeof body.slot === 'number' ? Math.max(1, Math.min(10, body.slot)) : null),
      performanceId: String(body.performanceId).slice(0, 80),
      driveFolderLink: httpsLink(body.driveFolderLink),
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      createdAt: new Date().toISOString(),
    };
    await store.addRecording(recording);
    return c.json({ recording }, 201);
  });

  // The saved show of a song: recorded on the host's device, kept in the host's Drive, shared with everyone in the meet.
  app.post('/meets/:id/performances', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<RegisterPerformanceRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const user = c.get('user');
    if (user.userId !== meet.hostUserId) return err(c, 403, 'not_host', 'Only the host registers the saved show'); // by account: the upload may finish after the host left the room
    if (!body.performanceId || !/^[A-Za-z0-9_-]{1,80}$/.test(String(body.performanceId))) return err(c, 400, 'bad_request', 'performanceId is required');
    const singers = Array.isArray(body.singers) ? body.singers.slice(0, 10).map((s) => ({ slot: Math.max(1, Math.min(10, Number(s?.slot) || 1)), displayName: String(s?.displayName ?? '').slice(0, 60), ...(s?.userId ? { userId: String(s.userId) } : {}) })) : [];
    const performance: MeetPerformance = {
      performanceId: String(body.performanceId),
      meetId: meet.meetId,
      meetTitle: meet.title,
      hostUserId: user.userId,
      hostName: user.name,
      songTitle: String(body.songTitle ?? meet.trackTitle ?? '').slice(0, 120),
      trackId: String(body.trackId ?? ''),
      singers,
      link: httpsLink(body.link),
      videoLink: httpsLink(body.videoLink),
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      bytes: Math.max(0, Number(body.bytes) || 0),
      mimeType: String(body.mimeType ?? '').slice(0, 80),
      createdAt: new Date().toISOString(),
      ...(chapterOf(body.chapter) ? { chapter: chapterOf(body.chapter)! } : {}),
      // The film's chapter marks (one file for the whole meet): each checked as a chapter is, at most a few hundred.
      ...(Array.isArray(body.chapters) ? { chapters: body.chapters.slice(0, 400).map(chapterOf).filter((x): x is PerformanceChapter => x !== null) } : {}),
    };
    await store.addPerformance(performance);
    touch(meet);
    await store.saveMeet(meet);
    events.changed(meet.meetId); // the film is on the meet: every device's Ended screen lists it at once
    const members = await store.listMembers(meet.meetId);
    const shareWith = members.filter((m) => m.userId !== user.userId && m.email && !m.email.endsWith('.local')).map((m) => m.email);
    return c.json({ performance, shareWith }, 201);
  });

  // The stage mix for the audience: the host's device posts a second at a time; everyone else fetches what is new.
  app.post('/meets/:id/mix', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (user.userId !== meet.hostUserId) return err(c, 403, 'not_host', "Only the host's device sends the stage mix");
    const body = ((await c.req.json().catch(() => null)) ?? null) as (Partial<MixBatch> & { resumeToken?: string }) | null;
    if (!body || typeof body.seq !== 'number' || !Array.isArray(body.packets)) return err(c, 400, 'bad_request', 'A mix batch needs seq and packets');
    if (body.packets.length > 120 || JSON.stringify(body.packets).length > 200_000) return err(c, 400, 'too_big', 'A mix batch is a second of audio, not more');
    const batch: MixBatch = {
      seq: Math.max(0, Math.floor(body.seq)),
      atMs: Math.max(0, Number(body.atMs) || 0),
      codec: 'opus',
      sampleRate: Number(body.sampleRate) || 48000,
      channels: Math.max(1, Math.min(2, Number(body.channels) || 1)),
      packets: body.packets.map((p) => ({ ts: Number(p?.ts) || 0, b64: String(p?.b64 ?? '') })),
      serverEpochMs: Date.now(),
    };
    const seq = await store.addMix(meet.meetId, batch);
    return c.json({ ok: true as const, seq });
  });
  app.get('/meets/:id/mix', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const since = Math.max(0, Number(c.req.query('since')) || 0);
    const r = await store.listMix(meet.meetId, since);
    return c.json({ ...r, serverEpochMs: Date.now() });
  });

  app.get('/performances', async (c) => {
    const performances = await c.get('deps').store.listPerformancesForUser(c.get('user').userId);
    return c.json({ performances });
  });

  app.delete('/performances/:id', async (c) => {
    const { store } = c.get('deps');
    const p = await store.getPerformance(c.req.param('id'));
    if (!p) return c.json({ ok: true as const });
    if (p.hostUserId !== c.get('user').userId) return err(c, 403, 'not_host', 'Only the host can remove a saved show');
    await store.deletePerformance(p.performanceId);
    return c.json({ ok: true as const });
  });

  // ---------- Joining a performance (join.ts): a take opened for others to sing over ----------

  const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;
  const fileRef = (v: unknown): { driveId: string; mimeType: string; bytes: number } | null => {
    const f = (v ?? null) as { driveId?: unknown; mimeType?: unknown; bytes?: unknown } | null;
    if (!f || typeof f.driveId !== 'string' || !DRIVE_FILE_ID.test(f.driveId)) return null;
    return { driveId: f.driveId, mimeType: String(f.mimeType ?? '').slice(0, 80), bytes: Math.max(0, Math.floor(Number(f.bytes) || 0)) };
  };
  const num = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  app.get('/performances/invites', async (c) => {
    const { store } = c.get('deps');
    const me = c.get('user').userId;
    const [mine, joined] = await Promise.all([store.listInvitesOf(me), store.listJoinsOf(me)]);
    return c.json({ mine, joined });
  });

  app.put('/performances/:id/invite', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const performanceId = c.req.param('id');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<InviteRequest>;
    const show = fileRef(body.show);
    const link = httpsLink((body.show as { link?: unknown } | undefined)?.link, 300);
    if (!show || !link) return err(c, 400, 'bad_request', 'The show (its Drive file id, type, size and https link) is required');
    const had = await store.getInvite(performanceId);
    if (had && had.ownerUserId !== user.userId) return err(c, 403, 'not_owner', 'Only the singer who saved this performance can open it for joining');
    const layersIn = Array.isArray(body.layers) ? body.layers.slice(0, MAX_LAYERS) : [];
    const layers: JoinLayer[] = layersIn.map((l) => ({
      slot: Math.max(1, Math.min(MAX_LAYERS, Math.round(num(l?.slot, 1)))),
      displayName: String(l?.displayName ?? '').slice(0, 60),
      userId: String(l?.userId ?? '').slice(0, 80),
      cutout: fileRef(l?.cutout),
      atShowMs: Math.round(num(l?.atShowMs)),
    }));
    if (!layers.length) return err(c, 400, 'bad_request', 'A performance has at least one singer on it');
    const joinedFrom = typeof body.joinedFrom === 'string' && body.joinedFrom && body.joinedFrom !== performanceId ? body.joinedFrom.slice(0, 80) : null;
    const invite = await store.putInvite({
      performanceId,
      ownerUserId: user.userId,
      ownerName: user.name,
      registryId: String(body.registryId ?? '').slice(0, 80),
      trackTitle: String(body.trackTitle ?? '').slice(0, 120),
      trackArtist: String(body.trackArtist ?? '').slice(0, 120),
      durationMs: Math.max(0, Math.round(num(body.durationMs))),
      show: { ...show, link },
      offsetMs: Math.round(num(body.offsetMs)),
      tempo: Math.min(1.5, Math.max(0.5, num(body.tempo, 1) || 1)),
      layers,
      joinedFrom,
      createdAt: new Date().toISOString(),
      joins: 0,
    });
    if (!had && joinedFrom) await store.countJoin(joinedFrom); // a performance opened for the first time counts as one more join of the one it sang over
    return c.json({ invite }, had ? 200 : 201);
  });

  app.get('/performances/:id/invite', async (c) => {
    const invite = await c.get('deps').store.getInvite(c.req.param('id'));
    return invite ? c.json({ invite }) : err(c, 404, 'no_invite', 'This performance is not open for joining (or was closed)');
  });

  // The show and the cut-outs, fetched from their singers' Drives by the service (a browser with another account's token cannot read them).
  app.get('/performances/:id/invite/file/:which', async (c) => {
    const { store, googleApiKey, fetchImpl } = c.get('deps');
    const invite = await store.getInvite(c.req.param('id'));
    if (!invite) return err(c, 404, 'no_invite', 'This performance is not open for joining (or was closed)');
    const which = c.req.param('which');
    const slot = /^cutout-(\d+)$/.exec(which);
    const ref = which === 'show' ? invite.show : slot ? (invite.layers.find((l) => l.slot === Number(slot[1]))?.cutout ?? null) : null;
    if (!ref) return err(c, 404, 'no_file', which === 'show' ? 'No show on this performance' : 'No cut-out video for that singer');
    try {
      const file = await fetchPublicDriveFile(ref.driveId, { apiKey: googleApiKey, fetchImpl });
      return new Response(file.body, { status: 200, headers: { 'Content-Type': ref.mimeType || file.contentType, 'Cache-Control': 'private, max-age=3600', ...(file.size ? { 'Content-Length': String(file.size) } : {}) } });
    } catch (e) {
      return err(c, 404, 'not_shared', `This file could not be fetched from ${invite.ownerName}'s Drive: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  app.delete('/performances/:id/invite', async (c) => {
    const { store } = c.get('deps');
    const invite = await store.getInvite(c.req.param('id'));
    if (!invite) return c.json({ ok: true as const });
    if (invite.ownerUserId !== c.get('user').userId) return err(c, 403, 'not_owner', 'Only the singer who opened this performance can close it');
    await store.deleteInvite(invite.performanceId);
    return c.json({ ok: true as const });
  });

  // ---------- Billing: the plans, through Stripe (docs/BILLING.md, docs/global-payments-architecture.md) ----------

  const billingOf = (deps: AppDeps): BillingConfig => deps.billing ?? { appUrl: 'https://www.singersvoice.com' };
  /**
   * Where Stripe sends the singer back: the app's own address when it says one (origin + base path) and the origin is one of
   * ours — the site lives at www.singersvoice.com and, until the move is over, at singersvoice.github.io/SingersVoice/ — else
   * the service's APP_URL. Never an address from anywhere else (an open door to somebody's page).
   */
  const billingFor = (c: Context<Env>, deps: AppDeps, appUrl: unknown): BillingConfig => {
    const b = billingOf(deps);
    if (typeof appUrl !== 'string' || appUrl.length > 200) return b;
    try {
      const u = new URL(appUrl);
      if (!originAllowed(u.origin, deps.allowedOrigins ?? []) || u.search || u.hash || !/^\/[A-Za-z0-9_-]*\/?$/.test(u.pathname)) return b;
      if (c.req.header('origin') && c.req.header('origin') !== u.origin) return b;
      return { ...b, appUrl: `${u.origin}${u.pathname.replace(/\/$/, '')}` };
    } catch {
      return b;
    }
  };
  const CURRENCY = /^[a-z]{3}$/;

  /** A period the admin gave (a grant, a renewal, dates set by hand) on the payments record: amount 0, the granter named. */
  const recordGrant = async (deps: AppDeps, granter: UserRecord, userId: string, note: string) => {
    const sub = await deps.store.getSubscription(userId);
    const now = new Date().toISOString();
    await deps.store.recordPayment({ id: `pay-grant-${userId}-${Date.now()}`, userId, plan: sub?.plan ?? 'club', amountCents: 0, currency: 'usd', paidAt: now, source: 'grant', ref: `admin:${granter.userId}`, periodStart: sub?.startedAt ?? null, periodEnd: sub?.planUntil ?? null, note });
  };

  /** The role follows the plan: a singer put on the Club owner plan becomes a club owner; a super admin keeps the role. */
  const roleForPlan = async (deps: AppDeps, userId: string, plan: PlanId) => {
    const u = await deps.store.getUser(userId);
    if (!u || u.role === 'super_admin') return;
    if (plan === 'club' && u.role !== 'club_owner') await deps.store.setRole(userId, 'club_owner');
    if (plan !== 'club' && u.role === 'club_owner') await deps.store.setRole(userId, 'dual');
  };

  /**
   * A paid Checkout opens the plan: the subscription row with Stripe's ids, the period's end from Stripe's subscription
   * when it can be asked (else a period of the plan's own length, which the subscription events then correct), the
   * role, the order marked paid, the payment on record once (Stripe's session id is its id — a retried event adds nothing).
   */
  const openPaidCheckout = async (deps: AppDeps, s: StripeCheckoutSession, source: string) => {
    const b = billingOf(deps);
    const orderId = s.metadata?.orderId ?? null;
    const order = orderId ? await deps.store.getOrder(orderId) : await deps.store.getOrderBySession(s.id);
    const userId = s.client_reference_id ?? s.metadata?.userId ?? order?.userId ?? null;
    if (!userId || !(await deps.store.getUser(userId))) return;
    const plan = asPlanId(s.metadata?.planId ?? order?.plan ?? 'club');
    const def = planOf(deps.store.billingSettings().plans, plan);
    const customerId = typeof s.customer === 'string' ? s.customer : null;
    const subscriptionId = typeof s.subscription === 'string' ? s.subscription : null;
    const now = new Date().toISOString();
    let periodEndAt: string | null = periodEnd(now, def.interval, def.intervalCount);
    let periodStartAt: string | null = now;
    if (subscriptionId && stripeConfigured(b)) {
      const sub = await retrieveSubscription(b, subscriptionId).catch(() => null);
      if (sub?.current_period_end) periodEndAt = unixIso(sub.current_period_end);
      if (sub?.current_period_start) periodStartAt = unixIso(sub.current_period_start);
    }
    await deps.store.setSubscription({ userId, plan, planUntil: periodEndAt, startedAt: periodStartAt, status: 'active', customerId, subscriptionId, source: 'stripe' });
    await roleForPlan(deps, userId, plan);
    const paymentIntentId = typeof s.payment_intent === 'string' ? s.payment_intent : null;
    if (order) await deps.store.updateOrder(order.orderId, { status: 'paid', sessionId: s.id, paymentIntentId, note: source });
    const facts = stripeConfigured(b) ? await chargeFacts(b, { paymentIntent: paymentIntentId }) : null;
    await deps.store.recordPayment({ id: `pay-stripe-${s.id}`, userId, plan, amountCents: typeof s.amount_total === 'number' ? s.amount_total : (order?.amountCents ?? 0), currency: String(s.currency ?? order?.currency ?? 'usd'), paidAt: now, source: 'stripe', ref: s.id, periodStart: periodStartAt, periodEnd: periodEndAt, note: `Stripe Checkout (${source})`, paymentIntentId: facts?.paymentIntentId ?? paymentIntentId, chargeId: facts?.chargeId ?? null, feeCents: facts?.feeCents ?? null, netCents: facts?.netCents ?? null, promoCode: order?.promoCode ?? s.metadata?.promo ?? '' });
  };

  /** The offers on sale right now (offers.ts), lowest `sort` first within a plan. */
  const offersOnSale = async (deps: AppDeps): Promise<PlanOffer[]> => (await deps.store.listOffers()).filter((o) => offerOnSale(o));

  /** The Plans page: the plans on offer, the currencies they are priced in, where this account stands, its payments. */
  app.get('/plans', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const b = billingOf(deps);
    const settings = await deps.store.getBillingSettings();
    const sub = await deps.store.getSubscription(user.userId);
    const offers = await offersOnSale(deps);
    const currencies = [...new Set([...settings.plans.flatMap((p) => Object.keys(p.prices)), ...offers.flatMap((o) => Object.keys(o.prices))])].sort((x, y) => (x === 'usd' ? -1 : y === 'usd' ? 1 : x.localeCompare(y)));
    const res: PlansResponse = {
      plans: settings.plans,
      offers,
      note: settings.note,
      currencies,
      checkout: stripeConfigured(b),
      portal: Boolean(stripeConfigured(b) && sub?.customerId),
      entitlement: user.entitlement,
      subscription: user.subscription,
      payments: await deps.store.listPayments({ userId: user.userId, limit: 24 }),
    };
    return c.json(res);
  });

  /** A promo code looked at before paying: what it gives, or why it cannot be used (404 bad_promo). */
  app.get('/plans/promo/:code', async (c) => {
    const deps = c.get('deps');
    const code = normalizeCode(c.req.param('code'));
    const promo = code ? await deps.store.getPromo(code) : null;
    if (promo && (await deps.store.promoUsedBy(promo.code, c.get('user').userId))) return err(c, 404, 'bad_promo', 'You have used that code already');
    const why = promoRefusal(promo, promo?.plans[0] ?? 'svv');
    if (!promo || (why && !why.startsWith('That code is for'))) return err(c, 404, 'bad_promo', why ?? 'That code is not valid');
    return c.json({ promo: promoPreview(promo, moneyLabel) });
  });

  /**
   * A Checkout for a plan: the plan must be on sale, priced in the currency asked for (the price is the admin's, never
   * the browser's) — the plan's own price, or one of its offers on sale (offers.ts) —, the account not a super admin
   * (nothing to buy). A promo code on it must be good for the plan, not used by this account, not used up: a percent
   * or amount code becomes a Stripe coupon on the session (made once per code); a fee-void code opens the plan right
   * here, with no Stripe at all, and records a payment of 0 with the code. An order is opened first (pending) and its
   * id goes on the session and on the idempotency key, so a retried request opens no second session.
   */
  app.post('/plans/checkout', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { planId?: string; currency?: string; appUrl?: string; offerId?: string | null; promo?: string };
    const b = billingFor(c, deps, body.appUrl);
    const settings = await deps.store.getBillingSettings();
    const plan = settings.plans.find((p) => p.id === body.planId);
    if (!plan || plan.id === 'free') return err(c, 400, 'bad_request', 'Pick a plan to pay for');
    if (!plan.selfService) return err(c, 409, 'self_service_off', `The ${plan.title} plan is granted by the SingersVoice admin — ask them`);
    if (user.role === 'super_admin') return err(c, 409, 'super_admin', 'A super admin has every plan already — nothing to pay for');
    const currency = String(body.currency ?? 'usd').toLowerCase();
    if (!CURRENCY.test(currency)) return err(c, 400, 'bad_currency', 'Pick a currency');
    // The option: an offer on sale for this plan, or the plan's own price and period.
    const offerId = body.offerId ? String(body.offerId).slice(0, 80) : null;
    const offer = offerId ? await deps.store.getOffer(offerId) : null;
    if (offerId && (!offer || offer.plan !== plan.id || !offerOnSale(offer))) return err(c, 409, 'offer_gone', 'That offer is no longer on sale — pick another');
    const priced = offer ?? plan;
    const amountCents = priced.prices[currency];
    if (!amountCents) return err(c, 400, 'bad_currency', `The ${plan.title} plan is not priced in ${currency.toUpperCase()}${offer ? ` for ${offer.title || 'that offer'}` : ''}`);
    const interval = priced.interval;
    const intervalCount = priced.intervalCount;
    // The code, if one came.
    const code = normalizeCode(String(body.promo ?? ''));
    let promo: PromoCode | null = null;
    if (code) {
      promo = await deps.store.getPromo(code);
      if (promo && (await deps.store.promoUsedBy(promo.code, user.userId))) return err(c, 409, 'bad_promo', 'You have used that code already');
      const why = promoRefusal(promo, plan.id);
      if (!promo || why) return err(c, 409, 'bad_promo', why ?? 'That code is not valid');
      if (promo.kind === 'amount' && promo.currency !== currency) return err(c, 409, 'bad_promo', `That code is for payments in ${(promo.currency ?? 'usd').toUpperCase()} — pay in it, or leave the code off`);
    }
    if (promo && promo.kind === 'free') {
      // The fee voided: the plan opens now for the code's periods; no Stripe, a payment of 0 on record with the code.
      const now = new Date();
      const current = await deps.store.getSubscription(user.userId);
      const activeNow = current && current.status === 'active' && current.planUntil && Date.parse(current.planUntil) > now.getTime() && asPlanId(current.plan) === plan.id;
      const from = activeNow ? new Date(current!.planUntil!) : now;
      const until = freeUntil(from, interval, intervalCount, promo.freePeriods);
      const order = await deps.store.createOrder({ orderId: newId('ord-'), userId: user.userId, plan: plan.id, currency, amountCents: 0, offerId, promoCode: promo.code, discountCents: amountCents * promo.freePeriods, status: 'paid', note: `Fee voided by code ${promo.code}` });
      await deps.store.usePromo(promo.code, user.userId, order.orderId);
      await deps.store.setSubscription({ userId: user.userId, plan: plan.id, planUntil: until, startedAt: activeNow ? (current!.startedAt ?? now.toISOString()) : now.toISOString(), status: 'active', source: 'grant' });
      await roleForPlan(deps, user.userId, plan.id);
      await deps.store.recordPayment({ id: `pay-promo-${order.orderId}`, userId: user.userId, plan: plan.id, amountCents: 0, currency, paidAt: now.toISOString(), source: 'promo', ref: promo.code, periodStart: from.toISOString(), periodEnd: until, note: `${plan.title} with code ${promo.code} — no payment`, promoCode: promo.code });
      return c.json({ url: `${b.appUrl.replace(/\/$/, '')}/plans?billing=granted`, orderId: order.orderId, granted: true });
    }
    if (!stripeConfigured(b)) return err(c, 409, 'billing_unconfigured', 'Payments are not set up on this service yet — ask the SingersVoice admin for the plan');
    const sub = await deps.store.getSubscription(user.userId);
    const discount = promo ? discountCents(promo, amountCents, currency) : 0;
    const order = await deps.store.createOrder({ orderId: newId('ord-'), userId: user.userId, plan: plan.id, currency, amountCents, offerId, promoCode: promo?.code ?? '', discountCents: discount });
    if (promo) await deps.store.usePromo(promo.code, user.userId, order.orderId);
    try {
      let couponId: string | null = null;
      if (promo && promo.kind !== 'free') {
        couponId = await deps.store.promoStripeCoupon(promo.code);
        if (!couponId) {
          couponId = (await createCoupon(b, { code: promo.code, kind: promo.kind, value: promo.value, currency: promo.currency, duration: promo.duration })).id;
          await deps.store.setPromoStripeCoupon(promo.code, couponId);
        }
      }
      const r = await createCheckoutSession(b, { userId: user.userId, email: user.email, customerId: sub?.customerId ?? null }, { plan: plan.id, planTitle: offer?.title ? `${plan.title} — ${offer.title}` : plan.title, currency, amountCents: order.amountCents, interval, intervalCount, orderId: order.orderId, offerId, couponId, promoCode: promo?.code ?? '' });
      await deps.store.updateOrder(order.orderId, { sessionId: r.sessionId });
      return c.json({ url: r.url, orderId: order.orderId });
    } catch (e) {
      await deps.store.updateOrder(order.orderId, { status: 'failed', note: e instanceof Error ? e.message : 'Stripe did not answer' });
      return err(c, 409, 'stripe', e instanceof Error ? e.message : 'Stripe did not answer');
    }
  });

  /**
   * Back from Checkout: what became of the order — the webhook's word. An order still pending or processing is asked
   * of Stripe itself while it is being polled (a webhook that has not landed, or never will): a paid session opens
   * the plan right here, an expired one closes the order.
   */
  app.get('/billing/session/:id', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const b = billingOf(deps);
    const id = c.req.param('id');
    let order = await deps.store.getOrderBySession(id);
    if (!order || order.userId !== user.userId) return err(c, 404, 'no_order', 'No such checkout on this account');
    if ((order.status === 'pending' || order.status === 'processing') && stripeConfigured(b)) {
      const s = await retrieveCheckoutSession(b, id).catch(() => null);
      if (s) {
        if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') await openPaidCheckout(deps, s, 'reconciled on return');
        else if (s.status === 'expired') await deps.store.updateOrder(order.orderId, { status: 'expired', note: 'The checkout page expired' });
        else if (s.status === 'complete') await deps.store.updateOrder(order.orderId, { status: 'processing', note: "Waiting for the bank's confirmation", paymentIntentId: typeof s.payment_intent === 'string' ? s.payment_intent : order.paymentIntentId });
        order = (await deps.store.getOrder(order.orderId))!;
      }
    }
    return c.json({ order });
  });

  app.post('/billing/portal', async (c) => {
    const deps = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { appUrl?: string };
    const b = billingFor(c, deps, body.appUrl);
    const sub = await deps.store.getSubscription(c.get('user').userId);
    if (!stripeConfigured(b) || !sub?.customerId) return err(c, 404, 'no_customer', 'No subscription to manage on this account');
    try {
      return c.json(await createPortalSession(b, sub.customerId));
    } catch (e) {
      return err(c, 409, 'stripe', e instanceof Error ? e.message : 'Stripe did not answer');
    }
  });

  /**
   * Stripe tells us what became of every payment. The signature proves it is Stripe; the event id makes retries
   * harmless; the order and the subscription change only on Stripe's word — never on a browser's return. A Checkout's
   * `payment_status` decides: paid opens the plan; unpaid is a bank still to confirm (UPI, some wallets) until
   * `async_payment_succeeded` / `_failed`; an expired session closes its order. Invoices are the renewals (the first
   * invoice belongs to the Checkout and is not counted twice); the subscription events carry the period's end and the
   * standing; a refund on Stripe's side lands on the payment.
   */
  app.post('/billing/webhook', async (c) => {
    const deps = c.get('deps');
    const b = billingOf(deps);
    if (!b.webhookSecret) return err(c, 404, 'billing_unconfigured', 'No webhook secret on this service');
    const raw = await c.req.text();
    if (!(await verifyStripeSignature(b.webhookSecret, raw, c.req.header('stripe-signature') ?? null))) return err(c, 400, 'bad_signature', 'Not a Stripe signature for this body');
    const event = JSON.parse(raw) as { id: string; type: string; data: { object: Record<string, unknown> } };
    if (!(await deps.store.markBillingEvent(event.id))) return c.json({ ok: true as const, seen: true });
    const obj = event.data.object;
    const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = obj as unknown as StripeCheckoutSession;
      if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') await openPaidCheckout(deps, s, event.type);
      else {
        const order = s.metadata?.orderId ? await deps.store.getOrder(s.metadata.orderId) : await deps.store.getOrderBySession(s.id);
        if (order && order.status !== 'paid') await deps.store.updateOrder(order.orderId, { status: 'processing', sessionId: s.id, paymentIntentId: typeof s.payment_intent === 'string' ? s.payment_intent : null, note: "Waiting for the bank's confirmation" });
      }
    } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
      const s = obj as unknown as StripeCheckoutSession;
      const order = s.metadata?.orderId ? await deps.store.getOrder(s.metadata.orderId) : await deps.store.getOrderBySession(s.id);
      if (order && order.status !== 'paid') await deps.store.updateOrder(order.orderId, { status: event.type === 'checkout.session.expired' ? 'expired' : 'failed', sessionId: s.id, note: event.type === 'checkout.session.expired' ? 'The checkout page expired' : 'The bank did not confirm the payment' });
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      const inv = obj as { id?: string; customer?: string; subscription?: string | null; amount_paid?: number; currency?: string; billing_reason?: string; charge?: string | null; payment_intent?: string | null; period_start?: number; period_end?: number; subscription_details?: { metadata?: { userId?: string; planId?: string } }; lines?: { data?: { period?: { start?: number; end?: number } }[] } };
      const userId = inv.subscription_details?.metadata?.userId || (typeof inv.subscription === 'string' ? await deps.store.userIdBySubscription(inv.subscription) : null) || (typeof inv.customer === 'string' ? await deps.store.userIdByCustomer(inv.customer) : null);
      if (userId && inv.billing_reason !== 'subscription_create' && (await deps.store.getUser(userId))) {
        const period = inv.lines?.data?.[0]?.period ?? { start: inv.period_start, end: inv.period_end };
        const invoiceId = inv.id ?? event.id;
        const current = await deps.store.getSubscription(userId);
        const plan = asPlanId(inv.subscription_details?.metadata?.planId ?? current?.plan ?? 'club');
        // The renewal paid for the period: the plan runs to its end (the subscription event says the same).
        if (period.end) await deps.store.setSubscription({ userId, plan, planUntil: unixIso(period.end), startedAt: current?.startedAt ?? unixIso(period.start), status: 'active', source: 'stripe' });
        const facts = stripeConfigured(b) ? await chargeFacts(b, { charge: inv.charge ?? null, paymentIntent: inv.payment_intent ?? null }) : null;
        await deps.store.recordPayment({ id: `pay-stripe-${invoiceId}`, userId, plan, amountCents: money(inv.amount_paid), currency: String(inv.currency ?? 'usd'), paidAt: new Date().toISOString(), source: 'stripe', ref: invoiceId, periodStart: unixIso(period.start), periodEnd: unixIso(period.end), note: 'Stripe renewal', paymentIntentId: facts?.paymentIntentId ?? inv.payment_intent ?? null, chargeId: facts?.chargeId ?? inv.charge ?? null, feeCents: facts?.feeCents ?? null, netCents: facts?.netCents ?? null });
      }
    } else if (event.type === 'invoice.payment_failed') {
      // Stripe retries the card for a while (the subscription stands past_due and the plan runs to its period's end); noted on the order of that subscription, nothing closed here.
      const inv = obj as { subscription?: string | null; customer?: string };
      const userId = (typeof inv.subscription === 'string' ? await deps.store.userIdBySubscription(inv.subscription) : null) || (typeof inv.customer === 'string' ? await deps.store.userIdByCustomer(inv.customer) : null);
      if (userId) console.warn(`[billing] a renewal payment failed for ${userId}: Stripe retries; the plan closes at its period's end unless it goes through`);
    } else if (event.type.startsWith('customer.subscription.')) {
      const sub = obj as unknown as StripeSubscription;
      const userId = sub.metadata?.userId || (await deps.store.userIdBySubscription(sub.id)) || (await deps.store.userIdByCustomer(sub.customer));
      if (userId && (await deps.store.getUser(userId))) {
        const current = await deps.store.getSubscription(userId);
        const plan = asPlanId(sub.metadata?.planId ?? current?.plan ?? 'club');
        if (event.type === 'customer.subscription.deleted' || !subscriptionKeepsPlan(sub)) {
          // Over on Stripe's side: the plan closes (the period paid for already ran out, or the subscription was ended).
          await deps.store.setSubscription({ userId, plan, planUntil: current?.planUntil && Date.parse(current.planUntil) < Date.now() ? current.planUntil : new Date().toISOString(), startedAt: current?.startedAt ?? null, status: 'active', customerId: sub.customer, subscriptionId: sub.id, source: 'stripe' });
        } else {
          await deps.store.setSubscription({ userId, plan, planUntil: unixIso(sub.current_period_end) ?? current?.planUntil ?? null, startedAt: current?.startedAt ?? unixIso(sub.current_period_start), status: 'active', customerId: sub.customer, subscriptionId: sub.id, source: 'stripe' });
          await roleForPlan(deps, userId, plan);
        }
      }
    } else if (event.type === 'charge.refunded') {
      const ch = obj as { id?: string; payment_intent?: string | null; amount_refunded?: number; refunded?: boolean };
      const payment = (ch.id ? await deps.store.paymentByCharge(ch.id) : null) ?? (typeof ch.payment_intent === 'string' ? await deps.store.paymentByCharge(ch.payment_intent) : null);
      if (payment) {
        const refunded = money(ch.amount_refunded);
        await deps.store.updatePayment(payment.id, { chargeId: payment.chargeId ?? ch.id ?? null, refundedCents: refunded, status: refunded >= payment.amountCents && payment.amountCents > 0 ? 'refunded' : refunded > 0 ? 'partly_refunded' : 'paid' });
      }
    }
    return c.json({ ok: true as const });
  });

  // ---------- Social (social.ts): the networks a singer posts clips to ----------

  /**
   * How SingersVoice is registered with the networks: what the super admin pasted on the Admin page (`settings` key
   * `social`, the secrets sealed) over what the environment says (X_CLIENT_ID… — the deploy's secrets); the endpoints
   * and the service's address are the environment's.
   */
  const socialOf = async (deps: AppDeps): Promise<SocialConfig> => {
    const env = deps.social ?? {};
    const apps = await deps.store.getSocialApps();
    const open = async (sealed: string) => (sealed ? await deps.secrets.open(sealed).catch(() => '') : '');
    return {
      ...env,
      xClientId: apps.xClientId || env.xClientId,
      xClientSecret: apps.xClientId ? await open(apps.xClientSecretSealed) : env.xClientSecret,
      metaAppId: apps.metaAppId || env.metaAppId,
      metaAppSecret: apps.metaAppId ? await open(apps.metaAppSecretSealed) : env.metaAppSecret,
    };
  };
  /** Where the networks send the browser back: the service's own address (SERVICE_URL, else this request's origin) and the provider's callback. */
  const socialRedirect = (c: Context<Env>, deps: AppDeps, provider: 'x' | 'meta'): string => `${(deps.social?.serviceUrl ?? new URL(c.req.url).origin).replace(/\/$/, '')}/social/${provider}/callback`;
  const socialStatus = async (deps: AppDeps, userId: string): Promise<SocialStatus> => {
    const accounts = await deps.store.listSocialAccounts(userId);
    let pagesToPick: SocialPage[] = [];
    const pending = await deps.store.getSocialPending(userId);
    if (pending) {
      try {
        pagesToPick = (JSON.parse(await deps.secrets.open(pending)) as MetaPage[]).map(({ accessToken: _t, ...p }) => p);
      } catch {
        pagesToPick = [];
      }
    }
    const cfg = await socialOf(deps);
    return {
      configured: { x: xConfigured(cfg), meta: metaConfigured(cfg) },
      // X renews its tokens itself (the refresh token): no expiry to show; a Page's token does not expire.
      connections: accounts.map((a) => ({ network: a.network, handle: a.handle, targetId: a.targetId, connectedAt: a.connectedAt, expiresAt: a.network === 'x' ? null : a.expiresAt })),
      pagesToPick,
      posts: await deps.store.listSocialPosts(userId, 20),
    };
  };
  /** A Facebook Page connected — and the Instagram professional account linked to it, when there is one — on the Page's token. */
  const connectMetaPage = async (deps: AppDeps, userId: string, page: MetaPage) => {
    const sealed = await deps.secrets.seal(page.accessToken);
    await deps.store.putSocialAccount({ userId, network: 'facebook', targetId: page.pageId, handle: page.name, sealedToken: sealed, sealedRefresh: null, expiresAt: null });
    if (page.instagram) await deps.store.putSocialAccount({ userId, network: 'instagram', targetId: page.instagram.id, handle: page.instagram.username, sealedToken: sealed, sealedRefresh: null, expiresAt: null });
    else await deps.store.deleteSocialAccount(userId, 'instagram');
  };

  app.get('/social', async (c) => c.json(await socialStatus(c.get('deps'), c.get('user').userId)));

  /** A sign-in with the network started: the page to send the browser to (the state and, for X, the PKCE pair kept here). */
  app.post('/social/:provider/connect', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const provider = c.req.param('provider');
    if (provider !== 'x' && provider !== 'meta') return err(c, 404, 'no_provider', 'Connect X, or Facebook and Instagram (meta)');
    const cfg = await socialOf(deps);
    if (provider === 'x' ? !xConfigured(cfg) : !metaConfigured(cfg)) return err(c, 409, 'social_unconfigured', `Posting to ${provider === 'x' ? 'X' : 'Facebook and Instagram'} is not switched on yet — the SingersVoice admin does that on the Admin page (Social posting)`);
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { appUrl?: string };
    const appUrl = billingFor(c, deps, body.appUrl).appUrl;
    const redirectUri = socialRedirect(c, deps, provider);
    const state = randomToken(24);
    if (provider === 'x') {
      const { verifier, challenge } = await pkce();
      await deps.store.putSocialState({ state, userId: user.userId, provider, verifier, appUrl, redirectUri });
      return c.json({ url: xAuthorizeUrl(cfg, { redirectUri, state, challenge }) });
    }
    await deps.store.putSocialState({ state, userId: user.userId, provider, verifier: '', appUrl, redirectUri });
    return c.json({ url: metaAuthorizeUrl(cfg, { redirectUri, state }) });
  });

  /**
   * The network sends the browser back with a code and our state: the state names the sign-in (once, within a quarter
   * hour), the code is traded for tokens here (the client secret never leaves the service), the tokens are sealed into the
   * account's row, and the browser goes on to the app's Settings page. No sign-in of ours: the state is the credential.
   */
  app.get('/social/:provider/callback', async (c) => {
    const deps = c.get('deps');
    const provider = c.req.param('provider') as 'x' | 'meta';
    const state = c.req.query('state') ?? '';
    const st = state && /^[A-Za-z0-9_-]{16,64}$/.test(state) && (provider === 'x' || provider === 'meta') ? await deps.store.takeSocialState(state, provider) : null;
    if (!st) return c.text('This sign-in link is not one we are waiting for (it was used, or it is older than a quarter hour). Go back to SingersVoice → Settings → Social and tap Connect again.', 400);
    const back = (ok: boolean, why = '') => c.redirect(`${st.appUrl}/settings?social=${provider}&ok=${ok ? '1' : '0'}${why ? `&why=${encodeURIComponent(why.slice(0, 160))}` : ''}#social`, 302);
    const denied = c.req.query('error') ?? '';
    const code = c.req.query('code') ?? '';
    if (denied || !code) return back(false, c.req.query('error_description') ?? denied ?? 'no code');
    const cfg = await socialOf(deps);
    try {
      if (provider === 'x') {
        const t = await xExchange(cfg, { code, redirectUri: st.redirectUri, verifier: st.verifier });
        const me = await xMe(cfg, t.accessToken);
        await deps.store.putSocialAccount({ userId: st.userId, network: 'x', targetId: me.id, handle: `@${me.username}`, sealedToken: await deps.secrets.seal(t.accessToken), sealedRefresh: t.refreshToken ? await deps.secrets.seal(t.refreshToken) : null, expiresAt: t.expiresAt });
        return back(true);
      }
      const t = await metaExchange(cfg, { code, redirectUri: st.redirectUri });
      const pages = await metaPages(cfg, t.accessToken);
      if (!pages.length) return back(false, 'no_page');
      if (pages.length === 1) {
        await connectMetaPage(deps, st.userId, pages[0]!);
        await deps.store.deleteSocialPending(st.userId);
        return back(true);
      }
      await deps.store.putSocialPending(st.userId, await deps.secrets.seal(JSON.stringify(pages)));
      return back(true, 'pick');
    } catch (e) {
      return back(false, e instanceof Error ? e.message : 'the network did not answer');
    }
  });

  /** After a Meta sign-in that found several Pages: the one picked is connected (with its Instagram account). */
  app.post('/social/meta/page', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { pageId?: string };
    const pending = await deps.store.getSocialPending(user.userId);
    if (!pending) return err(c, 404, 'no_pages', 'No Pages to pick from — connect Facebook again');
    let pages: MetaPage[] = [];
    try {
      pages = JSON.parse(await deps.secrets.open(pending)) as MetaPage[];
    } catch {
      pages = [];
    }
    const page = pages.find((p) => p.pageId === String(body.pageId ?? ''));
    if (!page) return err(c, 404, 'no_page', 'That is not one of your Pages');
    await connectMetaPage(deps, user.userId, page);
    await deps.store.deleteSocialPending(user.userId);
    return c.json(await socialStatus(deps, user.userId));
  });

  /** A network let go: its tokens are dropped here (and told to X); Facebook and Instagram go together (one token). */
  app.delete('/social/:network', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const network = c.req.param('network') as SocialNetwork;
    if (!SOCIAL_NETWORKS.includes(network)) return err(c, 404, 'no_network', 'No such network');
    const a = await deps.store.getSocialAccount(user.userId, network);
    if (a && network === 'x') await deps.secrets.open(a.sealedToken).then(async (t) => xRevoke(await socialOf(deps), t)).catch(() => undefined);
    await deps.store.deleteSocialAccount(user.userId, network);
    if (network === 'facebook') await deps.store.deleteSocialAccount(user.userId, 'instagram');
    if (network === 'instagram') await deps.store.deleteSocialAccount(user.userId, 'facebook');
    await deps.store.deleteSocialPending(user.userId);
    return c.json(await socialStatus(deps, user.userId));
  });

  /** X's token, fresh: renewed through the refresh token when it is about to run out (two-hour tokens). */
  const xToken = async (deps: AppDeps, a: { userId: string; sealedToken: string; sealedRefresh: string | null; expiresAt: string | null }): Promise<string> => {
    const token = await deps.secrets.open(a.sealedToken);
    if (!a.expiresAt || Date.parse(a.expiresAt) - Date.now() > 120_000 || !a.sealedRefresh) return token;
    const t = await xRefresh(await socialOf(deps), await deps.secrets.open(a.sealedRefresh));
    await deps.store.setSocialTokens(a.userId, 'x', { sealedToken: await deps.secrets.seal(t.accessToken), sealedRefresh: t.refreshToken ? await deps.secrets.seal(t.refreshToken) : a.sealedRefresh, expiresAt: t.expiresAt });
    return t.accessToken;
  };
  /** An Instagram container still processing: looked at again, published when Instagram is done. */
  const continueInstagram = async (deps: AppDeps, post: SocialPost): Promise<SocialPost> => {
    if (post.network !== 'instagram' || post.status !== 'processing' || !post.externalId) return post;
    const a = await deps.store.getSocialAccount(post.userId, 'instagram');
    if (!a) return (await deps.store.updateSocialPost(post.postId, { status: 'failed', note: 'Instagram is no longer connected' }))!;
    try {
      const token = await deps.secrets.open(a.sealedToken);
      const cfg = await socialOf(deps);
      const st = await igContainerStatus(cfg, token, post.externalId);
      if (st.status === 'FINISHED') {
        const r = await igPublish(cfg, token, a.targetId, post.externalId);
        return (await deps.store.updateSocialPost(post.postId, { status: 'posted', externalId: r.id, url: r.url ?? `https://www.instagram.com/${encodeURIComponent(a.handle)}/`, note: '' }))!;
      }
      if (st.status === 'ERROR' || st.status === 'EXPIRED') return (await deps.store.updateSocialPost(post.postId, { status: 'failed', note: `Instagram could not take the video${st.note ? ` (${st.note})` : ''}` }))!;
      if (Date.now() - Date.parse(post.createdAt) > 20 * 60_000) return (await deps.store.updateSocialPost(post.postId, { status: 'failed', note: 'Instagram did not finish processing the video' }))!;
      return post;
    } catch (e) {
      return (await deps.store.updateSocialPost(post.postId, { status: 'failed', note: e instanceof Error ? e.message : 'Instagram did not answer' }))!;
    }
  };

  /**
   * A clip posted: the file and its words come as a form; the network must be connected; the service pushes the clip to
   * it. X and a Facebook Page answer within the request; Instagram processes the video on its side, so the post may come
   * back `processing` — the app polls it (`GET /social/posts/:id`) until it is posted. A failure is on the post (`failed`,
   * the note), never a secret of the network's.
   */
  app.post('/social/posts', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > SOCIAL_CLIP_MAX_BYTES + 64 * 1024) return err(c, 413, 'too_big', 'The clip is too big to post from here (95 MB at most) — make it shorter');
    if ((await deps.store.countSocialPostsRecent(user.userId, 3600_000)) >= SOCIAL_POSTS_PER_HOUR) return err(c, 429, 'rate_limited', `${SOCIAL_POSTS_PER_HOUR} posts an hour at most — wait a little`);
    const form = await c.req.parseBody().catch(() => null);
    if (!form) return err(c, 400, 'bad_request', 'The clip and its words go in a form');
    const network = String(form.network ?? '') as SocialNetwork;
    if (!SOCIAL_NETWORKS.includes(network)) return err(c, 400, 'bad_request', 'network must be x, facebook or instagram');
    const clip = form.clip;
    if (!(clip instanceof File) || clip.size === 0) return err(c, 400, 'bad_request', 'No clip came');
    if (clip.size > SOCIAL_CLIP_MAX_BYTES) return err(c, 413, 'too_big', 'The clip is too big to post from here (95 MB at most) — make it shorter');
    const a = await deps.store.getSocialAccount(user.userId, network);
    if (!a) return err(c, 409, 'not_connected', `${network === 'x' ? 'X' : network === 'facebook' ? 'Facebook' : 'Instagram'} is not connected — Settings → Social`);
    const text = String(form.text ?? '').slice(0, CAPTION_MAX[network]);
    const title = String(form.title ?? '').slice(0, 200);
    const performanceId = typeof form.performanceId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(form.performanceId) ? form.performanceId : null;
    const clipMs = Math.max(0, Math.round(Number(form.clipMs ?? 0))) || 0;
    const mime = /^video\/(mp4|webm|quicktime)$/.test(clip.type) ? clip.type : 'video/mp4';
    const bytes = new Uint8Array(await clip.arrayBuffer());
    let post = await deps.store.createSocialPost({ postId: newId('post-'), userId: user.userId, network, text, performanceId, title, clipMs });
    const cfg = await socialOf(deps);
    try {
      if (network === 'x') {
        const token = await xToken(deps, a);
        const mediaId = await xUploadVideo(cfg, token, bytes, mime, (ms) => new Promise((r) => setTimeout(r, cfg.pollMs ? Math.min(ms, cfg.pollMs) : ms)));
        const r = await xCreatePost(cfg, token, text, mediaId);
        post = (await deps.store.updateSocialPost(post.postId, { status: 'posted', externalId: r.id, url: xPostUrl(a.handle.replace(/^@/, ''), r.id) }))!;
      } else if (network === 'facebook') {
        const r = await fbPostVideo(cfg, await deps.secrets.open(a.sealedToken), a.targetId, bytes, mime, text);
        post = (await deps.store.updateSocialPost(post.postId, { status: 'posted', externalId: r.id, url: fbVideoUrl(r.id) }))!;
      } else {
        const token = await deps.secrets.open(a.sealedToken);
        const r = await igCreateReel(cfg, token, a.targetId, bytes, text);
        post = (await deps.store.updateSocialPost(post.postId, { status: 'processing', externalId: r.containerId, note: 'Instagram is processing the video' }))!;
        // A few looks right away: a short clip is often through within seconds.
        for (let i = 0; i < 4 && post.status === 'processing'; i++) {
          await new Promise((r) => setTimeout(r, cfg.pollMs ?? 3000));
          post = await continueInstagram(deps, post);
        }
      }
    } catch (e) {
      post = (await deps.store.updateSocialPost(post.postId, { status: 'failed', note: e instanceof Error ? e.message : 'the network did not answer' }))!;
    }
    return c.json({ post });
  });

  app.get('/social/posts/:id', async (c) => {
    const deps = c.get('deps');
    const post = await deps.store.getSocialPost(c.req.param('id'));
    if (!post || post.userId !== c.get('user').userId) return err(c, 404, 'no_post', 'No such post');
    return c.json({ post: await continueInstagram(deps, post) });
  });

  app.get('/social/posts', async (c) => c.json({ posts: await c.get('deps').store.listSocialPosts(c.get('user').userId, 50) }));

  /** The super admin's page: how SingersVoice is registered with X and Meta — the ids, whether a secret is set, the callbacks to give the networks. */
  const adminSocial = async (c: Context<Env>, deps: AppDeps): Promise<AdminSocialStatus> => {
    const apps = await deps.store.getSocialApps();
    const env = deps.social ?? {};
    return {
      x: { clientId: apps.xClientId || env.xClientId || '', secretSet: Boolean(apps.xClientId ? apps.xClientSecretSealed : env.xClientSecret), fromEnv: !apps.xClientId && Boolean(env.xClientId) },
      meta: { appId: apps.metaAppId || env.metaAppId || '', secretSet: Boolean(apps.metaAppId ? apps.metaAppSecretSealed : env.metaAppSecret), fromEnv: !apps.metaAppId && Boolean(env.metaAppId) },
      callbacks: { x: socialRedirect(c, deps, 'x'), meta: socialRedirect(c, deps, 'meta') },
      updatedAt: apps.updatedAt,
    };
  };
  app.get('/admin/social', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    return c.json(await adminSocial(c, c.get('deps')));
  });
  /** An id and its secret pasted for a provider (both at once; an empty id takes the pair away). The secret is sealed and never answered. */
  app.put('/admin/social', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const deps = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as AdminSocialUpdate;
    const clean = (v: unknown) => String(v ?? '').trim().slice(0, 200);
    const patch: Partial<SocialApps> = {};
    if (body.xClientId !== undefined) {
      const id = clean(body.xClientId);
      const secret = clean(body.xClientSecret);
      if (id && !secret) return err(c, 400, 'bad_request', 'X needs its Client Secret with the Client ID');
      patch.xClientId = id;
      patch.xClientSecretSealed = id ? await deps.secrets.seal(secret) : '';
    }
    if (body.metaAppId !== undefined) {
      const id = clean(body.metaAppId);
      const secret = clean(body.metaAppSecret);
      if (id && !secret) return err(c, 400, 'bad_request', 'Meta needs its App Secret with the App ID');
      patch.metaAppId = id;
      patch.metaAppSecretSealed = id ? await deps.secrets.seal(secret) : '';
    }
    await deps.store.setSocialApps(patch);
    return c.json(await adminSocial(c, deps));
  });

  // ---------- Clubs: a club owner names the members who share the club's video hours ----------

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const clubStatus = async (deps: AppDeps, user: UserRecord): Promise<ClubStatus> => {
    const plan = planOf(deps.store.billingSettings().plans, user.role === 'super_admin' && user.entitlement.via === 'super_admin' ? 'club' : user.entitlement.plan);
    const now = Date.now();
    return { plan, seats: plan.seats, members: await deps.store.listClubMembers(user.userId), pool: { usedSeconds: await deps.store.videoUsed(user.userId, periodKey(now)), hours: plan.videoHours, periodKey: periodKey(now), resetsAt: periodResetsAt(now) }, subscription: user.subscription };
  };
  /** A club owner: an active plan with seats of their own (a super admin has a club too). */
  const ownsClub = (user: UserRecord) => user.role === 'super_admin' || (user.entitlement.via === 'own' && user.entitlement.seats > 0);

  app.get('/club', async (c) => {
    const user = c.get('user');
    if (!ownsClub(user)) return err(c, 403, 'no_club', 'A club comes with the Club owner plan — see the Plans page');
    return c.json(await clubStatus(c.get('deps'), user));
  });

  app.post('/club/members', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!ownsClub(user)) return err(c, 403, 'no_club', 'A club comes with the Club owner plan — see the Plans page');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { email?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return err(c, 400, 'bad_email', 'That is not an email address');
    if (email === user.email.toLowerCase()) return err(c, 400, 'own_email', 'You are in your club already — add the others');
    const status = await clubStatus(deps, user);
    if (!status.members.some((m) => m.email === email) && status.members.length >= status.seats) return err(c, 409, 'no_seats', `Your club has its ${status.seats} members — remove one to add another`);
    await deps.store.addClubMember(user.userId, email);
    return c.json(await clubStatus(deps, user));
  });

  app.delete('/club/members/:email', async (c) => {
    const deps = c.get('deps');
    const user = c.get('user');
    if (!ownsClub(user)) return err(c, 403, 'no_club', 'A club comes with the Club owner plan — see the Plans page');
    await deps.store.removeClubMember(user.userId, decodeURIComponent(c.req.param('email')));
    return c.json(await clubStatus(deps, user));
  });

  // ---------- The Admin page (super admins): accounts, roles, plans, subscriptions, payments ----------

  const superAdminOnly = (c: Context<Env>) => (c.get('user').role !== 'super_admin' ? err(c, 403, 'not_super_admin', 'Only a super admin can do that') : null);

  /** Admin: a plan by hand (older clients) — the plan's own period from now (or until the date given); `plan: free` takes the subscription away. */
  app.post('/admin/plan', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { email?: string; plan?: string; until?: string | null };
    const deps = c.get('deps');
    const store = deps.store;
    const target = body.email ? await store.getUserByEmail(String(body.email)) : null;
    if (!target) return err(c, 404, 'no_user', 'No account with that email has signed in yet');
    const plan = asPlanId(body.plan);
    const def = planOf(store.billingSettings().plans, plan);
    const until = body.until ? new Date(body.until).toISOString() : plan === 'free' ? null : periodEnd(new Date(), def.interval, def.intervalCount);
    await store.setSubscription({ userId: target.userId, plan, planUntil: plan === 'free' ? null : until, startedAt: plan === 'free' ? null : new Date().toISOString(), status: 'active', source: 'grant' });
    await roleForPlan(deps, target.userId, plan);
    if (plan !== 'free') await recordGrant(deps, c.get('user'), target.userId, `${def.title} granted on the Admin page`);
    await refreshUserInMeets(store, target.userId);
    return c.json({ user: (await store.getUser(target.userId))! });
  });

  /**
   * The super admin's billing portal: the plans as priced and the rules; every account with a subscription by what
   * needs doing — expired first, then expiring with the days left, then active, then revoked — with the last payment;
   * the payments on record; the Checkouts that did not end in a payment.
   */
  app.get('/admin/billing', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const deps = c.get('deps');
    const settings = await deps.store.getBillingSettings();
    const users = await deps.store.listUsers();
    const latest = await deps.store.latestPayments();
    const now = Date.now();
    const rank: Record<SubscriptionStanding, number> = { expired: 0, expiring: 1, active: 2, revoked: 3, none: 4 };
    const subscribers: SubscriberRow[] = users
      .filter((u) => u.subscription && u.subscription.status !== 'none')
      .map((u) => {
        const left = daysLeft(u.subscription, now);
        const status = u.subscription?.status ?? 'none';
        const standing: SubscriptionStanding = status === 'active' && left !== null && left <= settings.expiringSoonDays ? 'expiring' : status;
        return { user: u, standing, daysLeft: left, lastPayment: latest.get(u.userId) ?? null };
      })
      .sort((a, b) => rank[a.standing] - rank[b.standing] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.user.name.localeCompare(b.user.name));
    const overview: AdminBillingOverview = { settings, stripe: stripeConfigured(billingOf(deps)), subscribers, payments: await deps.store.listPayments({ limit: 100 }), orders: await deps.store.listOpenOrders(50), offers: await deps.store.listOffers(), promos: await deps.store.listPromos() };
    return c.json(overview);
  });

  // The offers (the ways to pay for a plan) and the promo codes (offers.ts), the super admin's.
  app.post('/admin/offers', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const body = ((await c.req.json().catch(() => null)) ?? null) as PlanOfferInput | null;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'The offer goes in the body as JSON');
    if (asPlanId(body.plan) === 'free') return err(c, 400, 'bad_request', 'An offer is for a paid plan (svv, svvpro, club)');
    return c.json({ offer: await c.get('deps').store.putOffer(newId('off-'), body) });
  });
  app.patch('/admin/offers/:id', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const store = c.get('deps').store;
    const cur = await store.getOffer(c.req.param('id'));
    if (!cur) return err(c, 404, 'no_offer', 'No such offer');
    const body = ((await c.req.json().catch(() => null)) ?? null) as PlanOfferInput | null;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'The changes go in the body as JSON');
    if (body.plan !== undefined && asPlanId(body.plan) === 'free') return err(c, 400, 'bad_request', 'An offer is for a paid plan (svv, svvpro, club)');
    return c.json({ offer: await store.putOffer(cur.offerId, body) });
  });
  app.delete('/admin/offers/:id', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    await c.get('deps').store.deleteOffer(c.req.param('id'));
    return c.json({ ok: true as const });
  });
  app.post('/admin/promos', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const store = c.get('deps').store;
    const body = ((await c.req.json().catch(() => null)) ?? null) as PromoCodeInput | null;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'The code goes in the body as JSON');
    const code = normalizeCode(String(body.code ?? ''));
    if (code.length < 3) return err(c, 400, 'bad_request', 'A code is at least three letters or digits');
    if (await store.getPromo(code)) return err(c, 409, 'exists', `The code ${code} exists already — change it below`);
    const promo = await store.putPromo(code, body, c.get('user').userId);
    if (!promo) return err(c, 400, 'bad_request', 'That is not a code');
    return c.json({ promo });
  });
  app.patch('/admin/promos/:code', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const store = c.get('deps').store;
    const cur = await store.getPromo(c.req.param('code'));
    if (!cur) return err(c, 404, 'no_promo', 'No such code');
    const body = ((await c.req.json().catch(() => null)) ?? null) as PromoCodeInput | null;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'The changes go in the body as JSON');
    const { code: _c, ...patch } = body;
    const promo = await store.putPromo(cur.code, patch, c.get('user').userId);
    return c.json({ promo: promo! });
  });
  app.delete('/admin/promos/:code', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    await c.get('deps').store.deletePromo(c.req.param('code'));
    return c.json({ ok: true as const });
  });

  app.put('/admin/billing/settings', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const body = ((await c.req.json().catch(() => null)) ?? null) as Partial<BillingSettings> | null;
    if (!body || typeof body !== 'object') return err(c, 400, 'bad_request', 'The settings go in the body as JSON');
    if (body.plans !== undefined && !Array.isArray(body.plans)) return err(c, 400, 'bad_request', 'plans must be a list');
    const { updatedAt: _u, ...patch } = body;
    const settings = await c.get('deps').store.setBillingSettings(patch);
    return c.json({ settings });
  });

  /** A payment refunded through Stripe (the whole of it, or `amountCents`); the record says so at once, the webhook confirms. */
  app.post('/admin/payments/:id/refund', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const deps = c.get('deps');
    const b = billingOf(deps);
    const payment = await deps.store.getPayment(c.req.param('id'));
    if (!payment) return err(c, 404, 'no_payment', 'No such payment');
    if (payment.source !== 'stripe') return err(c, 409, 'not_stripe', 'A granted period has nothing to refund');
    if (!stripeConfigured(b)) return err(c, 409, 'billing_unconfigured', 'Stripe is not configured on this service');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { amountCents?: number };
    const left = payment.amountCents - payment.refundedCents;
    const amount = body.amountCents === undefined ? left : Math.min(left, Math.max(1, Math.round(Number(body.amountCents))));
    if (left <= 0 || amount <= 0) return err(c, 409, 'refunded', 'This payment is refunded already');
    try {
      const r = await createRefund(b, { paymentIntent: payment.paymentIntentId, charge: payment.chargeId }, amount === payment.amountCents ? undefined : amount, `refund-${payment.id}-${payment.refundedCents + amount}`);
      const refunded = payment.refundedCents + (r.amount || amount);
      const updated = await deps.store.updatePayment(payment.id, { refundedCents: refunded, status: refunded >= payment.amountCents ? 'refunded' : 'partly_refunded' });
      return c.json({ payment: updated! });
    } catch (e) {
      return err(c, 409, 'stripe', e instanceof Error ? e.message : 'Stripe did not answer');
    }
  });

  app.get('/admin/users', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const users = await c.get('deps').store.listUsers();
    return c.json({ users, total: users.length } satisfies AdminUsersResponse);
  });

  /**
   * One account changed by a super admin: its role, and/or its subscription — grant (a plan, for a period: the plan's
   * own, or the months given), renew (the same length on from the current expiry, or from now once it has passed), set
   * (the plan and the dates given), revoke. The last super admin cannot be demoted, so the Admin page never locks
   * everyone out.
   */
  app.patch('/admin/users/:id', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const deps = c.get('deps');
    const store = deps.store;
    const id = c.req.param('id');
    const target = await store.getUser(id);
    if (!target) return err(c, 404, 'no_user', 'No such account');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as AdminUserUpdate;
    if (body.blocked !== undefined) {
      // Blocked for good: refused everything from their next request. Never a super admin (make them something else first).
      if (body.blocked && target.role === 'super_admin') return err(c, 409, 'super_admin', 'A super admin cannot be blocked — change their role first');
      await store.setUserBlocked(id, Boolean(body.blocked), typeof body.blockedNote === 'string' ? body.blockedNote : '');
      userTouch.delete(id); // the next request reads the row afresh
    }
    if (body.role !== undefined) {
      if (!['audio', 'dual', 'club_owner', 'super_admin'].includes(body.role)) return err(c, 400, 'bad_request', 'role must be audio, dual, club_owner or super_admin');
      if (target.role === 'super_admin' && body.role !== 'super_admin' && (await store.countSuperAdmins()) <= 1) return err(c, 409, 'last_super_admin', 'This is the last super admin — make another one first');
      await store.setRole(id, body.role);
    }
    const sub = body.subscription;
    if (sub) {
      const now = new Date();
      const current = await store.getSubscription(id);
      const plans = store.billingSettings().plans;
      const iso = (v: unknown, fallback: string | null): string | null => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : v === null ? null : fallback);
      const plan: PlanId = sub.plan !== undefined ? asPlanId(sub.plan) : (current?.plan && current.plan !== 'free' ? current.plan : 'club');
      const def = planOf(plans, plan);
      const months = sub.months !== undefined && Number.isFinite(Number(sub.months)) && Number(sub.months) > 0 ? Math.min(120, Math.round(Number(sub.months))) : null;
      /** The period's end from `from`: the months asked for, else the plan's own period. */
      const periodFrom = (from: string | Date) => (months ? periodEnd(from, 'month', months) : periodEnd(from, def.interval, def.intervalCount));
      if (plan === 'free' && sub.action !== 'revoke') return err(c, 400, 'bad_request', 'Grant a paid plan (svv, svvpro, club) — Free needs no grant');
      switch (sub.action) {
        case 'grant': {
          const startedAt = iso(sub.startedAt, now.toISOString())!;
          await store.setSubscription({ userId: id, plan, startedAt, planUntil: iso(sub.expiresAt, periodFrom(startedAt)), status: 'active', source: 'grant' });
          break;
        }
        case 'renew': {
          const from = current?.planUntil && Date.parse(current.planUntil) > now.getTime() ? current.planUntil : now.toISOString();
          await store.setSubscription({ userId: id, plan, startedAt: current?.startedAt ?? now.toISOString(), planUntil: periodFrom(from), status: 'active', source: 'grant' });
          break;
        }
        case 'set': {
          const startedAt = iso(sub.startedAt, current?.startedAt ?? now.toISOString());
          const expiresAt = sub.expiresAt === undefined ? (current?.planUntil ?? periodFrom(startedAt ?? now)) : iso(sub.expiresAt, null);
          await store.setSubscription({ userId: id, plan, startedAt, planUntil: expiresAt, status: 'active', source: 'grant' });
          break;
        }
        case 'revoke':
          if (current) await store.setSubscription({ userId: id, plan: current.plan, startedAt: current.startedAt, planUntil: current.planUntil, status: 'revoked', source: current.source });
          break;
        default:
          return err(c, 400, 'bad_request', 'subscription.action must be grant, renew, set or revoke');
      }
      // The role follows the plan (a Club owner plan makes a club owner; a super admin keeps the role). A period given is on the payments record (amount 0).
      if (sub.action !== 'revoke') {
        await roleForPlan(deps, id, plan);
        await recordGrant(deps, c.get('user'), id, sub.action === 'renew' ? `${def.title} renewed on the Admin page` : sub.action === 'set' ? `${def.title}: dates set on the Admin page` : `${def.title} granted on the Admin page`);
      }
    }
    await refreshUserInMeets(store, id);
    return c.json({ user: (await store.getUser(id))! });
  });

  /** The admin's coupons: the requirement, every coupon with who holds it and whether they are in. */
  app.get('/admin/coupons', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const deps = c.get('deps');
    const res: AdminCouponsResponse = { settings: await deps.store.getCouponSettings(), coupons: await deps.store.listCoupons() };
    return c.json(res);
  });

  app.put('/admin/coupons/settings', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<CouponSettings>;
    return c.json({ settings: await c.get('deps').store.setCouponSettings({ required: body.required }) });
  });

  /** A coupon issued (or changed) for an address: the code given, or a fresh one; the expiry; a note. A changed code or date denies the holder at once. */
  app.put('/admin/coupons', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { email?: string; code?: string; expiresAt?: string; note?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return err(c, 400, 'bad_email', 'That is not an email address');
    const expires = Date.parse(String(body.expiresAt ?? ''));
    if (!Number.isFinite(expires)) return err(c, 400, 'bad_date', 'Give the coupon an expiry date');
    const code = body.code && normalizeCode(body.code) ? displayCode(normalizeCode(body.code)) : newCouponCode();
    if (normalizeCode(code).length < 4) return err(c, 400, 'bad_code', 'A coupon is at least four characters');
    const coupon = await c.get('deps').store.setCoupon({ email, code, expiresAt: new Date(expires).toISOString(), note: String(body.note ?? '').slice(0, 200), createdBy: c.get('user').userId });
    return c.json({ coupon });
  });

  app.delete('/admin/coupons/:email', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    await c.get('deps').store.deleteCoupon(decodeURIComponent(c.req.param('email')));
    return c.json({ ok: true as const });
  });

  /** Tests and the admin: the month's video seconds of an account (or a club's pool) set outright — to see a plan run out. */
  app.put('/admin/users/:id/video-usage', async (c) => {
    const refused = superAdminOnly(c);
    if (refused) return refused;
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { seconds?: number };
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) return err(c, 400, 'bad_request', 'seconds must be a number');
    const store = c.get('deps').store;
    const target = await store.getUser(c.req.param('id'));
    if (!target) return err(c, 404, 'no_user', 'No such account');
    await store.setVideoSeconds(target.userId, periodKey(), seconds);
    await refreshUserInMeets(store, target.userId);
    return c.json({ user: (await store.getUser(target.userId))! });
  });

  // ---------- Publishing mode (the Publisher plan, or an admin) ----------

  app.use('/publishing/*', async (c, next) => {
    const user = c.get('user');
    if (!user.canPublish) return err(c, 403, 'publishing_closed', user.publishingNote || 'Publishing mode is closed to this account');
    await next();
  });

  app.get('/publishing/destinations', async (c) => {
    const { store, relay } = c.get('deps');
    const stored = await store.listDestinations(c.get('user').userId);
    const destinations: Destination[] = DESTINATIONS.map((d) => {
      const s = stored.find((x) => x.kind === d.kind);
      // The in-house portal needs no key and is always available; the others are off until configured.
      if (!s) return { kind: d.kind, label: d.label, enabled: !d.needsKey, ingestUrl: d.needsKey ? d.ingestHint : '', keyHint: '', updatedAt: '' };
      const { keyEnc: _k, ...pub } = s;
      // A YouTube live link saved before the shapes were known (a Studio dashboard link, say) is handed out as the page viewers open.
      if (pub.kind === 'youtube' && pub.watchUrl) pub.watchUrl = youtubeWatchUrl(pub.watchUrl) ?? pub.watchUrl;
      return pub;
    });
    return c.json({ destinations, relay: Boolean(relay) });
  });

  /**
   * The relay's targets for a job: every RTMP destination of the job with its saved ingest url and
   * key, opened from the sealed store here — the only place a key is ever in the clear, and it goes
   * service-to-service only. Destinations without a key are left out (the job's log says so).
   */
  const relayTargets = async ({ store, secrets }: AppDeps, job: PublishJob): Promise<{ targets: RelayTarget[]; missing: DestinationKind[] }> => {
    const targets: RelayTarget[] = [];
    const missing: DestinationKind[] = [];
    for (const kind of job.destinations.filter((k) => RELAY_KINDS.includes(k))) {
      const dest = await store.getDestination(job.ownerUserId, kind);
      const key = dest?.keyEnc ? await secrets.open(dest.keyEnc).catch(() => '') : '';
      const url = (dest?.ingestUrl || DESTINATIONS.find((d) => d.kind === kind)?.ingestHint || '').trim();
      if (key && /^rtmps?:\/\//.test(url)) targets.push({ kind, url, key });
      else missing.push(kind);
    }
    return { targets, missing };
  };

  /** When a job's relay stream last had to be started (per job): a relay that is down is asked again every few seconds, not on every segment. */
  const relayAttempts = new Map<string, number>();
  const RELAY_RETRY_MS = 6000;

  /** Start (or start over) the relay stream of a job; the job's live block and log say how it went. */
  const startRelay = async (deps: AppDeps, job: PublishJob, live: PublishJobLive, now: string): Promise<boolean> => {
    const relay = deps.relay!;
    const { targets, missing } = await relayTargets(deps, job);
    if (!targets.length) {
      live.relay = 'error';
      live.relayNote = `no stream key saved for ${missing.join(', ')}`;
      return false;
    }
    const r = await relayStart(relay, job.jobId, targets);
    live.relay = r.ok ? 'starting' : 'error';
    live.relayNote = r.ok ? `streaming to ${targets.map((t) => t.kind).join(', ')}${missing.length ? ` (no key saved for ${missing.join(', ')})` : ''}` : relayNote(r);
    const note = r.ok ? `Relay: RTMP to ${targets.map((t) => t.kind).join(', ')}` : `Relay: ${r.note}`;
    if (job.events.at(-1)?.note !== note) job.events.push({ at: now, state: job.state, note }); // a relay that stays down is logged once, not every few seconds
    return r.ok;
  };

  app.put('/publishing/destinations/:kind', async (c) => {
    const { store, secrets } = c.get('deps');
    const kind = c.req.param('kind') as DestinationKind;
    const def = DESTINATIONS.find((d) => d.kind === kind);
    if (!def) return err(c, 404, 'no_destination', 'Unknown destination');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<DestinationUpdate>;
    const user = c.get('user');
    const existing = await store.getDestination(user.userId, kind);
    const streamKey = typeof body.streamKey === 'string' ? body.streamKey.trim() : undefined;
    const keyEnc = streamKey ? await secrets.seal(streamKey) : (existing?.keyEnc ?? '');
    const keyHint = streamKey ? `…${streamKey.slice(-4)}` : (existing?.keyHint ?? '');
    if (body.enabled && def.needsKey && !keyEnc) return err(c, 400, 'missing_key', `${def.label} needs a stream key before it can be enabled`);
    // The live link — where viewers watch on the platform — is public and optional; a bare channel name becomes its page.
    let watchUrl = existing?.watchUrl ?? '';
    if (typeof body.watchUrl === 'string') {
      const norm = normalizeWatchUrl(kind, body.watchUrl.slice(0, 300));
      if (norm === null) return err(c, 400, 'bad_watch_url', `The ${def.label} live link must be an https:// link (or just your channel name)`);
      watchUrl = norm;
    }
    const auto = typeof body.auto === 'boolean' ? body.auto : Boolean(existing?.auto);
    const dest = {
      kind,
      label: String(body.label ?? existing?.label ?? def.label).slice(0, 60),
      enabled: Boolean(body.enabled),
      ingestUrl: String(body.ingestUrl ?? existing?.ingestUrl ?? (def.needsKey ? def.ingestHint : '')).slice(0, 300),
      keyHint,
      ...(watchUrl ? { watchUrl } : {}),
      ...(auto ? { auto: true } : {}),
      updatedAt: new Date().toISOString(),
      keyEnc,
    };
    await store.saveDestination(user.userId, dest);
    const { keyEnc: _k, ...destination } = dest;
    return c.json({ destination });
  });

  app.get('/publishing/jobs', async (c) => {
    const jobs = await c.get('deps').store.listJobs(c.get('user').userId, c.req.query('meetId') || undefined);
    return c.json({ jobs });
  });

  app.post('/publishing/jobs', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<PublishJobRequest>;
    if (!body.meetId) return err(c, 400, 'bad_request', 'meetId is required');
    const meet = await store.getMeet(body.meetId);
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    // The host, or a privileged account that joined the meet (its Publishing show view), may publish it.
    if (meet.hostUserId !== user.userId && !(await store.getParticipantByUser(meet.meetId, user.userId, 'any'))) return err(c, 403, 'not_in_meet', 'Join the meet (or host it) to publish it');
    const wanted = (Array.isArray(body.destinations) ? body.destinations : []).filter((k): k is DestinationKind => DESTINATIONS.some((d) => d.kind === k));
    if (!wanted.length) return err(c, 400, 'no_destinations', 'Pick at least one destination');
    const stored = await store.listDestinations(user.userId);
    const enabled = DESTINATIONS.filter((d) => {
      const s = stored.find((x) => x.kind === d.kind);
      return s ? s.enabled : !d.needsKey;
    }).map((d) => d.kind);
    const missing = wanted.filter((k) => !enabled.includes(k));
    if (missing.length) return err(c, 400, 'destination_disabled', `Enable first: ${missing.join(', ')}`);
    if ((await store.liveJobsForMeet(meet.meetId)).length) return err(c, 409, 'already_publishing', 'A publish job is already running for this meet');
    const now = new Date().toISOString();
    const relayOn = Boolean(c.get('deps').relay);
    const browserFed = fedDestinations(wanted, relayOn);
    const queued = wanted.filter((k) => !browserFed.includes(k));
    const job: PublishJob = {
      jobId: newId('pub-'),
      meetId: meet.meetId,
      meetTitle: meet.title,
      ownerUserId: user.userId,
      destinations: wanted,
      title: String(body.title ?? meet.title).slice(0, 120),
      description: String(body.description ?? '').slice(0, 2000),
      state: 'requested',
      watchUrl: wanted.includes('inhouse') ? `/watch/${meet.meetId}` : null,
      error: null,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          at: now,
          state: 'requested',
          note: browserFed.length
            ? `Waiting for the show view to send the first segment (${browserFed.join(', ')})${queued.length ? ` — ${queued.join(', ')} need the RTMP relay, which is not deployed (docs/RELAY.md)` : ''}`
            : 'Queued — these destinations need the RTMP relay, which is not deployed (docs/RELAY.md)',
        },
      ],
      live: { segments: 0, bytes: 0, lastSegmentAt: null, youtube: wanted.includes('youtube') ? 'waiting' : 'off', youtubeNote: '', relay: relayOn && wanted.some((k) => RELAY_KINDS.includes(k)) ? 'starting' : 'off', relayNote: '' },
    };
    // The public pages the app made for this show (a YouTube broadcast of its own), and the broadcast to end on Stop.
    if (body.links && typeof body.links === 'object') {
      const links: Partial<Record<DestinationKind, string>> = {};
      for (const [k, v] of Object.entries(body.links)) if (wanted.includes(k as DestinationKind) && typeof v === 'string' && /^https:\/\/\S{1,300}$/.test(v)) links[k as DestinationKind] = v;
      if (Object.keys(links).length) job.links = links;
    }
    const yt = body.youtube;
    if (yt && typeof yt === 'object' && /^[A-Za-z0-9_-]{1,64}$/.test(String(yt.broadcastId)) && /^[A-Za-z0-9_-]{1,64}$/.test(String(yt.streamId))) job.youtube = { broadcastId: String(yt.broadcastId), streamId: String(yt.streamId) };
    await store.saveJob(job);
    return c.json({ job }, 201);
  });

  app.post('/publishing/jobs/:id/stop', async (c) => {
    const { store, relay } = c.get('deps');
    const job = await store.getJob(c.req.param('id'));
    if (!job || job.ownerUserId !== c.get('user').userId) return err(c, 404, 'no_job', 'Job not found');
    const now = new Date().toISOString();
    if (job.state !== 'stopped' && job.state !== 'failed') {
      job.state = 'stopped';
      job.updatedAt = now;
      job.events.push({ at: now, state: 'stopped', note: 'Stopped by the publisher' });
      if (job.live && job.live.relay && job.live.relay !== 'off') job.live.relay = 'off';
      await store.saveJob(job);
    }
    await store.clearLiveSegments(job.jobId);
    if (relay && job.destinations.some((k) => RELAY_KINDS.includes(k))) await relayStop(relay, job.jobId); // ends the RTMP streams (ffmpeg closes them cleanly)
    return c.json({ job });
  });

  // One segment of the show from the publisher's browser: kept for the portal, handed to the RTMP relay
  // (YouTube at low latency, Facebook, Instagram, Twitch) when there is one, else to YouTube's HLS ingestion.
  // A Stop that lands while a segment is on its way (its body still arriving, or the relay's answer pending) wins:
  // the job as stored is read again after every wait, and a stopped one takes no more segments — else the segment's
  // handler would save its stale copy of the job as live again and the portal would stay on after the stop.
  const over = (j: PublishJob | null): boolean => !j || j.state === 'stopped' || j.state === 'failed' || j.state === 'stopping';
  app.put('/publishing/jobs/:id/live/:name', async (c) => {
    const deps = c.get('deps');
    const { store, secrets, youtubeHlsBase, relay } = deps;
    const found = await store.getJob(c.req.param('id'));
    if (!found || found.ownerUserId !== c.get('user').userId) return err(c, 404, 'no_job', 'Job not found');
    if (over(found)) return err(c, 409, 'not_live', `This broadcast is ${found.state}`);
    let job: PublishJob = found;
    const name = c.req.param('name');
    if (!SEGMENT_NAME.test(name)) return err(c, 400, 'bad_name', 'Segment names are letters, digits, - and _, ending in .ts');
    const seq = Math.floor(Number(c.req.query('seq')));
    const durationMs = Math.round(Number(c.req.query('dur')));
    if (!Number.isFinite(seq) || seq < 0 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10_000) return err(c, 400, 'bad_request', 'seq and dur (ms, up to 10000) are required');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > 6_000_000) return err(c, 400, 'too_big', 'A segment is a couple of seconds of video (up to 6 MB)');
    if (bytes[0] !== 0x47) return err(c, 400, 'not_ts', 'Not an MPEG-TS segment');
    // The body took its time: the job as it stands now carries on (a Stop meanwhile ends it here).
    const fresh = await store.getJob(job.jobId);
    if (!fresh || over(fresh)) return err(c, 409, 'not_live', `This broadcast is ${fresh?.state ?? 'gone'}`);
    job = fresh;
    const now = new Date().toISOString();
    const info: LiveSegmentInfo = { seq, name, durationMs, createdAt: now };
    await store.addLiveSegment(job.jobId, info, bytes);
    const live: PublishJobLive = job.live ?? { segments: 0, bytes: 0, lastSegmentAt: null, youtube: job.destinations.includes('youtube') ? 'waiting' : 'off', youtubeNote: '' };
    live.segments += 1;
    live.bytes += bytes.length;
    live.lastSegmentAt = now;
    live.audio = c.req.query('audio') !== '0';
    let youtube: (() => Promise<void>) | null = null;
    // The relay carries every RTMP destination of the job. A stream the relay no longer has (its first
    // segment, a relay that restarted, a stream closed for silence) is started again and the segment resent.
    const relayed = relay && job.destinations.some((k) => RELAY_KINDS.includes(k));
    if (relayed) {
      let r: RelayOutcome | null = live.relay === 'ok' ? await relaySegment(relay, job.jobId, bytes) : null;
      // 404 = the relay is up and has no such stream (restarted, or swept): start it again at once; anything else backs off.
      if (!r?.ok && (r?.status === 404 || Date.now() - (relayAttempts.get(job.jobId) ?? 0) > RELAY_RETRY_MS)) {
        relayAttempts.set(job.jobId, Date.now());
        if (await startRelay(deps, job, live, now)) r = await relaySegment(relay, job.jobId, bytes);
      }
      if (r) {
        live.relay = r.ok ? 'ok' : 'error';
        if (!r.ok) live.relayNote = relayNote(r);
      }
      if (job.destinations.includes('youtube')) {
        // YouTube rides the relay (RTMP, ultra-low latency): no HLS ingestion beside it.
        live.youtube = live.relay === 'ok' ? 'ok' : live.relay === 'starting' ? 'waiting' : 'error';
        live.youtubeNote = live.relay === 'ok' ? 'RTMP through the relay' : live.relayNote ?? '';
      }
    } else if (job.destinations.includes('youtube')) {
      const dest = await store.getDestination(job.ownerUserId, 'youtube');
      const key = dest?.keyEnc ? await secrets.open(dest.keyEnc).catch(() => '') : '';
      if (!key) {
        live.youtube = 'rejected';
        live.youtubeNote = 'No YouTube stream key is saved';
      } else {
        // YouTube gets the segment and the playlist after this answer went out: its two PUTs take a second or more, and the
        // show view's next segment (and the watch page behind it) must never wait on them. The verdict lands on the job
        // when it comes back and the next answer carries it.
        const window = youtubeWindow(await store.listLiveSegments(job.jobId));
        const playlist = hlsPlaylist(window, (n) => n);
        const jobId = job.jobId;
        youtube = async () => {
          const r = await sendToYoutube(youtubeHlsBase || YOUTUBE_HLS_INGEST, key, { name, bytes }, playlist);
          const verdict: PublishJobLive['youtube'] = r.status === 200 || r.status === 202 ? (r.playlistStatus === 200 || r.playlistStatus === 202 ? 'ok' : 'error') : r.status === 401 || r.status === 400 ? 'rejected' : 'error';
          await store.patchJobYoutube(jobId, verdict, r.note, r.status === 401 ? r.note : verdict === 'ok' ? null : undefined);
        };
      }
    }
    // A Stop that landed while the relay or YouTube was being asked wins: nothing of this segment is kept.
    if (over(await store.getJob(job.jobId))) {
      await store.clearLiveSegments(job.jobId);
      return err(c, 409, 'not_live', 'This broadcast is stopped');
    }
    job.live = live;
    if (job.state !== 'live') {
      job.state = 'live';
      job.events.push({ at: now, state: 'live', note: `On air — the show view is sending${job.destinations.includes('youtube') ? ` (YouTube: ${live.youtubeNote})` : ''}` });
    }
    job.updatedAt = now;
    await store.saveJob(job);
    if (youtube) {
      const work = youtube().catch((e) => console.warn('youtube forward', e));
      (deps.background ?? ((p) => void p))(work);
    }
    return c.json({ job });
  });

  app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));
  app.onError((e, c) => {
    console.error('sv-control error', e);
    const message = e instanceof Error ? e.message : String(e);
    // The answer carries the CORS headers whatever failed, and wherever it failed: a browser reads a 5xx with them
    // and tells the singer what is wrong; without them it can only say "unreachable".
    const origin = c.req.header('origin') ?? '';
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': c.req.path.startsWith('/watch/') ? '*' : originAllowed(origin, c.get('deps')?.allowedOrigins ?? []) ? origin : DEFAULT_ORIGINS[0]!, Vary: 'Origin' } : {};
    if (STORAGE_LIMIT.test(message)) {
      const retryAfterS = secondsToUtcMidnight();
      return c.json({ error: storageLimitNote(message, retryAfterS), code: 'storage_limit', retryAfterS }, 503, { ...cors, 'Retry-After': String(retryAfterS) });
    }
    return c.json({ error: message || 'Internal error', code: 'internal' }, 500, cors);
  });

  return app;
}

/** Periodic sweep: expire idle meets even when nobody is polling them. */
export async function sweepMeets(store: SqlStore): Promise<number> {
  let n = 0;
  for (const m of await store.listOpenMeets()) {
    ensureMeet(m);
    if (tick(m)) {
      await store.saveMeet(m); // a meet that expired is closed by this write (the store's onMeetClosed does the rest)
      n++;
    }
  }
  await store.flush().catch(() => undefined);
  return n;
}
