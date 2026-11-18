/** sv-control HTTP API shapes shared by the client and the server. All routes are JSON. */
import type { CatalogListResponse, CatalogPublishRequest, CatalogTrack } from './catalog.ts';
import type { ChatMessage, Meet, MeetPerformance, MeetRecording, MeetRole, MeetSignal, MeetSignalType, Participant, RegisterPerformanceRequest, SongPick, StagePolicy } from './meet.ts';
import type { MixBatch } from './mix.ts';
import type { AdminUserUpdate, AdminUsersResponse, Destination, DestinationKind, DestinationUpdate, LiveStatus, PublishJob, PublishJobRequest, UserRecord } from './publishing.ts';
import type { AdminBillingOverview, BillingSettings, ClubStatus, OrderRecord, PlanId, PlansResponse } from './plans.ts';
import type { PaymentRecord } from './roles.ts';
import type { AdminCouponsResponse, Coupon, CouponSettings } from './coupons.ts';
import type { RegisterTrackRequest, TrackAccessRequest, TrackCopyRequest, TrackHistoryResponse, TrackMetaPatch, TrackRecord, TrackSearchResponse } from './registry.ts';
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
  /** The coupon gate (coupons.ts): the code this account enters; the admin's list, the requirement, a coupon issued or changed (by email), one deleted. */
  'POST /coupon': { req: { code: string }; res: MeResponse };
  'GET /admin/coupons': { res: AdminCouponsResponse };
  'PUT /admin/coupons/settings': { req: Partial<CouponSettings>; res: { settings: CouponSettings } };
  'PUT /admin/coupons': { req: { email: string; code?: string; expiresAt: string; note?: string }; res: { coupon: Coupon } };
  'DELETE /admin/coupons/:email': { res: { ok: true } };
  /** The Plans page: the plans on offer, the currencies, where this account stands, its payments. */
  'GET /plans': { res: PlansResponse };
  /** Start a Stripe Checkout for a plan in a currency it is priced in: the page to send the browser to, and the order it opened. */
  'POST /plans/checkout': { req: { planId: PlanId; currency: string }; res: { url: string; orderId: string } };
  /** Back from Checkout: what became of it (paid, still processing — a bank's confirmation on its way —, failed, canceled, expired). */
  'GET /billing/session/:id': { res: { order: OrderRecord } };
  /** Open the Stripe Customer Portal (change card, cancel, invoices). */
  'POST /billing/portal': { req: Record<string, never>; res: { url: string } };
  /** A club owner's club: the members named (email addresses) who share the club's video hours; add one; remove one. */
  'GET /club': { res: ClubStatus };
  'POST /club/members': { req: { email: string }; res: ClubStatus };
  'DELETE /club/members/:email': { res: ClubStatus };
  /** Admin: put an account on a plan by email (a comp, a test, a payment taken elsewhere); `until` or the plan's own period. */
  'POST /admin/plan': { req: { email: string; plan: PlanId | 'publisher'; until?: string | null }; res: { user: UserRecord } };
  'GET /catalog/tracks': { res: CatalogListResponse };
  'GET /catalog/tracks/:id': { res: { track: CatalogTrack } };
  /** The track's file (json | audio | video), fetched from the owner's Drive by the service. */
  'GET /catalog/tracks/:id/file/:which': { res: never };
  'POST /catalog/tracks': { req: CatalogPublishRequest; res: { track: CatalogTrack } };
  'DELETE /catalog/tracks/:id': { res: { ok: true } };
  'POST /catalog/tracks/:id/pull': { res: { ok: true; pulls: number } };
  /** The master track database (registry.ts): what singers have sung, grouped by song, the latest sung first. */
  'GET /tracks/search': { res: TrackSearchResponse };
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
  /** `gone`: the addressee left the meet (no error — the sender just forgets the link). */
  'POST /meets/:id/signal': { req: SignalRequest; res: { seq: number; gone?: boolean } };
  'POST /meets/:id/signals': { req: { resumeToken: string; since: number }; res: { signals: MeetSignal[]; serverEpochMs: number } };
  'GET /ice': { res: { iceServers: IceServer[] } };
  'POST /meets/:id/leave': { req: { resumeToken: string }; res: { ok: true } };
  'POST /meets/:id/recordings': { req: RegisterRecordingRequest; res: { recording: MeetRecording } };
  /** The host registers a song's saved show; `shareWith` = the Google accounts of everyone else in the meet, for the host's Drive to share the folder with. */
  'POST /meets/:id/performances': { req: RegisterPerformanceRequest; res: { performance: MeetPerformance; shareWith: string[] } };
  /** Every saved show of every meet this account hosted or took part in. */
  'GET /performances': { res: { performances: MeetPerformance[] } };
  'DELETE /performances/:id': { res: { ok: true } };
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
