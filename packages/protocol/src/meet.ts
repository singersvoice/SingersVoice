/** Live meets: up to 10 performers on stage, unlimited audience with chat. */
export const MAX_PERFORMERS = 10;

export type MeetRole = 'host' | 'performer' | 'audience';
export type MeetState = 'lobby' | 'countdown' | 'live' | 'ended';

export interface StageSlot {
  slot: number; // 1..10
  userId: string | null;
  displayName: string;
  ready: boolean;
  muted: boolean;
  cameraOn: boolean;
}

export interface Meet {
  meetId: string;
  title: string;
  hostId: string;
  trackId: string;
  trackTitle: string;
  state: MeetState;
  backgroundId: string;
  stage: StageSlot[];
  audienceCount: number;
  createdAt: string;
  /** Shared instant the backing track starts, ms since epoch (the "GMT kickstart"). */
  kickstartEpochMs: number | null;
  /** Public stream (LL-HLS or YouTube embed) for the audience. */
  streamUrl: string | null;
}

export interface ChatMessage {
  id: string;
  meetId: string;
  userId: string;
  displayName: string;
  text: string;
  sentAt: string;
}

/** Client → control plane. */
export type ClientMessage =
  | { t: 'hello'; meetId: string; token: string; role: MeetRole; resumeToken?: string }
  | { t: 'ping'; sentAt: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'claimSlot'; slot: number }
  | { t: 'leaveSlot' }
  | { t: 'chat'; text: string }
  | { t: 'host.setTrack'; trackId: string }
  | { t: 'host.setBackground'; backgroundId: string }
  | { t: 'host.start'; leadMs: number }
  | { t: 'host.stop' }
  | { t: 'perf.clockReport'; driftMs: number; rttMs: number };

/** Control plane → client. */
export type ServerMessage =
  | { t: 'welcome'; meet: Meet; you: { userId: string; role: MeetRole; slot: number | null }; resumeToken: string; serverEpochMs: number }
  | { t: 'pong'; sentAt: number; serverEpochMs: number }
  | { t: 'meet'; meet: Meet }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'kickstart'; kickstartEpochMs: number; trackId: string }
  | { t: 'stop'; reason: 'host' | 'ended' | 'error' }
  | { t: 'error'; code: string; message: string };

/** NTP-style clock offset from a ping/pong pair. */
export function clockOffsetMs(sentAt: number, serverEpochMs: number, receivedAt: number): { offsetMs: number; rttMs: number } {
  const rttMs = receivedAt - sentAt;
  const offsetMs = serverEpochMs - (sentAt + rttMs / 2);
  return { offsetMs, rttMs };
}

export function emptyStage(): StageSlot[] {
  return Array.from({ length: MAX_PERFORMERS }, (_, i) => ({
    slot: i + 1,
    userId: null,
    displayName: '',
    ready: false,
    muted: false,
    cameraOn: true,
  }));
}
