/** sv-control HTTP API shapes shared by the client and the server. All routes are JSON. */
import type { CatalogListResponse, CatalogPublishRequest, CatalogTrack } from './catalog.ts';
import type { ChatMessage, Meet, MeetRecording, MeetRole, Participant } from './meet.ts';
import type { Destination, DestinationKind, DestinationUpdate, PublishJob, PublishJobRequest, UserRecord } from './publishing.ts';

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
  role: 'performer' | 'audience';
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
  serverEpochMs: number;
  you?: Participant;
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

export interface RegisterRecordingRequest {
  resumeToken: string;
  performanceId: string;
  driveFolderLink: string | null;
  durationMs: number;
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
  'GET /meets/code/:code': { res: { meet: Meet } };
  'POST /meets/:id/join': { req: JoinMeetRequest; res: JoinMeetResponse };
  'POST /meets/:id/heartbeat': { req: HeartbeatRequest; res: MeetSnapshot };
  'POST /meets/:id/slot': { req: SlotRequest; res: MeetSnapshot };
  'POST /meets/:id/ready': { req: ReadyRequest; res: MeetSnapshot };
  'POST /meets/:id/chat': { req: ChatRequest; res: { message: ChatMessage } };
  'POST /meets/:id/start': { req: StartMeetRequest; res: MeetSnapshot };
  'POST /meets/:id/stop': { req: { resumeToken: string }; res: MeetSnapshot };
  'POST /meets/:id/leave': { req: { resumeToken: string }; res: { ok: true } };
  'POST /meets/:id/recordings': { req: RegisterRecordingRequest; res: { recording: MeetRecording } };
  'GET /watch/:id': { res: WatchResponse };
  'GET /publishing/destinations': { res: { destinations: Destination[] } };
  'PUT /publishing/destinations/:kind': { req: DestinationUpdate; res: { destination: Destination } };
  'GET /publishing/jobs': { res: { jobs: PublishJob[] } };
  'POST /publishing/jobs': { req: PublishJobRequest; res: { job: PublishJob } };
  'POST /publishing/jobs/:id/stop': { res: { job: PublishJob } };
}

export type { MeetRole, DestinationKind };
