/**
 * Delivers the encoder's segments to the service, one after another, and keeps the publisher
 * informed: how many went out, the bitrate, what YouTube said. A segment that fails on the
 * service's side (5xx, no network) is retried a few times with a short back-off; a stale queue is
 * trimmed so the broadcast stays live rather than minutes behind; a job that is over (409) or a
 * sign-in that lapsed (401) ends the sending.
 */
import { signal } from '@preact/signals';
import type { PublishJob, PublishJobLive } from '@singersvoice/protocol';
import { api, ApiError } from '../lib/api.ts';
import type { LiveSegment } from './liveEncoder.ts';

const MAX_QUEUE = 4;
const RETRIES = 3;

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
  error: string | null;
  audio: boolean;
}

export class LiveSender {
  readonly state = signal<SenderState>({ state: 'idle', segments: 0, bytes: 0, kbps: 0, startedAt: 0, lastAt: 0, youtube: 'off', youtubeNote: '', error: null, audio: true });
  private queue: LiveSegment[] = [];
  private busy = false;
  private running = false;
  private recent: { at: number; bytes: number; ms: number }[] = [];
  /** The newest job as the service returned it (its `live` block carries YouTube's verdict). */
  job: PublishJob | null = null;

  constructor(private readonly jobId: string) {}

  start(): void {
    this.running = true;
    this.state.value = { ...this.state.value, state: 'sending', startedAt: Date.now(), error: null };
  }

  push(seg: LiveSegment): void {
    if (!this.running) return;
    this.queue.push(seg);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE); // stay live: drop what is already old
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.running && this.queue.length) {
        const seg = this.queue.shift()!;
        await this.send(seg);
      }
    } finally {
      this.busy = false;
    }
  }

  private async send(seg: LiveSegment): Promise<void> {
    for (let attempt = 0; attempt <= RETRIES && this.running; attempt++) {
      try {
        const r = await api.putBytes('PUT /publishing/jobs/:id/live/:name', `/publishing/jobs/${encodeURIComponent(this.jobId)}/live/${seg.name}?seq=${seg.seq}&dur=${seg.durationMs}&audio=${seg.audio ? 1 : 0}`, { bytes: seg.bytes, contentType: 'video/MP2T' });
        this.job = r.job;
        const now = Date.now();
        this.recent.push({ at: now, bytes: seg.bytes.length, ms: seg.durationMs });
        this.recent = this.recent.filter((x) => now - x.at < 12_000);
        const sumMs = this.recent.reduce((n, x) => n + x.ms, 0);
        const sumBytes = this.recent.reduce((n, x) => n + x.bytes, 0);
        const s = this.state.value;
        this.state.value = {
          ...s,
          state: 'live',
          segments: s.segments + 1,
          bytes: s.bytes + seg.bytes.length,
          kbps: sumMs ? Math.round((sumBytes * 8) / sumMs) : 0,
          lastAt: now,
          youtube: r.job.live?.youtube ?? 'off',
          youtubeNote: r.job.live?.youtubeNote ?? '',
          error: r.job.error,
          audio: seg.audio,
        };
        return;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
          this.end('ended', e.message); // the job is over on the service's side
          return;
        }
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          this.end('error', e.message);
          return;
        }
        if (e instanceof ApiError && e.status === 400) {
          console.warn('segment refused', e.message); // this one segment: skip it
          return;
        }
        if (attempt === RETRIES) {
          this.state.value = { ...this.state.value, error: `Could not deliver a segment (${e instanceof Error ? e.message : String(e)})` };
          return;
        }
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
  }

  private end(state: 'ended' | 'error', message: string): void {
    this.running = false;
    this.queue = [];
    this.state.value = { ...this.state.value, state, error: state === 'error' ? message : this.state.value.error };
  }

  stop(): void {
    this.running = false;
    this.queue = [];
    if (this.state.value.state !== 'error') this.state.value = { ...this.state.value, state: 'ended' };
  }
}
