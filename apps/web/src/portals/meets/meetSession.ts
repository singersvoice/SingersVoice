/**
 * Client-side meet session: join, the push stream, the heartbeat, actions.
 *
 * The service pushes: one event stream per device (`GET /meets/:id/events`, SSE) hands this device the room
 * itself the moment anything about the meet changed — on any device — as a `room` event (the meet, who is in it,
 * the saved shows), each chat line as a `chat` event, and each WebRTC signal addressed to this device as a
 * `signal` event (the mesh takes it straight from here). With the stream open the session asks the service for
 * nothing between changes: the heartbeat runs every 30 s as presence's safety net and the clock report (the open
 * stream itself is presence to the service). Without the stream (a browser without EventSource, a proxy that
 * will not stream) the heartbeat polls the state: 3 s while the room is forming or counting down, 2 s on stage
 * while live, 5 s otherwise. A peer's word over the mesh that something changed (`onActed` fires after every
 * action of this device, so the room can tell the others) fetches the state at once as well.
 *
 * Failures are told apart (lib/api.ts): no answer at all, a service that answered with a failure, a service
 * whose storage allowance is spent. The heartbeat backs off on failures (with jitter, never a hammer) and the
 * room shows the real reason; the stream, watched for silence, is opened again when it goes quiet.
 */
import { signal } from '@preact/signals';
import { MEET_IDLE_EXPIRY_MS, meetIsOpen, type ChatMessage, type LinkSummary, type MeetPerformance, type MeetSignal, type MeetSignalType, type MeetSnapshot, type Participant, type RegisterPerformanceRequest, type RoomUpdate, type SongPick, type StagePolicy } from '@singersvoice/protocol';
import { api, ApiError, authHeaders, beacon, clock, controlUrl, serverNow, serviceUrl, syncClock } from '../../lib/api.ts';

interface Pace {
  forming: number;
  onStage: number;
  /** The audience while the stage is live: the song, the background and who is on stage change under them too. */
  audienceLive: number;
  settled: number;
}
/** The polls alone (no push stream): the state comes from them. */
const POLL: Pace = { forming: 3000, onStage: 2000, audienceLive: 3000, settled: 5000 };
/** With the push stream open: presence's safety net and the clock report, nothing else. */
const POLL_PUSHED: Pace = { forming: 30_000, onStage: 30_000, audienceLive: 30_000, settled: 30_000 };
/** A stream the service refused (or a browser that cannot keep one) is tried again this often. */
const EVENTS_RETRY_MS = 15_000;
/** The service pings the stream every 25 s; a stream silent this long is dead (a proxy, a sleeping phone) and is opened again. */
const EVENTS_SILENT_MS = 70_000;
/** A heartbeat that fails is tried again after this long at first, doubling each time, to this at most — with jitter. */
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 30_000;

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
  /** The link to the service as this session sees it: fine, no answer, a failure answered, or its storage spent (lib/api.ts tells them apart). */
  readonly link = signal<'ok' | 'offline' | 'failing' | 'storage_limit'>('ok');
  resumeToken = '';
  private lastSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight = false;
  private pokeAgain = false;
  /** Heartbeats failed in a row (the backoff doubles with each). */
  private failures = 0;
  /**
   * The service's clock on the newest state this device holds (`serverEpochMs`, stamped by the service as the state
   * was read — app.ts `roomOf`). An answer older than it — an action's or a heartbeat's answer that reached a busy
   * page after the room the stream pushed in the meantime, or one whose state was read before a cued pause landed
   * and finished after the room that carried the landing — would turn the clock back (a listener who had just come
   * in gone again until the next heartbeat; a stage still "Pausing…"): its room is left alone, its own lines taken.
   */
  private stateAt = 0;
  /** After every action of this device went through (the snapshot is applied): the room tells its peers to fetch it now. */
  onActed: (() => void) | null = null;
  /** The service says a WebRTC signal waits for this device (polled when the event carries none). */
  onSignal: ((signal: MeetSignal | null) => void) | null = null;
  /** What this device's links to the other singers carry (the stage sets it): sent with every heartbeat for the host's view of every device. */
  linkSummary: (() => LinkSummary | null) | null = null;
  /** The push stream, while the device is in the meet. */
  private source: EventSource | null = null;
  private pushed = false;
  private lastOpenTry = 0;
  private lastEventAt = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
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
      this.link.value = 'ok';
      this.failures = 0;
      await this.heartbeat();
      this.openEvents();
      this.schedule();
    } catch (e) {
      this.error.value = e instanceof ApiError ? e.message : String(e);
      if (e instanceof ApiError) this.noteFailure(e);
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
    let wait = forming ? pace.forming : onStageLive ? pace.onStage : m?.state === 'live' ? pace.audienceLive : pace.settled;
    // Failing: back off, doubling, with jitter — a service in trouble is not helped by a hammer.
    if (this.failures > 0) wait = Math.max(wait, Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.failures - 1)) * (0.8 + Math.random() * 0.4));
    this.timer = setTimeout(() => void this.heartbeat().finally(() => this.schedule()), wait);
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
    this.lastEventAt = Date.now();
    const alive = () => {
      this.lastEventAt = Date.now();
    };
    es.onopen = () => {
      if (this.source !== es) return;
      alive();
      const first = !this.pushed;
      this.pushed = true;
      this.poke(); // whatever happened while the stream was down (and the heartbeat's own: the video hours, the clock)
      if (first) this.schedule();
    };
    es.addEventListener('ping', () => {
      if (this.source === es) alive();
    });
    es.addEventListener('room', (ev) => {
      if (this.source !== es) return;
      alive();
      try {
        const data = JSON.parse(String((ev as MessageEvent).data)) as { room?: RoomUpdate };
        if (data.room) this.applyRoom(data.room);
      } catch {
        this.poke();
      }
    });
    es.addEventListener('changed', () => {
      if (this.source !== es) return;
      alive();
      this.poke();
    });
    es.addEventListener('chat', (ev) => {
      if (this.source !== es) return;
      alive();
      try {
        const data = JSON.parse(String((ev as MessageEvent).data)) as { message?: ChatMessage };
        if (data.message) this.takeChat([data.message]);
      } catch {
        /* a line the next heartbeat brings */
      }
    });
    es.addEventListener('signal', (ev) => {
      if (this.source !== es) return;
      alive();
      let sig: MeetSignal | null = null;
      try {
        sig = (JSON.parse(String((ev as MessageEvent).data)) as { signal?: MeetSignal }).signal ?? null;
      } catch {
        sig = null;
      }
      if (sig && sig.seq > this.lastSignalSeq) this.lastSignalSeq = sig.seq;
      this.onSignal?.(sig);
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
    // A stream that stopped speaking (no ping for over a minute: a proxy that dropped it quietly, a phone back from sleep) is made again.
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.source !== es || this.stopped) return;
      if (Date.now() - this.lastEventAt > EVENTS_SILENT_MS) this.openEvents();
    }, 10_000);
  }

  private closeEvents(): void {
    const es = this.source;
    this.source = null;
    this.pushed = false;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
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

  private takeChat(lines: ChatMessage[]): void {
    if (!lines.length) return;
    const known = new Set(this.chat.value.map((c) => c.seq));
    const fresh = lines.filter((c) => !known.has(c.seq));
    if (!fresh.length) return;
    this.chat.value = [...this.chat.value, ...fresh].sort((a, b) => a.seq - b.seq).slice(-200);
    this.lastSeq = Math.max(this.lastSeq, ...fresh.map((c) => c.seq));
  }

  /** Whether a state stamped `at` by the service is the newest this device has seen (and so is applied). */
  private newest(at: number | undefined): boolean {
    if (typeof at !== 'number' || !Number.isFinite(at) || at >= this.stateAt) {
      if (typeof at === 'number' && Number.isFinite(at)) this.stateAt = at;
      return true;
    }
    return false;
  }

  private apply(snap: MeetSnapshot): void {
    if (this.newest(snap.serverEpochMs)) {
      this.snapshot.value = snap;
      if (snap.you) this.you.value = snap.you;
    }
    // This device's own: the video hours (a heartbeat's answer alone carries them) and the chat (merged by sequence).
    if (snap.yourVideo) this.yourVideo.value = snap.yourVideo;
    this.takeChat(snap.chat);
  }

  /**
   * The room as the stream handed it: the state of everyone, applied over what this device had. What is this
   * device's own comes from its heartbeat (the chat position, the video hours) — and when the room no longer
   * names this device where it was (taken off the stage by the host, say), the heartbeat is asked now.
   */
  private applyRoom(room: RoomUpdate): void {
    if (!this.newest(room.serverEpochMs)) return; // an older room than the one this device holds (a stream catching up): nothing to learn from it
    const prev = this.snapshot.value;
    const me = this.you.value;
    const named = me ? room.participants.find((p) => p.participantId === me.participantId) : undefined;
    this.snapshot.value = { ...(prev ?? { chat: [] }), ...room, chat: prev?.chat ?? [], ...(named ? { you: named } : prev?.you ? { you: prev.you } : {}) };
    if (named) {
      const mediaChanged = me !== null && named.media !== me.media;
      this.you.value = named;
      if (mediaChanged) {
        this.yourVideo.value = null; // the picture permission moved (a plan, the hours): the hours and the reason are the heartbeat's to say, now
        this.poke();
      }
    } else if (me && me.slot !== null && !room.meet.stage.some((s) => s.participantId === me.participantId)) this.poke(); // off the stage: my own record, now
    if (!meetIsOpen(room.meet)) this.poke(); // the end: the heartbeat answers with why (ended, expired) and stops this session
  }

  /** The failure, told apart, for the room to show the real reason. */
  private noteFailure(e: ApiError): void {
    this.link.value = e.code === 'offline' ? 'offline' : e.code === 'storage_limit' ? 'storage_limit' : e.status >= 500 ? 'failing' : this.link.value;
  }

  async heartbeat(): Promise<void> {
    if (this.inFlight || !this.resumeToken) return;
    this.inFlight = true;
    try {
      const links = this.linkSummary?.() ?? null;
      const snap = await api.post('POST /meets/:id/heartbeat', `/meets/${encodeURIComponent(this.meetId)}/heartbeat`, {
        resumeToken: this.resumeToken,
        chatSince: this.lastSeq,
        driftMs: Math.round(clock.value.offsetMs),
        rttMs: Math.round(clock.value.rttMs),
        ...(links ? { links } : {}),
      });
      this.apply(snap);
      this.error.value = null;
      this.link.value = 'ok';
      this.failures = 0;
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
      } else if (e instanceof ApiError) {
        // No answer, a failure answered, the storage spent: said as it is, and tried again with backoff.
        this.failures++;
        this.noteFailure(e);
        this.error.value = e.message;
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
  /** The stage background — the host or any singer on stage, whenever; every device and the show follow at once. */
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
  /** Where the host's device sends the mix from its Worker (audio/mix.worker.ts): the route, and this device's resume token to carry; null before the join. */
  mixTarget(): { url: string; resumeToken: string; headers: Record<string, string> } | null {
    return this.resumeToken && controlUrl.value ? { url: serviceUrl(`/meets/${encodeURIComponent(this.meetId)}/mix`), resumeToken: this.resumeToken, headers: authHeaders() } : null;
  }
  /** Somebody is hearing the mix right now (the service says so with every room it hands over): the host's device encodes and sends it only then. */
  mixWanted(): boolean {
    return this.snapshot.value?.mixListening === true;
  }
  /**
   * Where the audience's player (audio/mixPlayer.ts, its Worker) takes the mix from: the public watch route — the mix
   * as a stream (one request for the whole listen), and the poll the player falls back on where streams fail, which
   * the edge caches: a hundred listeners at the live edge ask the same question and the service answers it once.
   */
  mixSource(): { pollUrl: string; streamUrl: string } {
    return { pollUrl: serviceUrl(`/watch/${encodeURIComponent(this.meetId)}/mix`), streamUrl: serviceUrl(`/watch/${encodeURIComponent(this.meetId)}/mix/stream`) };
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
  /** Signals addressed to me that arrived since the last one seen (the stream hands most of them over; this is the safety net). */
  async pollSignals(): Promise<MeetSignal[]> {
    if (!this.resumeToken || this.closed) return [];
    const r = await api.post('POST /meets/:id/signals', `/meets/${encodeURIComponent(this.meetId)}/signals`, { resumeToken: this.resumeToken, since: this.lastSignalSeq });
    for (const s of r.signals) this.lastSignalSeq = Math.max(this.lastSignalSeq, s.seq);
    return r.signals;
  }
  async say(text: string): Promise<void> {
    const r = await api.post('POST /meets/:id/chat', `/meets/${encodeURIComponent(this.meetId)}/chat`, { resumeToken: this.resumeToken, text });
    this.takeChat([r.message]);
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

  /**
   * The page is going (closed, reloaded — `pagehide`): told to the service with a beacon, no answer waited for. A device
   * heard from again within seconds (a reload) keeps its slot; one that does not is taken off the stage then, and the
   * others' links to it are dropped — not a minute later, when its silence would have been noticed anyway.
   */
  away(): void {
    if (this.stopped || !this.resumeToken) return;
    beacon('POST /meets/:id/away', `/meets/${encodeURIComponent(this.meetId)}/away?rt=${encodeURIComponent(this.resumeToken)}`);
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
