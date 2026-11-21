/**
 * The TV: a singer's stage on the big screen in the room.
 *
 * The TV's browser (or a laptop on the HDMI cable, a stick — anything with a browser) opens /tv and shows a
 * four-letter code and a QR of it (`TvScreenClient`). The singer, on the stage of their phone, taps TV and
 * types the code — or scans the QR, which opens the app at /tv/<code> and keeps the code — and the phone
 * claims the screen (`TvLink`). From then on the phone sends the TV its show picture (the stage as the
 * audience sees it, from the ShowRecorder's canvas) over a WebRTC link made straight between the two over
 * the room's Wi-Fi — the service (services/control/src/tv.ts) carries only the handshake — and, on a data
 * channel, the song's words and its clock, so the TV shows the lyrics big and in time. The sound stays on
 * the phone (the track plays where the singer is; a TV a few tenths of a second behind would echo it).
 *
 * One TV per phone: the link is a module singleton every stage attaches its picture to; the code is kept on
 * the device, so the next stage finds the TV again by itself until the singer disconnects it.
 */
import { signal } from '@preact/signals';
import type { LyricLine, PartPlan, TvLook, TvMessage, TvSignal } from '@singersvoice/protocol';
import type { CanvasTrack } from '../video/canvasTrack.ts';
import type { ShowRecorder } from '../video/showRecorder.ts';
import { api, controlUrl, serviceUrl } from './api.ts';
import { toast } from './toast.ts';

const CODE_KEY = 'sv.tv.code';
const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
/** The picture to the TV: a room's Wi-Fi carries this with room to spare; the TV draws it full-screen. */
const TV_BPS = 6_000_000;
/** How often the clock goes over (the TV runs it on between). */
const CLOCK_MS = 250;

export const readSavedTvCode = (): string => {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveTvCode = (code: string): void => {
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    /* no storage: the code lasts the page */
  }
};

export type TvLinkState = 'off' | 'connecting' | 'on';

/** The phone's end: claims the screen, sends it the picture, the words and the clock. */
export class TvLink {
  readonly state = signal<TvLinkState>('off');
  readonly code = signal(readSavedTvCode());
  readonly note = signal<string | null>(null);
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private es: EventSource | null = null;
  private phoneToken = '';
  private show: ShowRecorder | null = null;
  private keptDrawing = false;
  private track: CanvasTrack | null = null;
  private sender: RTCRtpSender | null = null;
  private song: Extract<TvMessage, { type: 'song' }> | null = null;
  private look: TvLook = 'both';
  private name = '';
  private clockAt = 0;
  private gen = 0;

  /** Whether a TV is remembered on this device (the stage connects to it by itself). */
  get remembered(): boolean {
    return Boolean(this.code.value);
  }

  /** Connect to the TV showing `code` (typed or scanned): claimed, remembered, and linked as soon as the TV answers. */
  async connect(code: string): Promise<void> {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (clean.length !== 4) throw new Error('The TV shows a code of four letters');
    this.close(false);
    const gen = ++this.gen;
    this.state.value = 'connecting';
    this.note.value = null;
    const r = await api.post('POST /tv/screens/:code/claim', `/tv/screens/${encodeURIComponent(clean)}/claim`);
    if (gen !== this.gen) return;
    this.code.value = r.code;
    this.phoneToken = r.phoneToken;
    saveTvCode(r.code);
    this.openEvents(gen);
    this.makePeer(gen);
  }

  /** The stage opened: the remembered TV, if any, is connected again (quietly — a TV that is gone is forgotten). */
  async autoConnect(): Promise<void> {
    const code = this.code.value;
    if (!code || this.state.value !== 'off' || !controlUrl.value) return;
    try {
      await this.connect(code);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/No TV shows that code|gone/i.test(msg)) this.forget();
      else this.note.value = msg;
      this.state.value = 'off';
    }
  }

  /** Disconnect: the TV shows its code again; the code is forgotten here too (`forget`), so no stage connects by itself. */
  disconnect(forget = true): void {
    const code = this.code.value;
    this.close(true);
    if (code) void api.post('POST /tv/screens/:code/release', `/tv/screens/${encodeURIComponent(code)}/release`).catch(() => undefined);
    if (forget) this.forget();
  }

  private forget(): void {
    this.code.value = '';
    saveTvCode('');
  }

  /** The stage's picture: its ShowRecorder's canvas goes to the TV from now (the one before, if any, is let go). */
  attach(show: ShowRecorder): void {
    if (this.show === show) return;
    this.detach();
    this.show = show;
    this.keptDrawing = show.keepDrawing;
    show.keepDrawing = true;
    show.startDrawing();
    this.track = show.takeTrack(show.fps);
    if (this.sender) void this.sender.replaceTrack(this.track.track).catch(() => undefined);
    else if (this.pc) this.addTrack();
  }

  /** The stage is gone: the TV keeps the link (the next stage attaches) but gets no picture meanwhile. */
  detach(show?: ShowRecorder): void {
    if (!this.show || (show && this.show !== show)) return;
    if (this.track) this.show.releaseTrack(this.track);
    this.show.keepDrawing = this.keptDrawing;
    if (!this.keptDrawing) this.show.stopDrawing();
    this.show = null;
    this.track = null;
    if (this.sender) void this.sender.replaceTrack(null).catch(() => undefined);
  }

  /** The song on the stage (its words, who sings what): kept, and sent to the TV at once and whenever it links. */
  setSong(song: { title: string; lines: LyricLine[]; singerCount: number; mySlot: number; plan: PartPlan } | null): void {
    this.song = song ? { type: 'song', ...song } : null;
    if (this.song) this.send(this.song);
  }

  /** Where the song is, several times a second (the stage's own clock); the TV runs it on between. */
  clock(tMs: number, playing: boolean, countdown: number | null): void {
    const now = performance.now();
    if (now - this.clockAt < CLOCK_MS && countdown === null) return;
    this.clockAt = now;
    this.send({ type: 'clock', tMs: Math.round(tMs), playing, countdown });
  }

  /** What the TV shows (Settings → TV), and whose stage it is. */
  setLook(look: TvLook, name: string): void {
    this.look = look;
    this.name = name;
    this.send({ type: 'look', look, name });
  }

  private send(m: TvMessage): void {
    if (this.dc?.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify(m));
    } catch {
      /* closing */
    }
  }

  private openEvents(gen: number): void {
    const code = this.code.value;
    const es = new EventSource(`${controlUrl.value}/tv/screens/${encodeURIComponent(code)}/events?side=phone&pt=${encodeURIComponent(this.phoneToken)}`);
    this.es = es;
    es.addEventListener('signal', (e) => {
      if (gen !== this.gen) return;
      try {
        const ev = JSON.parse((e as MessageEvent).data as string) as { data: TvSignal };
        void this.onSignal(ev.data, gen);
      } catch {
        /* not ours */
      }
    });
    es.addEventListener('closed', () => {
      if (gen !== this.gen) return;
      this.close(true);
      this.forget();
      this.note.value = 'The TV page was closed';
      toast('The TV page was closed', 'info');
    });
    es.onerror = () => {
      // 403 / 410: the screen is not ours any more (the TV reloaded, somebody else took it): off; a network blip: EventSource retries itself.
      if (gen !== this.gen) return;
      if (es.readyState === EventSource.CLOSED) {
        this.close(true);
        this.note.value = 'The TV is not showing your stage any more';
      }
    };
  }

  private makePeer(gen: number): void {
    const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    const dc = pc.createDataChannel('sv-tv', { ordered: true });
    this.dc = dc;
    dc.onopen = () => {
      if (gen !== this.gen) return;
      this.state.value = 'on';
      this.note.value = null;
      this.send({ type: 'look', look: this.look, name: this.name });
      if (this.song) this.send(this.song);
    };
    dc.onclose = () => {
      if (gen === this.gen && this.state.value === 'on') this.state.value = 'connecting';
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && gen === this.gen) void this.signal({ kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      if (gen !== this.gen) return;
      try {
        await pc.setLocalDescription();
        if (pc.localDescription && gen === this.gen) await this.signal({ kind: 'offer', sdp: pc.localDescription.sdp });
      } catch {
        /* the TV re-offers on its side when it comes */
      }
    };
    pc.onconnectionstatechange = () => {
      if (gen !== this.gen) return;
      if (pc.connectionState === 'failed') {
        // The TV went away mid-link, or the network changed: a fresh connection (the screen is still ours).
        this.closePeer();
        this.makePeer(gen);
      } else if (pc.connectionState === 'disconnected') this.state.value = 'connecting';
    };
    if (this.track) this.addTrack();
    else pc.addTransceiver('video', { direction: 'sendonly' }); // the stage's picture comes when a stage attaches
  }

  private addTrack(): void {
    if (!this.pc || !this.track) return;
    const t = this.pc.getTransceivers().find((x) => x.sender.track === null && x.receiver.track?.kind === 'video');
    if (t) {
      void t.sender.replaceTrack(this.track.track).catch(() => undefined);
      this.sender = t.sender;
    } else this.sender = this.pc.addTrack(this.track.track);
    const params = this.sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0]!.maxBitrate = TV_BPS;
    params.encodings[0]!.maxFramerate = 30;
    params.degradationPreference = 'balanced';
    void this.sender.setParameters(params).catch(() => undefined);
  }

  private async onSignal(s: TvSignal, gen: number): Promise<void> {
    const pc = this.pc;
    if (!pc || gen !== this.gen) return;
    try {
      if (s.kind === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
      else if (s.kind === 'ice') await pc.addIceCandidate(s.candidate as RTCIceCandidateInit);
      else if (s.kind === 'offer') {
        // The TV re-made its side (its page reloaded while the screen stayed ours): take its offer.
        await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        await pc.setLocalDescription();
        if (pc.localDescription) await this.signal({ kind: 'answer', sdp: pc.localDescription.sdp });
      } else if (s.kind === 'bye') {
        this.closePeer();
        this.state.value = 'connecting';
      }
    } catch {
      /* a stale candidate */
    }
  }

  private async signal(s: TvSignal): Promise<void> {
    const code = this.code.value;
    if (!code) return;
    try {
      await api.post('POST /tv/screens/:code/signal', `/tv/screens/${encodeURIComponent(code)}/signal`, s);
    } catch {
      /* the stream says when the TV is gone */
    }
  }

  private closePeer(): void {
    this.send({ type: 'bye' });
    this.dc?.close();
    this.dc = null;
    this.sender = null;
    this.pc?.close();
    this.pc = null;
  }

  private close(final: boolean): void {
    this.gen++;
    this.closePeer();
    this.es?.close();
    this.es = null;
    this.phoneToken = '';
    if (final) this.state.value = 'off';
  }
}

/** The one link of this device. */
export const tvLink = new TvLink();

// ---- the TV's end ----

export type TvScreenState = 'registering' | 'waiting' | 'claimed' | 'linked' | 'offline';

export class TvScreenClient {
  readonly state = signal<TvScreenState>('registering');
  readonly code = signal('');
  readonly name = signal('');
  readonly stream = signal<MediaStream | null>(null);
  /** Frames are flowing in the picture (a phone linked from Home sends a track with nothing in it yet). */
  readonly pictureLive = signal(false);
  readonly song = signal<Extract<TvMessage, { type: 'song' }> | null>(null);
  readonly look = signal<TvLook>('both');
  readonly tMs = signal(0);
  readonly countdown = signal<number | null>(null);
  readonly playing = signal(false);
  private token = '';
  private es: EventSource | null = null;
  private pc: RTCPeerConnection | null = null;
  private base: { tMs: number; at: number; playing: boolean } = { tMs: 0, at: 0, playing: false };
  private raf = 0;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  async start(): Promise<void> {
    this.stopped = false;
    await this.register();
    const tick = () => {
      if (this.stopped) return;
      const b = this.base;
      this.tMs.value = b.playing ? b.tMs + (performance.now() - b.at) : b.tMs;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.retry);
    this.es?.close();
    this.es = null;
    this.closePeer();
    if (this.code.value && this.token) {
      const url = serviceUrl(`/tv/screens/${encodeURIComponent(this.code.value)}/bye?tv=${encodeURIComponent(this.token)}`);
      try {
        navigator.sendBeacon?.(url) || void fetch(url, { method: 'POST', keepalive: true }).catch(() => undefined);
      } catch {
        /* leaving */
      }
    }
  }

  /** A new code from the service (a page just opened; a screen the service forgot). */
  private async register(): Promise<void> {
    this.state.value = 'registering';
    this.es?.close();
    this.es = null;
    this.closePeer();
    try {
      const r = await fetch(serviceUrl('/tv/screens'), { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { code, token } = (await r.json()) as { code: string; token: string };
      this.code.value = code;
      this.token = token;
      this.name.value = '';
      this.state.value = 'waiting';
      this.openEvents();
    } catch {
      this.state.value = 'offline';
      this.retry = setTimeout(() => void this.register(), 5000);
    }
  }

  private openEvents(): void {
    const es = new EventSource(serviceUrl(`/tv/screens/${encodeURIComponent(this.code.value)}/events?tv=${encodeURIComponent(this.token)}`));
    this.es = es;
    es.addEventListener('hello', (e) => {
      try {
        const h = JSON.parse((e as MessageEvent).data as string) as { claimedBy: string | null };
        if (h.claimedBy) {
          this.name.value = h.claimedBy;
          if (this.state.value === 'waiting') this.state.value = 'claimed';
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('claimed', (e) => {
      try {
        this.name.value = (JSON.parse((e as MessageEvent).data as string) as { name: string }).name;
      } catch {
        this.name.value = 'A singer';
      }
      if (this.state.value !== 'linked') this.state.value = 'claimed';
    });
    es.addEventListener('released', () => {
      this.closePeer();
      this.name.value = '';
      this.state.value = 'waiting';
    });
    es.addEventListener('closed', () => void this.register());
    es.addEventListener('signal', (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data as string) as { data: TvSignal };
        void this.onSignal(ev.data);
      } catch {
        /* not ours */
      }
    });
    es.onerror = () => {
      // The service forgot the screen (410) or is unreachable: a new code in a moment; a blip: EventSource retries.
      if (es.readyState === EventSource.CLOSED && !this.stopped) {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => void this.register(), 2000);
      }
    };
  }

  private async onSignal(s: TvSignal): Promise<void> {
    try {
      if (s.kind === 'offer') {
        this.closePeer();
        const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
        this.pc = pc;
        pc.ontrack = (e) => {
          const stream = e.streams[0] ?? new MediaStream([e.track]);
          this.stream.value = stream;
          const t = e.track;
          const live = () => {
            if (this.pc === pc) this.pictureLive.value = t.readyState === 'live' && !t.muted;
          };
          t.onmute = live;
          t.onunmute = live;
          t.onended = live;
          live();
        };
        pc.ondatachannel = (e) => {
          const dc = e.channel;
          dc.onmessage = (m) => this.onMessage(String(m.data));
          dc.onopen = () => {
            this.state.value = 'linked';
          };
          dc.onclose = () => {
            if (this.state.value === 'linked') this.state.value = 'claimed';
          };
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) void this.signal({ kind: 'ice', candidate: e.candidate.toJSON() });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            if (this.pc === pc) {
              this.stream.value = null;
              if (this.state.value === 'linked') this.state.value = 'claimed';
            }
          }
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        await pc.setLocalDescription();
        if (pc.localDescription) await this.signal({ kind: 'answer', sdp: pc.localDescription.sdp });
      } else if (s.kind === 'answer') await this.pc?.setRemoteDescription({ type: 'answer', sdp: s.sdp });
      else if (s.kind === 'ice') await this.pc?.addIceCandidate(s.candidate as RTCIceCandidateInit);
      else if (s.kind === 'bye') this.closePeer();
    } catch {
      /* a stale candidate */
    }
  }

  private onMessage(text: string): void {
    let m: TvMessage;
    try {
      m = JSON.parse(text) as TvMessage;
    } catch {
      return;
    }
    if (m.type === 'song') this.song.value = m;
    else if (m.type === 'clock') {
      this.base = { tMs: m.tMs, at: performance.now(), playing: m.playing };
      this.playing.value = m.playing;
      this.countdown.value = m.countdown;
    } else if (m.type === 'look') {
      this.look.value = m.look;
      if (m.name) this.name.value = m.name;
    } else if (m.type === 'bye') this.closePeer();
  }

  private async signal(s: TvSignal): Promise<void> {
    try {
      await fetch(serviceUrl(`/tv/screens/${encodeURIComponent(this.code.value)}/signal?tv=${encodeURIComponent(this.token)}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    } catch {
      /* the stream says when the phone is gone */
    }
  }

  private closePeer(): void {
    this.pc?.close();
    this.pc = null;
    this.stream.value = null;
    this.pictureLive.value = false;
    this.song.value = null;
    this.base = { tMs: 0, at: performance.now(), playing: false };
    this.countdown.value = null;
    if (this.state.value === 'linked') this.state.value = 'claimed';
  }
}
