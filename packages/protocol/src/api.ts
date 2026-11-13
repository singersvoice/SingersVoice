/** sv-control HTTP API shapes shared by the client and the server. All routes are JSON. */
import type { CatalogListResponse, CatalogPublishRequest, CatalogTrack } from './catalog.ts';
import type { ChatMessage, Meet, MeetPerformance, MeetRecording, MeetRole, MeetSignal, MeetSignalType, Participant, RegisterPerformanceRequest, SongPick, StagePolicy } from './meet.ts';
import type { MixBatch } from './mix.ts';
import type { Destination, DestinationKind, DestinationUpdate, LiveStatus, PublishJob, PublishJobRequest, UserRecord } from './publishing.ts';

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
  participants: Participant[];
  chat: ChatMessage[];
  recordings: MeetRecording[];
  /** The saved shows of this meet (one per song, recorded on the host's device, shared with everyone in it). */
  performances: MeetPerformance[];
  serverEpochMs: number;
  you?: Participant;
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
  'GET /catalog/tracks': { res: CatalogListResponse };
  'GET /catalog/tracks/:id': { res: { track: CatalogTrack } };
  'POST /catalog/tracks': { req: CatalogPublishRequest; res: { track: CatalogTrack } };
  'DELETE /catalog/tracks/:id': { res: { ok: true } };
  'POST /catalog/tracks/:id/pull': { res: { ok: true; pulls: number } };
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
  'POST /meets/:id/policy': { req: { resumeToken: string; stagePolicy: StagePolicy }; res: MeetSnapshot };
  /** The set list (karaoke queue): anyone on stage adds a song; the host orders it, plays one now, or ends the current song. */
  'POST /meets/:id/songs': { req: { resumeToken: string; song: SongPick; now?: boolean }; res: MeetSnapshot };
  'POST /meets/:id/songs/next': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/songs/:sid': { req: { resumeToken: string; action: 'remove' | 'up' | 'now' }; res: MeetSnapshot };
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
  'GET /publishing/destinations': { res: { destinations: Destination[] } };
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
