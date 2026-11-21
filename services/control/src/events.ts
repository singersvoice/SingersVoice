/**
 * The meet's push channel: every device in a meet keeps one event stream open (`GET /meets/:id/events`,
 * app.ts) and is handed the meet's state the moment something changed — a slot taken, a song picked,
 * the transport cued — as a `room` event carrying the state itself (the host's view names everyone;
 * everyone else's names the stage, the wait list and a dozen of the audience), a `chat` event carrying
 * each new line, and a `signal` event carrying each WebRTC signal addressed to the device. A device
 * with the stream open therefore asks the service for nothing between changes: its heartbeat is a
 * slow safety net (presence is the open stream itself), and a change costs the service one snapshot
 * for the whole room, however many devices are in it, instead of a request from each.
 *
 * One instance per running service: on Node one process serves every meet; on Cloudflare every request
 * of every meet goes through the one Durable Object, so an in-memory map of who listens is the whole
 * truth there too.
 */
import type { ChatMessage, MeetSignal, RoomUpdate } from '@singersvoice/protocol';

export type MeetEvent = { type: 'changed' } | { type: 'room'; room: RoomUpdate } | { type: 'chat'; message: ChatMessage } | { type: 'signal'; to: string; signal?: MeetSignal };

/** The room as the host sees it and as everyone else does, built once per change. */
export interface RoomViews {
  host: RoomUpdate;
  public: RoomUpdate;
}

interface Subscriber {
  participantId: string;
  /** The host's stream gets the host's view (everyone named). */
  host: boolean;
  send: (ev: MeetEvent) => void;
  /** The stream is over for this one (the meet ended): the route closes it. */
  end: () => void;
}

/** Streams one participant may keep open at once (a device reconnecting overlaps itself for a moment; a flood does not): the oldest is closed for a new one. */
export const STREAMS_PER_PARTICIPANT = 4;

export class MeetEvents {
  private subs = new Map<string, Set<Subscriber>>();
  /** Meets with a 'room' on its way: one action often changes a meet twice over (its own write, then a tidy-up while answering) — the devices are told once. */
  private dirty = new Set<string>();
  /** The flush under way per meet (a close waits for it, so the last word goes out before the streams end). */
  private flushing = new Map<string, Promise<void>>();

  /** Builds the room's state for a meet (null: the meet is gone); without it every change is a bare 'changed' and the devices fetch. */
  private readonly views: ((meetId: string) => Promise<RoomViews | null>) | null;

  constructor(views: ((meetId: string) => Promise<RoomViews | null>) | null = null) {
    this.views = views;
  }

  /** Listen for a meet's events as one participant; the returned function stops listening. */
  subscribe(meetId: string, participantId: string, host: boolean, send: (ev: MeetEvent) => void, end: () => void): () => void {
    const sub: Subscriber = { participantId, host, send, end };
    let set = this.subs.get(meetId);
    if (!set) {
      set = new Set();
      this.subs.set(meetId, set);
    }
    // One participant, too many streams: the oldest goes (its route notices and closes).
    const mine = [...set].filter((x) => x.participantId === participantId);
    for (const old of mine.slice(0, Math.max(0, mine.length + 1 - STREAMS_PER_PARTICIPANT))) {
      set.delete(old);
      try {
        old.end();
      } catch {
        /* ignore */
      }
    }
    set.add(sub);
    return () => {
      const s = this.subs.get(meetId);
      if (!s) return;
      s.delete(sub);
      if (!s.size) this.subs.delete(meetId);
    };
  }

  /** Something about the meet changed (its state, its stage, a song): everyone listening gets the room (told once per turn of the service). */
  changed(meetId: string): void {
    if (!this.subs.has(meetId) || this.dirty.has(meetId)) return;
    this.dirty.add(meetId);
    setTimeout(() => void this.flush(meetId), 0);
  }

  /** The 'room' on its way for a meet, built and sent now. */
  private flush(meetId: string): Promise<void> {
    if (!this.dirty.delete(meetId)) return this.flushing.get(meetId) ?? Promise.resolve();
    const run = (async () => {
      const set = this.subs.get(meetId);
      if (!set?.size) return;
      let views: RoomViews | null = null;
      if (this.views) {
        try {
          views = await this.views(meetId);
        } catch {
          views = null; // the devices fetch for themselves
        }
      }
      for (const s of set) {
        try {
          s.send(views ? { type: 'room', room: s.host ? views.host : views.public } : { type: 'changed' });
        } catch {
          /* a dead stream is dropped when its route notices */
        }
      }
    })().finally(() => {
      if (this.flushing.get(meetId) === run) this.flushing.delete(meetId);
    });
    this.flushing.set(meetId, run);
    return run;
  }

  /** A chat line: handed to everyone listening as it is. */
  chat(meetId: string, message: ChatMessage): void {
    const set = this.subs.get(meetId);
    if (!set) return;
    for (const s of set) {
      try {
        s.send({ type: 'chat', message });
      } catch {
        /* as above */
      }
    }
  }

  /** A WebRTC signal for one participant: handed to that device's streams as it is (the poll is its safety net). */
  signal(meetId: string, signal: MeetSignal): number {
    const set = this.subs.get(meetId);
    if (!set) return 0;
    let told = 0;
    for (const s of set) {
      if (s.participantId !== signal.to) continue;
      try {
        s.send({ type: 'signal', to: signal.to, signal });
        told++;
      } catch {
        /* as above */
      }
    }
    return told;
  }

  /** The meet is over: every stream of it is handed the last word on its way, then closed (the devices read the state from it). */
  async close(meetId: string): Promise<void> {
    await this.flush(meetId);
    const set = this.subs.get(meetId);
    if (!set) return;
    this.subs.delete(meetId);
    for (const s of set) {
      try {
        s.end();
      } catch {
        /* ignore */
      }
    }
  }

  /** How many streams a meet has open (tests, diagnostics). */
  listeners(meetId: string): number {
    return this.subs.get(meetId)?.size ?? 0;
  }

  /** Whether one participant has a stream open (presence without a heartbeat). */
  listening(meetId: string, participantId: string): boolean {
    const set = this.subs.get(meetId);
    if (!set) return false;
    for (const s of set) if (s.participantId === participantId) return true;
    return false;
  }
}
