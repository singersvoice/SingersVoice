/**
 * Client-side meet session: join, the push stream, poll (heartbeat), actions.
 *
 * The service pushes: one event stream per device (`GET /meets/:id/events`, SSE) says 'changed' the moment
 * anything about the meet changed — on any device — and the session fetches the snapshot at once (`poke()`);
 * 'signal' says a WebRTC signal waits, and the mesh polls it now (`onSignal`). The heartbeat polls stay as the
 * safety net and the clock report, at a relaxed pace while the stream is open: 4 s while the room is forming or
 * counting down, 3 s on stage and in the show view while live, 4 s in the audience while live, 8 s otherwise.
 * Without the stream (a browser without EventSource, a proxy that will not stream) the polls run at the old
 * pace: 2 s / 1.5 s / 2 s / 5 s. A peer's word over the mesh that something changed (`onActed` fires after every
 * action of this device, so the room can tell the others) fetches the state at once as well.
 */
import { signal } from '@preact/signals';
import { MEET_IDLE_EXPIRY_MS, meetIsOpen, type ChatMessage, type MeetPerformance, type MeetSignal, type MeetSignalType, type MeetSnapshot, type MixBatch, type Participant, type RegisterPerformanceRequest, type SongPick, type StagePolicy } from '@singersvoice/protocol';
import { api, ApiError, clock, controlUrl, serverNow, syncClock } from '../../lib/api.ts';

interface Pace {
  forming: number;
  onStage: number;
  /** The audience while the stage is live: the song, the background and who is on stage change under them too. */
  audienceLive: number;
  settled: number;
}
/** The polls alone (no push stream). */
const POLL: Pace = { forming: 2000, onStage: 1500, audienceLive: 2000, settled: 5000 };
/** The polls with the push stream open: the safety net and the clock report. */
const POLL_PUSHED: Pace = { forming: 4000, onStage: 3000, audienceLive: 4000, settled: 8000 };
/** A stream the service refused (or a browser that cannot keep one) is tried again this often. */
const EVENTS_RETRY_MS = 15_000;

export class MeetSession {
  readonly snapshot = signal<MeetSnapshot | null>(null);
  readonly you = signal<Participant | null>(null);
  /** From every heartbeat: the video hours left to this account this month (null = without limit), and why the picture is off when it is. */
  readonly yourVideo = signal<{ leftSeconds: number | null; note: string; reason: '' | 'role' | 'plan' | 'hours' } | null>(null);
  readonly chat = signal<ChatMessage[]>([]);
  readonly error = signal<string | null>(null);
  /** Set when the meet is over for this device for good (removed by the host, the meet ended or expired): the room shows why and offers the way out. */
  readonly over = signal<{ code: string; message: string } | null>(null);
  readonly joining = signal(false);
  resumeToken = '';
  private lastSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight = false;
  private pokeAgain = false;
  /** After every action of this device went through (the snapshot is applied): the room tells its peers to fetch it now. */
  onActed: (() => void) | null = null;
  /** The service says a WebRTC signal waits for this device: the mesh polls its signals now. */
  onSignal: (() => void) | null = null;
  /** The push stream, while the device is in the meet. */
  private source: EventSource | null = null;
  private pushed = false;
  private lastOpenTry = 0;
  /** Whether the service pushes changes to this device right now (the mesh relaxes its own polling when it does). */
  get pushing(): boolean {
    return this.pushed;
  }

  /**
   * Resume token per meet — and per kind: the member record (host / performer / audience), the
   * publisher's show view and a Publishing Preview tile are each their own participant, so each
   * keeps its own token (a `view` tag tells several tiles of the same meet apart).
   */
  private readonly storageKey: string;

  constructor(
    readonly meetId: string,
    readonly kind: 'member' | 'publisher' | 'preview' = 'member',
    view = '',
  ) {
    this.storageKey = `sv.meet.${meetId}.${kind === 'member' ? '' : `${kind}${view ? `.${view}` : ''}.`}rt`;
    try {
      this.resumeToken = sessionStorage.getItem(this.storageKey) ?? '';
    } catch {
      /* ignore */
    }
  }

  private lastRole: 'audience' | 'performer' | 'publisher' = 'audience';
  private rejoining = false;

  async join(role: 'audience' | 'performer' | 'publisher'): Promise<void> {
    this.joining.value = true;
    this.lastRole = role;
    try {
      if (Date.now() - clock.value.syncedAt > 60_000) await syncClock();
      const r = await api.post('POST /meets/:id/join', `/meets/${encodeURIComponent(this.meetId)}/join`, { role, resumeToken: this.resumeToken || undefined });
      this.resumeToken = r.resumeToken;
      try {
        sessionStorage.setItem(this.storageKey, r.resumeToken);
      } catch {
        /* ignore */
      }
      this.you.value = r.you;
      this.error.value = null;
      await this.heartbeat();
      this.openEvents();
      this.schedule();
    } catch (e) {
      this.error.value = e instanceof ApiError ? e.message : String(e);
      throw e;
    } finally {
      this.joining.value = false;
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const m = this.snapshot.value?.meet;
    const forming = m && (m.state === 'lobby' || m.state === 'countdown');
    // Performers (and a publisher's show view) follow the host's transport cues, so they poll faster while live.
    const onStageLive = m?.state === 'live' && (this.you.value?.slot != null || this.you.value?.role === 'publisher');
    const pace = this.pushed ? POLL_PUSHED : POLL;
    this.timer = setTimeout(() => void this.heartbeat().finally(() => this.schedule()), forming ? pace.forming : onStageLive ? pace.onStage : m?.state === 'live' ? pace.audienceLive : pace.settled);
  }

  /**
   * Open the push stream (the resume token is its credential: the meet's own, never the Google token). A Preview tile
   * polls instead: a page of tiles would hold a stream each, and a monitor is fine a few seconds behind.
   */
  private openEvents(): void {
    this.closeEvents();
    const base = controlUrl.value;
    if (this.stopped || this.kind === 'preview' || !this.resumeToken || !base || typeof EventSource !== 'function') return;
    this.lastOpenTry = Date.now();
    let es: EventSource;
    try {
      es = new EventSource(`${base}/meets/${encodeURIComponent(this.meetId)}/events?rt=${encodeURIComponent(this.resumeToken)}`);
    } catch {
      return;
    }
    this.source = es;
    es.onopen = () => {
      if (this.source !== es) return;
      const first = !this.pushed;
      this.pushed = true;
      this.poke(); // whatever happened while the stream was down
      if (first) this.schedule();
    };
    es.addEventListener('changed', () => {
      if (this.source === es) this.poke();
    });
    es.addEventListener('signal', () => {
      if (this.source === es) this.onSignal?.();
    });
    es.onerror = () => {
      if (this.source !== es) return;
      // Down (the browser reconnects by itself) or refused for good (readyState CLOSED: tried again later): the polls run at the old pace meanwhile.
      if (this.pushed) {
        this.pushed = false;
        this.schedule();
      }
      if (es.readyState === EventSource.CLOSED) this.source = null;
    };
  }

  private closeEvents(): void {
    const es = this.source;
    this.source = null;
    this.pushed = false;
    es?.close();
  }

  /** Something changed (a peer said so over the mesh): fetch the snapshot now, not at the next poll. */
  poke(): void {
    if (this.stopped || !this.resumeToken) return;
    if (this.inFlight) {
      this.pokeAgain = true; // the answer on its way may predate the change: once more after it
      return;
    }
    clearTimeout(this.timer);
    void this.heartbeat().finally(() => this.schedule());
  }

  private apply(snap: MeetSnapshot): void {
    this.snapshot.value = snap;
    if (snap.you) this.you.value = snap.you;
    if (snap.yourVideo) this.yourVideo.value = snap.yourVideo;
    if (snap.chat.length) {
      const known = new Set(this.chat.value.map((c) => c.seq));
      const fresh = snap.chat.filter((c) => !known.has(c.seq));
      if (fresh.length) {
        this.chat.value = [...this.chat.value, ...fresh].sort((a, b) => a.seq - b.seq).slice(-200);
        this.lastSeq = Math.max(this.lastSeq, ...fresh.map((c) => c.seq));
      }
    }
  }

  async heartbeat(): Promise<void> {
    if (this.inFlight || !this.resumeToken) return;
    this.inFlight = true;
    try {
      const snap = await api.post('POST /meets/:id/heartbeat', `/meets/${encodeURIComponent(this.meetId)}/heartbeat`, {
        resumeToken: this.resumeToken,
        chatSince: this.lastSeq,
        driftMs: Math.round(clock.value.offsetMs),
        rttMs: Math.round(clock.value.rttMs),
      });
      this.apply(snap);
      this.error.value = null;
      if (!this.source && !this.stopped && Date.now() - this.lastOpenTry > EVENTS_RETRY_MS) this.openEvents();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_participant' && this.lastRole !== 'publisher' && !this.rejoining) {
        // The service forgot this device (asleep for a minute, a service restart): back in quietly — on a free
        // slot again when it had one and the stage rules allow it right now, else as a listener.
        this.rejoining = true;
        const wasOnStage = this.you.value?.slot != null;
        this.resumeToken = '';
        this.join(wasOnStage ? 'performer' : 'audience')
          .catch(() => undefined)
          .finally(() => (this.rejoining = false));
      } else if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410)) {
        this.error.value = e.message;
        this.over.value = { code: e.code, message: e.message };
        this.stop();
      } else if (e instanceof ApiError && e.code === 'offline') {
        this.error.value = 'Connection lost — retrying';
      }
    } finally {
      this.inFlight = false;
      if (this.pokeAgain) {
        this.pokeAgain = false;
        this.poke();
      }
    }
  }

  private async act(path: string, body: Record<string, unknown>): Promise<void> {
    const snap = await api.post('POST /meets/:id/slot', `/meets/${encodeURIComponent(this.meetId)}/${path}`, { resumeToken: this.resumeToken, ...body } as never);
    this.apply(snap as MeetSnapshot);
    this.onActed?.();
  }

  claimSlot(slot: number | null): Promise<void> {
    return this.act('slot', { slot });
  }
  setReady(ready: boolean): Promise<void> {
    return this.act('ready', { ready });
  }
  start(leadMs = 8000): Promise<void> {
    return this.act('start', { leadMs });
  }
  stopMeet(): Promise<void> {
    return this.act('stop', {});
  }
  /** Audience → singer: ask the host; withdraw; the host decides, clears a slot, or opens the stage to everyone. */
  askToSing(): Promise<void> {
    return this.act('requests', {});
  }
  withdrawAsk(): Promise<void> {
    return this.act('requests/withdraw', {});
  }
  decide(participantId: string, allow: boolean, slot?: number): Promise<void> {
    return this.act(`requests/${encodeURIComponent(participantId)}/decide`, { allow, ...(slot ? { slot } : {}) });
  }
  /** Host: remove someone from the meet altogether; they cannot come back in. */
  kick(participantId: string): Promise<void> {
    return this.act(`participants/${encodeURIComponent(participantId)}/kick`, {});
  }
  /** Host: out of the meet now, and blocked from every meet of the host's for good (Settings → Account lists them). */
  block(participantId: string): Promise<void> {
    return this.act(`participants/${encodeURIComponent(participantId)}/block`, {});
  }
  /** The club owner's switch: members only, or open to anyone with the link. */
  setMembersOnly(membersOnly: boolean): Promise<void> {
    return this.act('club', { membersOnly });
  }
  removeFromStage(participantId: string): Promise<void> {
    return this.act(`stage/${encodeURIComponent(participantId)}/remove`, {});
  }
  setStagePolicy(stagePolicy: StagePolicy): Promise<void> {
    return this.act('policy', { stagePolicy });
  }
  /** The stage background — the host or any singer on stage, whenever; every device and the show follow at their next poll. */
  setBackground(backgroundId: string): Promise<void> {
    return this.act('background', { backgroundId });
  }
  /**
   * The song of the stage — anyone on stage: pick one (nothing up → it is up on every device; a song up → it is
   * put forward and the stage chooses), choose one of the songs put forward ('current' keeps the one up; the rest
   * are dropped), withdraw one, or end the current song (`nextSong`).
   */
  addSong(song: SongPick): Promise<void> {
    return this.act('songs', { song });
  }
  songAction(songId: string, action: 'remove' | 'choose'): Promise<void> {
    return this.act(`songs/${encodeURIComponent(songId)}`, { action });
  }
  nextSong(): Promise<void> {
    return this.act('songs/next', {});
  }
  /** Host transport: pause freezes everyone's position; resume/restart cue a new shared kickstart. */
  pause(leadMs = 3000): Promise<void> {
    return this.act('pause', { leadMs });
  }
  resume(leadMs = 4000): Promise<void> {
    return this.act('resume', { leadMs });
  }
  restart(leadMs = 3000, fromMs = 0): Promise<void> {
    return this.act('restart', { leadMs, fromMs });
  }
  /** Jump the song for everyone (cued while playing, so every device jumps at the same instant). */
  seek(toMs: number, leadMs = 3000): Promise<void> {
    return this.act('seek', { leadMs, toMs });
  }
  /** The host's device sends a second of the stage mix for the audience. */
  async sendMix(batch: MixBatch): Promise<void> {
    await api.post('POST /meets/:id/mix', `/meets/${encodeURIComponent(this.meetId)}/mix`, { ...batch, resumeToken: this.resumeToken });
  }
  /** The audience fetches what came after `since` — through the public watch route, which the edge caches: a hundred listeners at the live edge ask the same question and the service answers it once. */
  fetchMix(since: number): Promise<{ batches: MixBatch[]; latest: number }> {
    return api.get('GET /watch/:id/mix', `/watch/${encodeURIComponent(this.meetId)}/mix?since=${since}`);
  }

  // ---- WebRTC signalling relay (performer ↔ performer) ----
  private lastSignalSeq = 0;
  /** The relay only serves open meets: nothing is sent or polled once the meet ended (teardown stays quiet). */
  private get closed(): boolean {
    const m = this.snapshot.value?.meet;
    return this.stopped || Boolean(m && !meetIsOpen(m));
  }
  /** Resolves false when they already left (the mesh forgets the link); a session that is leaving still says goodbye. */
  async sendSignal(to: string, type: MeetSignalType, data: unknown): Promise<boolean> {
    const m = this.snapshot.value?.meet;
    if (!this.resumeToken || (m && !meetIsOpen(m))) return false;
    const r = await api.post('POST /meets/:id/signal', `/meets/${encodeURIComponent(this.meetId)}/signal`, { resumeToken: this.resumeToken, to, type, data: typeof data === 'string' ? data : JSON.stringify(data) });
    return !r.gone;
  }
  /** Signals addressed to me that arrived since the last poll. */
  async pollSignals(): Promise<MeetSignal[]> {
    if (!this.resumeToken || this.closed) return [];
    const r = await api.post('POST /meets/:id/signals', `/meets/${encodeURIComponent(this.meetId)}/signals`, { resumeToken: this.resumeToken, since: this.lastSignalSeq });
    for (const s of r.signals) this.lastSignalSeq = Math.max(this.lastSignalSeq, s.seq);
    return r.signals;
  }
  async say(text: string): Promise<void> {
    const r = await api.post('POST /meets/:id/chat', `/meets/${encodeURIComponent(this.meetId)}/chat`, { resumeToken: this.resumeToken, text });
    this.apply({ ...(this.snapshot.value as MeetSnapshot), chat: [r.message] });
  }
  /** The host registers the film of the meet (one file, its chapter marks on it) with the meet; the answer names who else to share it with. */
  async registerPerformance(body: Omit<RegisterPerformanceRequest, 'resumeToken'>): Promise<{ performance: MeetPerformance; shareWith: string[] }> {
    const r = await api.post('POST /meets/:id/performances', `/meets/${encodeURIComponent(this.meetId)}/performances`, { resumeToken: this.resumeToken, ...body });
    const snap = this.snapshot.value;
    if (snap) this.snapshot.value = { ...snap, performances: [...(snap.performances ?? []).filter((p) => p.performanceId !== r.performance.performanceId), r.performance] };
    return r;
  }
  async unregisterPerformance(performanceId: string): Promise<void> {
    await api.del('DELETE /performances/:id', `/performances/${encodeURIComponent(performanceId)}`);
    const snap = this.snapshot.value;
    if (snap) this.snapshot.value = { ...snap, performances: (snap.performances ?? []).filter((p) => p.performanceId !== performanceId) };
  }
  /** Set by whoever runs a video mesh on this session: says goodbye to the peers before the session leaves. */
  onLeave: (() => Promise<void> | void) | null = null;
  async leave(): Promise<void> {
    const token = this.resumeToken;
    try {
      await Promise.race([Promise.resolve(this.onLeave?.()), new Promise((r) => setTimeout(r, 800))]);
    } catch {
      /* goodbyes are best effort */
    }
    this.stop(); // no more polling from this session
    if (token) await api.post('POST /meets/:id/leave', `/meets/${encodeURIComponent(this.meetId)}/leave`, { resumeToken: token }).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.closeEvents();
  }

  /** ms until the idle expiry, by the server clock. */
  msToExpiry(): number {
    const m = this.snapshot.value?.meet;
    if (!m || !meetIsOpen(m)) return 0;
    return Math.max(0, Date.parse(m.expiresAt) - serverNow());
  }

  static readonly IDLE_MS = MEET_IDLE_EXPIRY_MS;
}
