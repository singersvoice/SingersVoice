/**
 * The meet's push channel: every device in a meet keeps one event stream open (`GET /meets/:id/events`,
 * app.ts) and is told the moment something changed — a slot taken, a song picked, the transport cued,
 * a chat line — so it fetches the new state at once instead of at its next poll. The polling stays,
 * as the safety net, at a relaxed pace.
 *
 * One instance per running service: on Node one process serves every meet; on Cloudflare every request
 * of every meet goes through the one Durable Object, so an in-memory map of who listens is the whole
 * truth there too.
 */

export type MeetEvent = { type: 'changed' } | { type: 'signal'; to: string };

interface Subscriber {
  participantId: string;
  send: (ev: MeetEvent) => void;
  /** The stream is over for this one (the meet ended): the route closes it. */
  end: () => void;
}

export class MeetEvents {
  private subs = new Map<string, Set<Subscriber>>();
  /** Meets with a 'changed' on its way: one action often changes a meet twice over (its own write, then a tidy-up while answering) — the devices are told once. */
  private dirty = new Set<string>();

  /** Listen for a meet's events as one participant; the returned function stops listening. */
  subscribe(meetId: string, participantId: string, send: (ev: MeetEvent) => void, end: () => void): () => void {
    const sub: Subscriber = { participantId, send, end };
    let set = this.subs.get(meetId);
    if (!set) {
      set = new Set();
      this.subs.set(meetId, set);
    }
    set.add(sub);
    return () => {
      const s = this.subs.get(meetId);
      if (!s) return;
      s.delete(sub);
      if (!s.size) this.subs.delete(meetId);
    };
  }

  /** Something about the meet changed (its state, its stage, a song, a chat line): everyone listening fetches it (told once per turn of the service). */
  changed(meetId: string): void {
    if (!this.subs.has(meetId) || this.dirty.has(meetId)) return;
    this.dirty.add(meetId);
    setTimeout(() => this.flush(meetId), 0);
  }

  /** The 'changed' on its way for a meet, sent now. */
  private flush(meetId: string): void {
    if (!this.dirty.delete(meetId)) return;
    const set = this.subs.get(meetId);
    if (!set) return;
    for (const s of set) {
      try {
        s.send({ type: 'changed' });
      } catch {
        /* a dead stream is dropped when its route notices */
      }
    }
  }

  /** A WebRTC signal is waiting for one participant: that device polls its signals now. */
  signal(meetId: string, to: string): void {
    const set = this.subs.get(meetId);
    if (!set) return;
    for (const s of set) {
      if (s.participantId !== to) continue;
      try {
        s.send({ type: 'signal', to });
      } catch {
        /* as above */
      }
    }
  }

  /** The meet is over: every stream of it is told what was on its way, then closed (the devices learn why from their next heartbeat). */
  close(meetId: string): void {
    this.flush(meetId);
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
}
