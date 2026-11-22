/** sv-control HTTP API shapes shared by the client and the server. All routes are JSON. */
import type { CatalogListResponse, CatalogPublishRequest, CatalogTrack } from './catalog.ts';
import type { InviteRequest, JoinInvite } from './join.ts';
import type { ChatMessage, LinkSummary, Meet, MeetPerformance, MeetRecording, MeetRole, MeetSignal, MeetSignalType, Participant, RegisterPerformanceRequest, SongPick, StagePolicy, TvSignal } from './meet.ts';
import type { MixBatch } from './mix.ts';
import type { AdminUserUpdate, AdminUsersResponse, Destination, DestinationKind, DestinationUpdate, LiveStatus, PublishJob, PublishJobRequest, UserRecord } from './publishing.ts';
import type { AdminBillingOverview, BillingSettings, ClubStatus, OrderRecord, PlanId, PlansResponse } from './plans.ts';
import type { PaymentRecord } from './roles.ts';
import type { AdminCouponsResponse, Coupon, CouponSettings } from './coupons.ts';
import type { PlanOffer, PlanOfferInput, PromoCode, PromoCodeInput, PromoPreview } from './offers.ts';
import type { AdminSocialStatus, AdminSocialUpdate, SocialNetwork, SocialPost, SocialStatus } from './social.ts';
import type { RegisterTrackRequest, TrackAccessRequest, TrackCopyRequest, TrackHistoryResponse, TrackMetaPatch, TrackRecord, TrackSearchResponse } from './registry.ts';
import type { Bookmark, BookmarkInput, SongPrefs, StageBookmark } from './prefs.ts';
import type { YtFetchRequest, YtJob, YtSearchResponse, YtStatus } from './ytTracks.ts';

export interface ApiError {
  error: string;
  code: string;
}

export interface HealthResponse {
  ok: true;
  service: 'sv-control';
  version: string;
  runtime: 'node' | 'cloudflare';
  now: number;
  /**
   * The storage as it stands: rows read and written since the service (or its Durable Object) started, and
   * whether writes go through right now — a SQLite-backed Durable Object on the free plan may write 100,000
   * rows a day; past that every write fails until 00:00 UTC, and `writes` says 'failing' with the runtime's
   * own words in `note`. What the live layer holds (open meets, their people, streams) rides along.
   */
  storage?: {
    rowsRead: number;
    rowsWritten: number;
    statements: number;
    since: string;
    writes: 'ok' | 'failing';
    note: string;
    live: { meets: number; participants: number; signals: number; mixStreams: number; jobs: number; segmentBytes: number; listening: number };
  };
}

export interface TimeResponse {
  serverEpochMs: number;
}

export interface MeResponse {
  user: UserRecord;
}

export interface CreateMeetRequest {
  title: string;
  trackId?: string | null;
  trackTitle?: string;
  catalogTrackId?: string | null;
  backgroundId?: string;
  /** A club owner's meet: members only (the default for a club owner), or open to anyone with the link. */
  membersOnly?: boolean;
}

/** Someone a singer blocked (`GET /blocks`): they can never get into the singer's meets. */
export interface BlockedUser {
  userId: string;
  svNo: number;
  name: string;
  picture: string;
  email: string;
  blockedAt: string;
}

export interface JoinMeetRequest {
  /** 'publisher' (privileged only) gets its own participant even when the same account performs on another device. */
  role: 'performer' | 'audience' | 'publisher';
  resumeToken?: string;
}

export interface JoinMeetResponse {
  meet: Meet;
  you: Participant;
  resumeToken: string;
  serverEpochMs: number;
}

export interface HeartbeatRequest {
  resumeToken: string;
  /** Last chat seq seen, to receive only newer messages. */
  chatSince?: number;
  driftMs?: number | null;
  rttMs?: number | null;
  /** What this device's links to the other singers carry (meet.ts LinkSummary): kept in memory for the host's view, never a row. */
  links?: LinkSummary | null;
}

export interface MeetSnapshot {
  meet: Meet;
  /**
   * The people the room shows by name: everyone on stage, the host, the publishers, the wait list and
   * the first dozen of the audience. The size of the audience is `meet.audienceCount` — a poll stays
   * small however large the audience.
   */
  participants: Participant[];
  chat: ChatMessage[];
  recordings: MeetRecording[];
  /** The saved shows of this meet (one per song, recorded on the host's device, shared with everyone in it). */
  performances: MeetPerformance[];
  serverEpochMs: number;
  you?: Participant;
  /** On a heartbeat: the video hours left to this account this month (null = without limit), and why the picture is off when it is (plans.ts): the role, the plan, or the hours used up. */
  yourVideo?: { leftSeconds: number | null; note: string; reason: '' | 'role' | 'plan' | 'hours' };
  /** Somebody is hearing the stage mix right now (a listener's stream or poll): the host's device sends it only then. */
  mixListening?: boolean;
}

/**
 * The room as the event stream hands it to every device the moment something changed (`room` event): the
 * snapshot without what is a device's own (its chat position, its video hours). `participants` is the host's
 * whole list on the host's stream and the named few on everyone else's (see MeetSnapshot).
 */
export interface RoomUpdate {
  meet: Meet;
  participants: Participant[];
  recordings: MeetRecording[];
  performances: MeetPerformance[];
  serverEpochMs: number;
  mixListening: boolean;
}

export interface DecideRequest {
  resumeToken: string;
  allow: boolean;
  /** Which slot to seat them in (the first free one when omitted). */
  slot?: number;
}

export interface SlotRequest {
  resumeToken: string;
  slot: number | null;
}

export interface ReadyRequest {
  resumeToken: string;
  ready: boolean;
}

export interface ChatRequest {
  resumeToken: string;
  text: string;
}

export interface StartMeetRequest {
  resumeToken: string;
  leadMs: number;
}

export interface PlaybackRequest {
  resumeToken: string;
  /** resume/restart/seek: shared lead before the new kickstart (ms). */
  leadMs?: number;
  /** restart: position to restart from (ms), default 0. */
  fromMs?: number;
  /** seek: the position to jump to (ms) — cued while playing (everyone jumps at the same instant), immediate while paused. */
  toMs?: number;
}

export interface SignalRequest {
  resumeToken: string;
  to: string;
  type: MeetSignalType;
  data: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RegisterRecordingRequest {
  /** Optional: a take registers after the song, by account, even once the singer left the room. */
  resumeToken?: string;
  performanceId: string;
  driveFolderLink: string | null;
  durationMs: number;
  slot?: number | null;
}

export interface WatchResponse {
  meet: Pick<Meet, 'meetId' | 'title' | 'hostName' | 'trackTitle' | 'catalogTrackId' | 'state' | 'backgroundId' | 'stage' | 'audienceCount' | 'kickstartEpochMs' | 'streamUrl' | 'expiresAt'>;
  chat: ChatMessage[];
  serverEpochMs: number;
}

/** Route table, for reference and for the typed client. */
export interface Routes {
  'GET /health': { res: HealthResponse };
  'GET /time': { res: TimeResponse };
  'GET /me': { res: MeResponse };
  /** The singer's own details: the phone (optional; '' clears it). */
  'PATCH /me': { req: { phone?: string }; res: MeResponse };
  /** Who the singer blocked (none of them can get into the singer's meets); block by SingersVoice number or email; unblock. */
  'GET /blocks': { res: { blocks: BlockedUser[] } };
  'PUT /blocks': { req: { svNo?: number; email?: string; userId?: string }; res: { blocks: BlockedUser[]; blocked: BlockedUser } };
  'DELETE /blocks/:userId': { res: { blocks: BlockedUser[] } };
  /** The host removes someone from the meet and blocks them from every meet of theirs, for good. */
  'POST /meets/:id/participants/:pid/block': { req: { resumeToken: string }; res: MeetSnapshot };
  /** The club owner's switch on their meet: members only, or open. */
  'POST /meets/:id/club': { req: { resumeToken: string; membersOnly: boolean }; res: MeetSnapshot };
  /** The coupon gate (coupons.ts): the code this account enters; the admin's list, the requirement, a coupon issued or changed (by email), one deleted. */
  'POST /coupon': { req: { code: string }; res: MeResponse };
  'GET /admin/coupons': { res: AdminCouponsResponse };
  'PUT /admin/coupons/settings': { req: Partial<CouponSettings>; res: { settings: CouponSettings } };
  'PUT /admin/coupons': { req: { email: string; code?: string; expiresAt: string; note?: string }; res: { coupon: Coupon } };
  'DELETE /admin/coupons/:email': { res: { ok: true } };
  /** The Plans page: the plans on offer, the currencies, where this account stands, its payments. */
  'GET /plans': { res: PlansResponse };
  /** Start a Stripe Checkout for a plan in a currency it is priced in: the page to send the browser to, and the order it opened. */
  /** `appUrl`: where this app lives (origin + base path) — Stripe sends the singer back there; the service takes it only from an allowed origin. */
  /** `offerId`: one of the plan's offers on sale (none = the plan's own price); `promo`: a code on the payment. A fee-void code opens the plan at once: `url` is then the Plans page itself and `granted` true. */
  'POST /plans/checkout': { req: { planId: PlanId; currency: string; appUrl?: string; offerId?: string | null; promo?: string }; res: { url: string; orderId: string; granted?: boolean } };
  /** A promo code looked at before paying: what it gives (404 `bad_promo` with the reason when it cannot be used). */
  'GET /plans/promo/:code': { res: { promo: PromoPreview } };
  /** Back from Checkout: what became of it (paid, still processing — a bank's confirmation on its way —, failed, canceled, expired). */
  'GET /billing/session/:id': { res: { order: OrderRecord } };
  /** Open the Stripe Customer Portal (change card, cancel, invoices). */
  'POST /billing/portal': { req: { appUrl?: string }; res: { url: string } };
  /** A club owner's club: the members named (email addresses) who share the club's video hours; add one; remove one. */
  'GET /club': { res: ClubStatus };
  'POST /club/members': { req: { email: string }; res: ClubStatus };
  'DELETE /club/members/:email': { res: ClubStatus };
  /** Admin: put an account on a plan by email (a comp, a test, a payment taken elsewhere); `until` or the plan's own period. */
  'POST /admin/plan': { req: { email: string; plan: PlanId | 'publisher'; until?: string | null }; res: { user: UserRecord } };
  /** The public catalog searched; `languages=Hindi,Telugu` keeps to the entries in those languages (prefs.ts). */
  'GET /catalog/tracks': { res: CatalogListResponse };
  'GET /catalog/tracks/:id': { res: { track: CatalogTrack } };
  /** The track's file (json | audio | video), fetched from the owner's Drive by the service. */
  'GET /catalog/tracks/:id/file/:which': { res: never };
  'POST /catalog/tracks': { req: CatalogPublishRequest; res: { track: CatalogTrack } };
  'DELETE /catalog/tracks/:id': { res: { ok: true } };
  'POST /catalog/tracks/:id/pull': { res: { ok: true; pulls: number } };
  /** The master track database (registry.ts): what singers have sung, grouped by song, the latest sung first. */
  'GET /tracks/search': { res: TrackSearchResponse };
  /** Recommendations (prefs.ts): the songs in the given languages (`languages=Hindi,Telugu`), the most sung first — grouped as a search is. */
  'GET /tracks/recommended': { res: TrackSearchResponse };
  /** Songs I prefer (prefs.ts): the languages and countries kept on my account; replaced whole. */
  'GET /prefs': { res: { prefs: SongPrefs } };
  'PUT /prefs': { req: SongPrefs; res: { prefs: SongPrefs } };
  /** My bookmarks (prefs.ts), the latest first; one kept or replaced by its key (`<kind>:<ref>`); one dropped. */
  'GET /bookmarks': { res: { items: Bookmark[] } };
  'PUT /bookmarks/:key': { req: BookmarkInput; res: { bookmark: Bookmark } };
  'DELETE /bookmarks/:key': { res: { ok: true } };
  /** The bookmarks of every singer on the meet's stage, each saying whose it is — for anyone in the meet. */
  'GET /meets/:id/bookmarks': { res: { items: StageBookmark[] } };
  /** My own history: what I sang, the latest first. */
  'GET /tracks/history': { res: TrackHistoryResponse };
  'GET /tracks/:id': { res: { track: TrackRecord } };
  /** The track's file (json | audio | video) from the owner's shared Drive, or from any singer's shared copy when the owner's is gone. */
  'GET /tracks/:id/file/:which': { res: never };
  /** Register a track (one record per source; a second registration of the same source answers the first record). */
  'POST /tracks/register': { req: RegisterTrackRequest; res: { track: TrackRecord; created: boolean } };
  /** A successful access: the global last-accessed instant and my own history move to now. */
  'POST /tracks/:id/access': { req: TrackAccessRequest; res: { track: TrackRecord } };
  /** My copy of the track in my own Drive (shared): one more place its files can be fetched from. */
  'POST /tracks/:id/copies': { req: TrackCopyRequest; res: { track: TrackRecord } };
  /** The owner (or a super admin) corrects the metadata. */
  'PATCH /tracks/:id': { req: TrackMetaPatch; res: { track: TrackRecord } };
  /** The Admin page (super admins): every account; one account's role and subscription changed. */
  'GET /admin/users': { res: AdminUsersResponse };
  /** The super admin's billing portal: the plans and their prices, every subscriber by standing, the payments and the open orders; the settings changed; a payment refunded through Stripe. */
  'GET /admin/billing': { res: AdminBillingOverview };
  'PUT /admin/billing/settings': { req: Partial<BillingSettings>; res: { settings: BillingSettings } };
  'POST /admin/payments/:id/refund': { req: { amountCents?: number }; res: { payment: PaymentRecord } };
  /** Social (social.ts): what can be connected and what is; a sign-in started (the network's page to send the browser to); a Page picked after a Meta sign-in; a network disconnected. */
  'GET /social': { res: SocialStatus };
  'POST /social/:provider/connect': { req: { appUrl?: string }; res: { url: string } };
  'POST /social/meta/page': { req: { pageId: string }; res: SocialStatus };
  'DELETE /social/:network': { res: SocialStatus };
  /** A clip posted to a connected network: a multipart form — the file as `clip`, and these fields; the post as it stands (posted, or processing: poll it). */
  'POST /social/posts': { req: { network: SocialNetwork; text: string; title: string; performanceId?: string; clipMs: number }; res: { post: SocialPost } };
  'GET /social/posts/:id': { res: { post: SocialPost } };
  'GET /social/posts': { res: { posts: SocialPost[] } };
  /** How SingersVoice is registered with X and Meta (social.ts): the ids and secrets the super admin pastes on the Admin page; the callbacks to give the networks. */
  'GET /admin/social': { res: AdminSocialStatus };
  'PUT /admin/social': { req: AdminSocialUpdate; res: AdminSocialStatus };
  /** The offers (the ways to pay for a plan) and the promo codes, kept by the super admin (offers.ts). */
  'POST /admin/offers': { req: PlanOfferInput; res: { offer: PlanOffer } };
  'PATCH /admin/offers/:id': { req: PlanOfferInput; res: { offer: PlanOffer } };
  'DELETE /admin/offers/:id': { res: { ok: true } };
  'POST /admin/promos': { req: PromoCodeInput; res: { promo: PromoCode } };
  'PATCH /admin/promos/:code': { req: PromoCodeInput; res: { promo: PromoCode } };
  'DELETE /admin/promos/:code': { res: { ok: true } };
  'PATCH /admin/users/:id': { req: AdminUserUpdate; res: { user: UserRecord } };
  /** YouTube song tracks (through the relay, docs/RELAY.md): can the service fetch them; search; fetch one into my Drive; the job as it goes. */
  'GET /yt': { res: YtStatus };
  'GET /yt/search': { res: YtSearchResponse };
  'POST /yt/fetch': { req: YtFetchRequest; res: { job: YtJob } };
  'GET /yt/jobs/:id': { res: { job: YtJob } };
  'GET /meets': { res: { meets: Meet[] } };
  'POST /meets': { req: CreateMeetRequest; res: { meet: Meet } };
  'GET /meets/:id': { res: MeetSnapshot };
  /** Host maintenance from the meets list (by account, no participant token): end an open meet; delete one for good. */
  'POST /meets/:id/end': { res: { meet: Meet } };
  'DELETE /meets/:id': { res: { ok: true } };
  'GET /meets/code/:code': { res: { meet: Meet } };
  'POST /meets/:id/join': { req: JoinMeetRequest; res: JoinMeetResponse };
  'POST /meets/:id/heartbeat': { req: HeartbeatRequest; res: MeetSnapshot };
  'POST /meets/:id/slot': { req: SlotRequest; res: MeetSnapshot };
  /** Audience → "ask to sing"; host decides; host may clear a slot or change who can step on stage. */
  'POST /meets/:id/requests': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/requests/withdraw': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/requests/:pid/decide': { req: DecideRequest; res: MeetSnapshot };
  'POST /meets/:id/stage/:pid/remove': { req: { resumeToken: string }; res: MeetSnapshot };
  /** The host removes someone from the meet altogether (stage or audience); they cannot come back in. */
  'POST /meets/:id/participants/:pid/kick': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/policy': { req: { resumeToken: string; stagePolicy: StagePolicy }; res: MeetSnapshot };
  /** The stage background — any singer on stage (or the host) switches it, mid-song too; every device and the show follow at the next poll. */
  'POST /meets/:id/background': { req: { resumeToken: string; backgroundId: string }; res: MeetSnapshot };
  /**
   * The song of the stage: anyone on stage picks (nothing up → it is up; a song up → it is put forward and the stage
   * chooses), chooses one of the songs put forward ('current' keeps the one up; the rest are dropped), withdraws one,
   * or ends / skips the current song (`songs/next`). The answer carries `X-Song-Duplicate: current | proposed` when the
   * pick was there already and nothing was added.
   */
  'POST /meets/:id/songs': { req: { resumeToken: string; song: SongPick }; res: MeetSnapshot };
  'POST /meets/:id/songs/next': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/songs/:sid': { req: { resumeToken: string; action: 'remove' | 'choose' }; res: MeetSnapshot };
  'POST /meets/:id/ready': { req: ReadyRequest; res: MeetSnapshot };
  'POST /meets/:id/chat': { req: ChatRequest; res: { message: ChatMessage } };
  'POST /meets/:id/start': { req: StartMeetRequest; res: MeetSnapshot };
  'POST /meets/:id/stop': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/pause': { req: PlaybackRequest; res: MeetSnapshot };
  'POST /meets/:id/resume': { req: PlaybackRequest; res: MeetSnapshot };
  'POST /meets/:id/restart': { req: PlaybackRequest; res: MeetSnapshot };
  'POST /meets/:id/seek': { req: PlaybackRequest; res: MeetSnapshot };
  /** The host posts a second of the stage mix; everyone else in the meet (and the watch page) fetches what came after `since`. */
  'POST /meets/:id/mix': { req: MixBatch & { resumeToken?: string }; res: { ok: true; seq: number } };
  'GET /meets/:id/mix': { res: { batches: MixBatch[]; latest: number; serverEpochMs: number } };
  'GET /watch/:id/mix': { res: { batches: MixBatch[]; latest: number; serverEpochMs: number } };
  /** The mix as a stream (SSE): a `batch` event per batch from `since` on, a `ping` every so often; one request for the whole listen. */
  'GET /watch/:id/mix/stream': { res: never };
  /** The device is going (a beacon on the way out, `?rt=` the resume token — no sign-in, as the stream): heard from within seconds it stays on its slot (a reload); otherwise the slot is cleared then, not a minute later. */
  'POST /meets/:id/away': { req: { resumeToken?: string }; res: { ok: true } };
  /** `gone`: the addressee left the meet (no error — the sender just forgets the link). */
  'POST /meets/:id/signal': { req: SignalRequest; res: { seq: number; gone?: boolean } };
  'POST /meets/:id/signals': { req: { resumeToken: string; since: number }; res: { signals: MeetSignal[]; serverEpochMs: number } };
  /** STUN, and TURN where the deployment has it (`turn`: credentials minted for the meet's length, good until `expiresAt`). */
  'GET /ice': { res: { iceServers: IceServer[]; turn?: boolean; expiresAt?: string } };
  /** TV screens (services/control/src/tv.ts): the TV registers a code (no sign-in); the singer claims it; the two trade WebRTC signals through the service. */
  'POST /tv/screens': { res: { code: string; token: string } };
  'POST /tv/screens/:code/claim': { res: { code: string; phoneToken: string } };
  'POST /tv/screens/:code/release': { res: { ok: true } };
  'POST /tv/screens/:code/signal': { req: TvSignal; res: { delivered: boolean } };
  'POST /meets/:id/leave': { req: { resumeToken: string }; res: { ok: true } };
  'POST /meets/:id/recordings': { req: RegisterRecordingRequest; res: { recording: MeetRecording } };
  /** The host registers a song's saved show; `shareWith` = the Google accounts of everyone else in the meet, for the host's Drive to share the folder with. */
  'POST /meets/:id/performances': { req: RegisterPerformanceRequest; res: { performance: MeetPerformance; shareWith: string[] } };
  /** Every saved show of every meet this account hosted or took part in. */
  'GET /performances': { res: { performances: MeetPerformance[] } };
  'DELETE /performances/:id': { res: { ok: true } };
  /** Joining (join.ts): open one of my performances for others to join (again: the record is replaced), read one by its id, its files through the service, stop it. */
  'PUT /performances/:id/invite': { req: InviteRequest; res: { invite: JoinInvite } };
  'GET /performances/:id/invite': { res: { invite: JoinInvite } };
  'GET /performances/:id/invite/file/:which': { res: never };
  'DELETE /performances/:id/invite': { res: { ok: true } };
  /** The performances I opened for joining, and the ones that joined any of mine. */
  'GET /performances/invites': { res: { mine: JoinInvite[]; joined: JoinInvite[] } };
  'GET /watch/:id': { res: WatchResponse };
  /** `relay`: the RTMP relay is deployed — Facebook, Instagram and Twitch go live, and YouTube at low latency. */
  'GET /publishing/destinations': { res: { destinations: Destination[]; relay: boolean } };
  'PUT /publishing/destinations/:kind': { req: DestinationUpdate; res: { destination: Destination } };
  'GET /publishing/jobs': { res: { jobs: PublishJob[] } };
  'POST /publishing/jobs': { req: PublishJobRequest; res: { job: PublishJob } };
  'POST /publishing/jobs/:id/stop': { res: { job: PublishJob } };
  /** The publisher's browser delivers one MPEG-TS segment (raw body, `?seq=&dur=` ms); the service keeps it for the portal and forwards it to YouTube. */
  'PUT /publishing/jobs/:id/live/:name': { res: { job: PublishJob; youtube: { status: number } | null } };
  /** Public: whether the show is on and where its HLS playlist is (`/watch/:id/live.m3u8`, segments at `/watch/:id/live/<name>`). */
  'GET /watch/:id/live': { res: LiveStatus };
}

export type { MeetRole, DestinationKind };
