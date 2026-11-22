/**
 * What the publisher is told of the broadcast's delivery: how many segments went out, the bitrate, what YouTube
 * and the RTMP relay said of the last one — kept by the Worker that sends (live.worker.ts) and mirrored on the
 * page (liveEncoder.ts → broadcast.ts → the show view's chrome).
 */
import type { PublishJob, PublishJobLive } from '@singersvoice/protocol';

export interface SenderState {
  state: 'idle' | 'sending' | 'live' | 'ended' | 'error';
  segments: number;
  bytes: number;
  /** Average over the last few segments. */
  kbps: number;
  startedAt: number;
  lastAt: number;
  youtube: PublishJobLive['youtube'];
  youtubeNote: string;
  /** The RTMP relay's verdict on the last segment (off = this job has no RTMP destination, or no relay is deployed). */
  relay: NonNullable<PublishJobLive['relay']>;
  relayNote: string;
  error: string | null;
  audio: boolean;
}

export const initialSenderState = (): SenderState => ({ state: 'idle', segments: 0, bytes: 0, kbps: 0, startedAt: 0, lastAt: 0, youtube: 'off', youtubeNote: '', relay: 'off', relayNote: '', error: null, audio: true });

/** The service's answer to a segment (the job as it stands) folded into the state: YouTube's and the relay's word, the job's error. */
export function foldJob(state: SenderState, job: Pick<PublishJob, 'live' | 'error'> | null): SenderState {
  if (!job) return state;
  return { ...state, youtube: job.live?.youtube ?? 'off', youtubeNote: job.live?.youtubeNote ?? '', relay: job.live?.relay ?? 'off', relayNote: job.live?.relayNote ?? '', error: job.error };
}
