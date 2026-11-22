/**
 * The live layer of the store: what a running meet does every few seconds — heartbeats, clock reports,
 * WebRTC signals, the audience mix, a broadcast's segments, the seconds of video on stage — lives here,
 * in memory, and SQLite sees only what is worth keeping: a state transition (a slot taken, a song picked,
 * the kickstart, a stop), a participant's record (a join, a leave, a role), and once a minute the idle
 * expiry of each open meet. On Cloudflare the whole service is one Durable Object, so this memory is the
 * truth for every device of every meet; on Node one process serves everything, the same.
 *
 * Why: a SQLite-backed Durable Object counts every row it writes (an index entry is a row too), and the
 * free plan allows 100,000 a day. Seven singers heart-beating every three seconds with the meet row
 * rewritten behind each one, a mix batch inserted and another deleted every second, three rows for every
 * two-second segment of a broadcast: a two-hour meet used the day up, every write then failed with
 * "Exceeded allowed rows written", and the meet died mid-song. Now a two-hour meet of ten singers is a
 * few hundred rows.
 *
 * What a restart costs (the object evicted between meets, a deploy mid-meet): presence and the expiry
 * are recovered by grace — a meet whose stored expiry is within SOFT_FLUSH_MS of the truth is still open,
 * and every participant of an open meet is "seen now" at load and has the usual minute to be heard from
 * again; a few seconds of the audience mix, the broadcast's last segments and up to a minute of video
 * seconds are lost, nothing else.
 */
import { LIVE_KEEP, MIX_KEEP, meetIsOpen, type LiveSegmentInfo, type Meet, type MeetPerformance, type MeetRecording, type MeetSignal, type MixBatch, type PublishJob } from '@singersvoice/protocol';
import type { StoredParticipant } from './sql.ts';

/** The idle expiry of an open meet is written at most this often while heartbeats keep extending it (the stored value is at most this stale). */
export const SOFT_FLUSH_MS = 60_000;
/** Video seconds are counted in memory and written once this many have gathered per pool (or at a flush). */
export const VIDEO_FLUSH_SECONDS = 60;
/**
 * Signals kept per meet: a mesh of ten forming is ninety links of a dozen or more signals each (over a thousand), and a
 * stage re-making its links under strain sends as many again; one older than SIGNAL_TTL_MS is never wanted (a link
 * whose answer is that late was re-made with a new name long ago — peers.ts OFFER_TIMEOUT_MS, STUCK_AFTER_MS).
 */
export const SIGNALS_KEEP = 3000;
export const SIGNAL_TTL_MS = 120_000;
/** A mix poll within this long counts as somebody listening (the host's device sends the mix only then). */
export const LISTENER_RECENT_MS = 15_000;

/** The durable projection of a meet: everything but what presence and heartbeats keep moving. */
export function meetDurableKey(m: Meet): string {
  const { lastActivityAt: _a, expiresAt: _e, audienceCount: _ac, performerCount: _pc, stage, ...rest } = m;
  return JSON.stringify({ ...rest, stage: stage.map(({ driftMs: _d, rttMs: _r, ...s }) => s) });
}

/** The durable projection of a participant: everything but when they were last heard from. */
export function participantDurableKey(p: StoredParticipant): string {
  const { lastSeenAt: _s, videoTickAt: _v, links: _l, ...rest } = p;
  return JSON.stringify(rest);
}

/** The durable projection of a broadcast job: its state and destinations, not the counters a segment moves. */
export function jobDurableKey(j: PublishJob): string {
  const { live, updatedAt: _u, ...rest } = j;
  return JSON.stringify({ ...rest, live: live ? { youtube: live.youtube, relay: live.relay, youtubeNote: live.youtubeNote, relayNote: live.relayNote } : null });
}

export const clone = <T>(v: T): T => structuredClone(v);

export interface LiveMeet {
  meet: Meet;
  /** The durable projection as SQLite has it. */
  key: string;
  /** Something ephemeral (the expiry, a clock) changed since the row was last written. */
  soft: boolean;
  flushedAt: number;
  participants: Map<string, StoredParticipant>;
  /** Each participant's durable projection as SQLite has it. */
  pKeys: Map<string, string>;
  signals: MeetSignal[];
  signalSeq: number;
  mix: MixBatch[];
  mixSeq: number;
  /** The last mix poll (a listener who polls rather than streams). */
  listenedAt: number;
  /** Listeners streaming the mix: each is handed every batch as it arrives. */
  mixStreams: Set<(b: MixBatch) => void>;
  /** The newest chat line's seq (a poll that has it skips the read). */
  chatLatest: number;
  recordings: MeetRecording[] | null;
  performances: MeetPerformance[] | null;
}

export interface LiveJob {
  job: PublishJob;
  key: string;
  soft: boolean;
  segments: { info: LiveSegmentInfo; bytes: Uint8Array }[];
}

export class LiveRooms {
  readonly meets = new Map<string, LiveMeet>();
  readonly jobs = new Map<string, LiveJob>();
  /** Seconds of video on stage not yet written, by pool and month, with the total SQLite holds. */
  readonly video = new Map<string, { persisted: number; pending: number }>();

  /** A meet read from SQLite and found open: it lives here from now on. `now` is when it was loaded. */
  admit(meet: Meet, participants: StoredParticipant[], chatLatest: number, now: number, grace = true): LiveMeet {
    const iso = new Date(now).toISOString();
    // Grace after a restart: the stored expiry is at most SOFT_FLUSH_MS behind the truth (that is how often it is
    // written while heartbeats extend it), so the truth is taken to be that much later; and everyone who was in
    // the meet is given the usual minute to be heard from again (their stored last-seen is their last durable change).
    if (grace) meet.expiresAt = new Date((Date.parse(meet.expiresAt) || now) + SOFT_FLUSH_MS).toISOString();
    const entry: LiveMeet = {
      meet,
      key: meetDurableKey(meet),
      soft: false,
      flushedAt: now,
      participants: new Map(),
      pKeys: new Map(),
      signals: [],
      signalSeq: 0,
      mix: [],
      mixSeq: 0,
      listenedAt: 0,
      mixStreams: new Set(),
      chatLatest,
      recordings: null,
      performances: null,
    };
    for (const p of participants) {
      entry.pKeys.set(p.participantId, participantDurableKey(p));
      entry.participants.set(p.participantId, { ...p, lastSeenAt: iso });
    }
    this.meets.set(meet.meetId, entry);
    return entry;
  }

  /** The meet is closed (stopped, expired, deleted): everything of it here goes. */
  evict(meetId: string): LiveMeet | undefined {
    const e = this.meets.get(meetId);
    this.meets.delete(meetId);
    return e;
  }

  // ---- signals: a bounded queue per meet, numbered on arrival ----

  addSignal(meetId: string, sig: Omit<MeetSignal, 'seq'>, now = Date.now()): MeetSignal | null {
    const e = this.meets.get(meetId);
    if (!e) return null;
    const full: MeetSignal = { ...sig, seq: ++e.signalSeq };
    e.signals.push(full);
    // The old go first: by age (nobody wants a two-minute-old candidate), then by count.
    const cutoff = now - SIGNAL_TTL_MS;
    let drop = 0;
    while (drop < e.signals.length - 1 && Date.parse(e.signals[drop]!.sentAt) < cutoff) drop++;
    if (e.signals.length - drop > SIGNALS_KEEP) drop = e.signals.length - SIGNALS_KEEP;
    if (drop > 0) e.signals.splice(0, drop);
    return full;
  }

  signalsFor(meetId: string, to: string, since: number, limit: number): MeetSignal[] {
    const e = this.meets.get(meetId);
    if (!e) return [];
    const out: MeetSignal[] = [];
    for (const s of e.signals) {
      if (s.to !== to || s.seq <= since) continue;
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  clearSignals(meetId: string): void {
    const e = this.meets.get(meetId);
    if (e) e.signals = [];
  }

  // ---- the audience mix: a rolling window per meet, fanned out to whoever streams it ----

  addMix(meetId: string, batch: MixBatch): number {
    const e = this.meets.get(meetId);
    if (!e) return 0;
    const seq = ++e.mixSeq;
    const full = { ...batch, seq };
    e.mix.push(full);
    if (e.mix.length > MIX_KEEP) e.mix.splice(0, e.mix.length - MIX_KEEP);
    for (const send of e.mixStreams) {
      try {
        send(full);
      } catch {
        /* a dead stream is dropped by its route */
      }
    }
    return seq;
  }

  listMix(meetId: string, since: number, limit: number, now: number): { batches: MixBatch[]; latest: number } {
    const e = this.meets.get(meetId);
    if (!e) return { batches: [], latest: 0 };
    e.listenedAt = now;
    return { batches: e.mix.filter((b) => b.seq > since).slice(0, limit), latest: e.mixSeq };
  }

  /** Stream the mix: every batch from now on (and the window's tail after `since`) to `send`; the returned function stops it. */
  streamMix(meetId: string, since: number, send: (b: MixBatch) => void): (() => void) | null {
    const e = this.meets.get(meetId);
    if (!e) return null;
    e.mixStreams.add(send);
    // A listener starting afresh gets the newest few seconds, not the whole window (they would run that far behind).
    for (const b of since === 0 ? e.mix.slice(-3) : e.mix.filter((x) => x.seq > since)) send(b);
    return () => {
      this.meets.get(meetId)?.mixStreams.delete(send);
    };
  }

  /** Somebody is hearing the mix (a stream open, or a poll a moment ago): the host's device sends it only then. */
  mixListening(meetId: string, now: number): boolean {
    const e = this.meets.get(meetId);
    return Boolean(e && (e.mixStreams.size > 0 || now - e.listenedAt < LISTENER_RECENT_MS));
  }

  // ---- a broadcast's segments: a rolling window per job ----

  addSegment(jobId: string, info: LiveSegmentInfo, bytes: Uint8Array): void {
    const j = this.jobs.get(jobId);
    if (!j) return;
    // A publisher that started over (a reload) counts from 0 again: what remains of the earlier run is stale.
    j.segments = j.segments.filter((s) => s.info.seq < info.seq);
    j.segments.push({ info, bytes });
    if (j.segments.length > LIVE_KEEP) j.segments.splice(0, j.segments.length - LIVE_KEEP);
  }

  /** How much memory the broadcasts' windows hold (diagnostics). */
  segmentBytes(): number {
    let n = 0;
    for (const j of this.jobs.values()) for (const s of j.segments) n += s.bytes.byteLength;
    return n;
  }

  // ---- video seconds: counted here, written by the minute ----

  addVideoSeconds(key: string, persisted: number | null, seconds: number): { total: number; due: number } {
    let v = this.video.get(key);
    if (!v) {
      v = { persisted: persisted ?? 0, pending: 0 };
      this.video.set(key, v);
    }
    v.pending += Math.max(0, seconds);
    const due = v.pending >= VIDEO_FLUSH_SECONDS ? v.pending : 0;
    return { total: v.persisted + v.pending, due };
  }

  /** The seconds written: moved from pending to persisted. */
  videoFlushed(key: string, seconds: number): void {
    const v = this.video.get(key);
    if (!v) return;
    v.pending = Math.max(0, v.pending - seconds);
    v.persisted += seconds;
  }

  /** What a diagnostics line says of this layer. */
  summary(now: number): { meets: number; participants: number; signals: number; mixStreams: number; jobs: number; segmentBytes: number; listening: number } {
    let participants = 0;
    let signals = 0;
    let mixStreams = 0;
    let listening = 0;
    for (const [id, e] of this.meets) {
      participants += e.participants.size;
      signals += e.signals.length;
      mixStreams += e.mixStreams.size;
      if (this.mixListening(id, now)) listening++;
    }
    return { meets: this.meets.size, participants, signals, mixStreams, jobs: this.jobs.size, segmentBytes: this.segmentBytes(), listening };
  }
}

/** True for a meet that belongs in the live layer: open, so devices keep it moving. */
export const liveWorthy = (m: Meet): boolean => meetIsOpen(m);
