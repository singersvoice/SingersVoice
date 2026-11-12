/**
 * Client-side meet session: join, poll (heartbeat), actions. Polling cadence: 2 s while the room
 * is forming or counting down (the kickstart instant is absolute, so 2 s is plenty), 5 s otherwise.
 */
import { signal } from '@preact/signals';
import { MEET_IDLE_EXPIRY_MS, meetIsOpen, type ChatMessage, type MeetSignal, type MeetSignalType, type MeetSnapshot, type Participant, type SongPick, type StagePolicy } from '@singersvoice/protocol';
import { api, ApiError, clock, serverNow, syncClock } from '../../lib/api.ts';

const POLL_FORMING_MS = 2000;
const POLL_ONSTAGE_MS = 1500;
const POLL_SETTLED_MS = 5000;

export class MeetSession {
  readonly snapshot = signal<MeetSnapshot | null>(null);
  readonly you = signal<Participant | null>(null);
  readonly chat = signal<ChatMessage[]>([]);
  readonly error = signal<string | null>(null);
  readonly joining = signal(false);
  resumeToken = '';
  private lastSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight = false;

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

  async join(role: 'audience' | 'performer' | 'publisher'): Promise<void> {
    this.joining.value = true;
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
    this.timer = setTimeout(() => void this.heartbeat().finally(() => this.schedule()), forming ? POLL_FORMING_MS : onStageLive ? POLL_ONSTAGE_MS : POLL_SETTLED_MS);
  }

  private apply(snap: MeetSnapshot): void {
    this.snapshot.value = snap;
    if (snap.you) this.you.value = snap.you;
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
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410)) {
        this.error.value = e.message;
        this.stop();
      } else if (e instanceof ApiError && e.code === 'offline') {
        this.error.value = 'Connection lost — retrying';
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async act(path: string, body: Record<string, unknown>): Promise<void> {
    const snap = await api.post('POST /meets/:id/slot', `/meets/${encodeURIComponent(this.meetId)}/${path}`, { resumeToken: this.resumeToken, ...body } as never);
    this.apply(snap as MeetSnapshot);
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
  removeFromStage(participantId: string): Promise<void> {
    return this.act(`stage/${encodeURIComponent(participantId)}/remove`, {});
  }
  setStagePolicy(stagePolicy: StagePolicy): Promise<void> {
    return this.act('policy', { stagePolicy });
  }
  /** The set list: anyone on stage adds a song (the host may play it now); the host orders it and ends the current song. */
  addSong(song: SongPick, now = false): Promise<void> {
    return this.act('songs', { song, now });
  }
  songAction(songId: string, action: 'remove' | 'up' | 'now'): Promise<void> {
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
  restart(leadMs = 5000, fromMs = 0): Promise<void> {
    return this.act('restart', { leadMs, fromMs });
  }

  // ---- WebRTC signalling relay (performer ↔ performer) ----
  private lastSignalSeq = 0;
  /** The relay only serves open meets: nothing is sent or polled once the meet ended (teardown stays quiet). */
  private get closed(): boolean {
    const m = this.snapshot.value?.meet;
    return this.stopped || Boolean(m && !meetIsOpen(m));
  }
  async sendSignal(to: string, type: MeetSignalType, data: unknown): Promise<void> {
    if (!this.resumeToken || this.closed) return;
    await api.post('POST /meets/:id/signal', `/meets/${encodeURIComponent(this.meetId)}/signal`, { resumeToken: this.resumeToken, to, type, data: typeof data === 'string' ? data : JSON.stringify(data) });
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
  async registerRecording(performanceId: string, driveFolderLink: string | null, durationMs: number): Promise<void> {
    await api.post('POST /meets/:id/recordings', `/meets/${encodeURIComponent(this.meetId)}/recordings`, { resumeToken: this.resumeToken, performanceId, driveFolderLink, durationMs });
  }
  async leave(): Promise<void> {
    this.stop();
    if (this.resumeToken) await api.post('POST /meets/:id/leave', `/meets/${encodeURIComponent(this.meetId)}/leave`, { resumeToken: this.resumeToken }).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** ms until the idle expiry, by the server clock. */
  msToExpiry(): number {
    const m = this.snapshot.value?.meet;
    if (!m || !meetIsOpen(m)) return 0;
    return Math.max(0, Date.parse(m.expiresAt) - serverNow());
  }

  static readonly IDLE_MS = MEET_IDLE_EXPIRY_MS;
}
