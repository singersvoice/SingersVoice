/**
 * Performer-to-performer links for a live meet: a WebRTC mesh between the singers on stage
 * (≤ 10) carrying each one's alpha-packed video and, when asked (`wantAudio`), their vocal — for
 * the saved show only: a vocal that arrives is never played, so singers never hear each other
 * (Solo foldback) and latency never pulls them apart. A publisher's show view receives both and
 * sends nothing. Signalling rides on the SVT DB relay (`/meets/:id/signal`, polled), so no
 * socket server is needed; ICE servers come from `/ice` (STUN by default, TURN when deployed).
 *
 * "Perfect negotiation": the peer with the lexically smaller participantId is polite, so two
 * simultaneous offers never deadlock. Bitrate is capped per peer and scaled with the mesh size
 * so a phone on Wi‑Fi can carry a 10-singer stage.
 *
 * Every link also carries a small data channel (`sv`, negotiated on both sides, so it never
 * renegotiates): a singer who changes something on stage — the background, the song, the
 * transport — tells the others and the show view over it, and they fetch the new state at once
 * rather than at their next poll. The service stays the source of truth; the channel only says "now".
 */
import type { IceServer, MeetSignal } from '@singersvoice/protocol';
import { api } from '../lib/api.ts';
import { PACK_WIDTH, singerLinkScale } from './enhance.ts';
import { fingerprintOf } from './sdp.ts';

export interface SignalChannel {
  /** false = the addressee is gone (left the meet). */
  sendSignal(to: string, type: MeetSignal['type'], data: unknown): Promise<boolean | void>;
  pollSignals(): Promise<MeetSignal[]>;
  /** The service pushes a word the moment a signal waits (`pollNow` is called then): the mesh's own polls are the safety net, at a relaxed pace. */
  readonly pushing?: boolean;
}

export type PeerState = 'connecting' | 'connected' | 'failed';

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  stream: MediaStream | null;
  /** Every remote video track seen on this connection; the live (unmuted) one is shown. */
  tracks: Set<MediaStreamTrack>;
  state: PeerState;
  restarts: number;
  /** Opened by the other side (a publisher's show view): kept until they say bye, not reconciled against the stage. */
  inbound: boolean;
  /** Their offer carried an audio line: they want my vocal (a publisher's show view, a singer recording the show). */
  wantsAudio: boolean;
  /** Their vocal, when this link carries it (a publisher, or a singer recording the show). */
  audio: MediaStream | null;
  /** Signals to this peer go out one after another, so an offer always lands in the relay before its ICE candidates. */
  sendChain: Promise<void>;
  /** Remote ICE candidates that arrived before the remote description (the relay may reorder them), each with its connection's name. */
  pendingIce: (RTCIceCandidateInit & { token?: string })[];
  /** When our offer went out (ms); an offer nobody answers is re-made. */
  offeredAt: number;
  /** When both descriptions were in place (ms) — a link that still has not connected STUCK_AFTER_MS later is re-made. */
  settledAt: number;
  /**
   * This RTCPeerConnection's own name, carried on every signal it sends, and the name of the one on
   * the other side (from their offer or answer). A link re-made on either side (a lost or late answer,
   * a reload) is a new name: a signal from or for an earlier connection — the answer to an offer we
   * gave up on, candidates for a connection they closed — is left alone, never applied to the new one.
   */
  token: string;
  remoteToken: string | null;
  /** When a dropped peer may be re-made (ms), so a dead link is retried with backoff instead of hammered. */
  retryAt: number;
  /** The small message channel of this link (null where the browser has none). */
  dc: RTCDataChannel | null;
  /** Their round trip (speakers out, microphone in), as they announced it over the channel; null until they did. */
  rtMs: number | null;
  /** The way here, measured on the link (half the round trip time, the jitter buffer, encode and decode); null until measured. */
  netMs: number | null;
  /** The last jitter-buffer counters read, for the recent average. */
  jb: { delay: number; count: number } | null;
  /** The hold applied to their voice and picture here (align.ts), ms. */
  playoutMs: number;
  /** How wide a picture they draw of us, as they announced it (0: the whole frame — the default, and every singer's). */
  wantWidth: number;
}

/** What travels over the mesh's message channel: "something changed, fetch the state", a singer's round trip (align.ts), and how wide a picture a device draws of us (enhance.ts). */
export type MeshMessage = { type: 'changed' } | { type: 'rt'; ms: number } | { type: 'want'; width: number };
/** Encode, decode and the capture pipeline, which the link's own statistics do not see (ms). */
const CODEC_MS = 30;
/** How often the links' latency is read (ms). */
const LATENCY_SAMPLE_MS = 2000;
/** The channel's negotiated id (the same on both sides of every link). */
const DC_ID = 1;

const POLL_CONNECTING_MS = 900;
const POLL_STEADY_MS = 2500;
/** With the service pushing a word for every signal, the polls are the safety net. */
const POLL_PUSHED_CONNECTING_MS = 2500;
const POLL_PUSHED_STEADY_MS = 6000;
/** A singer's whole video uplink, shared by their links to the other singers (a publisher's link gets its own, generous cap). */
const TOTAL_UPLINK_BPS = 2_400_000;
/** A publisher's link carries what goes out to the world — the whole packed frame (enhance.ts, 1440×960 from a computer): up to this, always. */
const PUBLISHER_BPS = 4_500_000;

/**
 * The video codecs in the order this device would send them: H.264 first — hardware-encoded on nearly every phone
 * and computer, so a 1440×960 packed frame costs the stage's device little and the picture stays steady — then
 * VP9, VP8, AV1 (software, heavy). The order is set on every video transceiver before the offer or the answer
 * (the answerer's order decides what both sides use). Null where the browser cannot say what it has.
 */
export function preferredVideoCodecs(): RTCRtpCodec[] | null {
  const caps = typeof RTCRtpSender !== 'undefined' && 'getCapabilities' in RTCRtpSender ? RTCRtpSender.getCapabilities('video') : null;
  if (!caps?.codecs.length) return null;
  const order = ['video/h264', 'video/vp9', 'video/vp8', 'video/av1'];
  const rank = (c: RTCRtpCodec): number => {
    const i = order.indexOf(c.mimeType.toLowerCase());
    return i < 0 ? order.length : i; // rtx, red, ulpfec and the rest keep their place after the codecs
  };
  return [...caps.codecs].sort((a, b) => rank(a) - rank(b));
}
/** A vocal over the mesh: Opus at 96 kbps (the browser's phone-call default is ~32 kbps and thins a singing voice). */
const VOCAL_BPS = 96_000;
/** An offer unanswered this long (a lost signal, a peer that reloaded) is made again from a fresh connection. */
const OFFER_TIMEOUT_MS = 12_000;
/** A link that failed its ICE restarts is re-made after this long. */
const REMAKE_AFTER_MS = 4000;
/** A link with both descriptions in place that has not connected this long later (candidates lost on either side) is re-made from scratch. */
const STUCK_AFTER_MS = 15_000;

export class PerformerMesh {
  private peers = new Map<string, Peer>();
  /** The performers currently on stage (from the last setPeers): the peers we re-connect to. */
  private wanted = new Set<string>();
  private local: MediaStream | null = null;
  private iceServers: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private polling = false;
  onRemote: ((id: string, stream: MediaStream | null, state: PeerState) => void) | null = null;
  /** A singer's vocal arrived / went away (on links that carry vocals: a publisher's, a recording singer's). */
  onRemoteAudio: ((id: string, stream: MediaStream | null) => void) | null = null;
  /** A message from a peer over the mesh (see `say`). */
  onMessage: ((from: string, message: MeshMessage) => void) | null = null;
  private localAudio: MediaStreamTrack | null = null;
  /** My round trip, announced to every peer when their channel opens (and again when it changes). */
  private roundTripMs: number | null = null;
  /** How wide a picture this device draws of the singers it receives (0: the whole frame), announced to every peer the same way — a Preview tile asks for a small one (enhance.ts). */
  private wantWidth: number | null = null;
  private latencyTimer: ReturnType<typeof setInterval> | undefined;
  /** A publisher's show view only receives (never sends a camera). */
  private readonly receiveOnly: boolean;
  /** Ask every singer for their vocal (and offer mine): the saved show needs the whole mix. */
  private readonly wantAudio: boolean;

  constructor(
    private channel: SignalChannel,
    readonly me: string,
    opts: { receiveOnly?: boolean; wantAudio?: boolean } = {},
  ) {
    this.receiveOnly = opts.receiveOnly ?? false;
    this.wantAudio = opts.wantAudio ?? false;
  }

  static supported(): boolean {
    return typeof RTCPeerConnection === 'function';
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await api.get('GET /ice', '/ice');
      if (r.iceServers?.length) this.iceServers = r.iceServers;
    } catch {
      /* STUN defaults */
    }
    this.schedule(0);
    clearInterval(this.latencyTimer);
    this.latencyTimer = setInterval(() => void this.sampleLatency(), LATENCY_SAMPLE_MS);
  }

  // ---- timing (align.ts): what each singer's voice arrives behind the shared clock by, and the hold applied to it ----

  /** My round trip (speakers out, microphone in): told to every linked peer now, and to each new link as it opens. */
  announceRoundTrip(ms: number): void {
    const v = Math.max(0, Math.round(ms));
    if (this.roundTripMs === v) return;
    this.roundTripMs = v;
    this.say({ type: 'rt', ms: v });
  }

  /** Tell every singer how wide a picture this device draws of them (0: the whole frame): their link scales the frame to it (`applyCaps`). */
  announceWant(width: number): void {
    const v = Math.max(0, Math.round(width));
    if (this.wantWidth === v) return;
    this.wantWidth = v;
    this.say({ type: 'want', width: v });
  }

  /** Every singer linked from the stage (never a publisher's view, which sends nothing): how far behind the shared clock their voice reaches this device before the hold applied here (null until known). */
  arrivals(): { id: string; arrivalMs: number | null }[] {
    return [...this.peers.values()].filter((p) => p.state === 'connected' && this.wanted.has(p.id)).map((p) => ({ id: p.id, arrivalMs: p.rtMs !== null && p.netMs !== null ? Math.max(0, p.rtMs + p.netMs - p.playoutMs) : null }));
  }

  /** What one peer's voice is held back by here (ms; 0 = nothing applied). */
  playoutDelay(id: string): number {
    return this.peers.get(id)?.playoutMs ?? 0;
  }

  /**
   * Hold a peer's voice and picture back by `ms` in the browser's own jitter buffer (`jitterBufferTarget`; the older
   * `playoutDelayHint` where that is all there is): the two stay together, and the sound is never bent — the buffer
   * simply plays out that much later.
   */
  setPlayoutDelay(id: string, ms: number): void {
    const p = this.peers.get(id);
    if (!p || !this.wanted.has(id)) return; // a singer's link alone: a publisher's view is never held

    const v = Math.max(0, Math.min(4000, Math.round(ms)));
    p.playoutMs = v;
    for (const r of p.pc.getReceivers()) {
      const rx = r as unknown as Record<string, unknown>;
      try {
        if ('jitterBufferTarget' in rx) rx.jitterBufferTarget = v;
        else if ('playoutDelayHint' in rx) rx.playoutDelayHint = v / 1000;
      } catch {
        /* a receiver that will not take it */
      }
    }
  }

  /** The way here on every link, from its statistics: half the round trip, the jitter buffer's recent average, encode and decode. */
  private async sampleLatency(): Promise<void> {
    for (const p of this.peers.values()) {
      if (p.state !== 'connected') continue;
      try {
        const stats = await p.pc.getStats();
        let rttMs: number | null = null;
        let jbDelay = 0;
        let jbCount = 0;
        const pairs = new Map<string, { currentRoundTripTime?: number; nominated?: boolean; state?: string }>();
        let selected: string | null = null;
        stats.forEach((r: { type: string; id: string; kind?: string; selectedCandidatePairId?: string; currentRoundTripTime?: number; nominated?: boolean; state?: string; jitterBufferDelay?: number; jitterBufferEmittedCount?: number }) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) selected = r.selectedCandidatePairId;
          if (r.type === 'candidate-pair') pairs.set(r.id, r);
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            jbDelay += r.jitterBufferDelay ?? 0;
            jbCount += r.jitterBufferEmittedCount ?? 0;
          }
        });
        const pair = (selected && pairs.get(selected)) ?? [...pairs.values()].find((c) => c.nominated && c.state === 'succeeded') ?? [...pairs.values()].find((c) => c.currentRoundTripTime !== undefined);
        if (pair?.currentRoundTripTime !== undefined) rttMs = pair.currentRoundTripTime * 1000;
        // The jitter buffer's delay over the last sample (the counters are lifetime sums), in ms per emitted sample.
        let jbMs: number | null = null;
        if (p.jb && jbCount > p.jb.count) jbMs = ((jbDelay - p.jb.delay) / (jbCount - p.jb.count)) * 1000;
        else if (!p.jb && jbCount > 0) jbMs = (jbDelay / jbCount) * 1000;
        p.jb = { delay: jbDelay, count: jbCount };
        if (rttMs !== null && jbMs !== null) p.netMs = Math.round(rttMs / 2 + jbMs + CODEC_MS);
        else if (rttMs !== null && p.netMs === null && p.audio === null) p.netMs = Math.round(rttMs / 2 + CODEC_MS); // no vocal on this link yet: the network alone
      } catch {
        /* stats unavailable */
      }
    }
  }

  /** The alpha-packed stream to send (replace at any time; null stops sending). */
  setLocalStream(stream: MediaStream | null): void {
    this.local = stream;
    const track = stream?.getVideoTracks()[0] ?? null;
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track?.kind === 'video' || (!s.track && p.pc.getTransceivers().some((t) => t.sender === s)));
      if (sender) void sender.replaceTrack(track).catch(() => undefined);
      else if (track && stream) p.pc.addTrack(track, stream);
      this.applyCaps(p);
    }
  }

  /**
   * My vocal (after FX) for the links that carry vocals — a publisher's show view, and singers
   * recording the show (who receive it, never play it). The sender slot already exists on those
   * links (an audio line in the offer), so this never renegotiates; null stops sending.
   */
  setLocalAudio(track: MediaStreamTrack | null): void {
    this.localAudio = track;
    for (const p of this.peers.values()) this.attachAudio(p);
  }

  private attachAudio(peer: Peer): void {
    const t = peer.pc.getTransceivers().find((x) => x.receiver.track?.kind === 'audio' || x.sender.track?.kind === 'audio');
    if (!t) return;
    void t.sender
      .replaceTrack(this.localAudio)
      .then(() => this.applyCaps(peer))
      .catch(() => undefined);
  }

  /** Reconcile the mesh with the performers currently on stage (excluding me); inbound peers stay. */
  setPeers(ids: string[]): void {
    const want = new Set(ids.filter((id) => id && id !== this.me));
    this.wanted = want;
    for (const [id, p] of [...this.peers]) if (!want.has(id) && !p.inbound) this.drop(id, true);
    for (const id of want) {
      const p = this.peers.get(id);
      if (p) p.inbound = false; // they offered first; from now on reconciled like any performer
      else this.connect(id, false);
    }
  }

  /**
   * Make the link to a performer again from scratch (a plain "Reconnect": their picture arrives but
   * stands still, or anything else that a fresh connection would settle). The other side treats the
   * fresh offer as a new connection of the same peer; a performer not on stage is left alone.
   */
  remake(id: string): void {
    if (!this.wanted.has(id) || !this.peers.has(id)) return;
    void this.drop(id, false);
    this.connect(id, false);
  }

  peerStates(): Record<string, PeerState> {
    const out: Record<string, PeerState> = {};
    for (const [id, p] of this.peers) out[id] = p.state;
    return out;
  }

  /** Tell every linked peer something, now (a link that is not up yet simply misses it: the poll covers that). Returns how many were told. */
  say(message: MeshMessage): number {
    const text = JSON.stringify(message);
    let told = 0;
    for (const p of this.peers.values()) {
      if (p.dc?.readyState !== 'open') continue;
      try {
        p.dc.send(text);
        told++;
      } catch {
        /* closing */
      }
    }
    return told;
  }

  /** Per-peer RTP counters (support / tests): frames sent & received, bytes, and the sender track state. */
  async stats(): Promise<Record<string, { framesSent: number; framesReceived: number; bytesSent: number; bytesReceived: number; audioBytesSent: number; audioBytesReceived: number; senderTrack: string; connection: string }>> {
    const out: Record<string, { framesSent: number; framesReceived: number; bytesSent: number; bytesReceived: number; audioBytesSent: number; audioBytesReceived: number; senderTrack: string; connection: string }> = {};
    for (const [id, p] of this.peers) {
      const row = { framesSent: 0, framesReceived: 0, bytesSent: 0, bytesReceived: 0, audioBytesSent: 0, audioBytesReceived: 0, senderTrack: '', connection: p.pc.connectionState };
      const t = p.pc.getSenders().find((s) => s.track)?.track;
      row.senderTrack = t ? `${t.readyState}${t.muted ? '/muted' : ''}${t.enabled ? '' : '/disabled'}` : 'none';
      try {
        const stats = await p.pc.getStats();
        stats.forEach((r: { type: string; kind?: string; framesSent?: number; framesDecoded?: number; bytesSent?: number; bytesReceived?: number }) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            row.framesSent += r.framesSent ?? 0;
            row.bytesSent += r.bytesSent ?? 0;
          }
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            row.framesReceived += r.framesDecoded ?? 0;
            row.bytesReceived += r.bytesReceived ?? 0;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') row.audioBytesSent += r.bytesSent ?? 0;
          if (r.type === 'inbound-rtp' && r.kind === 'audio') row.audioBytesReceived += r.bytesReceived ?? 0;
        });
      } catch {
        /* stats unavailable */
      }
      out[id] = row;
    }
    return out;
  }

  /** Send a signal to a peer, in order (an offer before the candidates that follow it). */
  private send(peer: Peer, type: MeetSignal['type'], data: unknown): Promise<void> {
    peer.sendChain = peer.sendChain
      .then(async () => {
        const delivered = await this.channel.sendSignal(peer.id, type, data);
        // They left the meet (a publisher view closed, a singer gone): forget the link.
        if (delivered === false && this.peers.get(peer.id) === peer) this.drop(peer.id, false);
      })
      .catch(() => undefined);
    return peer.sendChain;
  }

  private connect(id: string, inbound: boolean): void {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle' });
    const peer: Peer = { id, pc, polite: this.me < id, makingOffer: false, ignoreOffer: false, stream: null, tracks: new Set(), state: 'connecting', restarts: 0, inbound, wantsAudio: false, audio: null, sendChain: Promise.resolve(), pendingIce: [], offeredAt: 0, settledAt: 0, retryAt: 0, dc: null, token: Math.random().toString(36).slice(2, 10), remoteToken: null, rtMs: null, netMs: null, jb: null, playoutMs: 0, wantWidth: 0 };
    this.peers.set(id, peer);
    // The message channel, made before the first offer on both sides with the same id: part of the link from the start, never a renegotiation.
    try {
      const dc = pc.createDataChannel('sv', { negotiated: true, id: DC_ID, ordered: true });
      dc.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as MeshMessage;
          if (m && m.type === 'changed') this.onMessage?.(id, m);
          else if (m && m.type === 'rt' && Number.isFinite(Number(m.ms))) peer.rtMs = Math.max(0, Math.round(Number(m.ms)));
          else if (m && m.type === 'want' && Number.isFinite(Number(m.width))) {
            peer.wantWidth = Math.max(0, Math.min(4096, Math.round(Number(m.width))));
            this.applyCaps(peer); // the link scales to what they draw
          }
        } catch {
          /* not ours */
        }
      };
      dc.onopen = () => {
        try {
          if (this.roundTripMs !== null) dc.send(JSON.stringify({ type: 'rt', ms: this.roundTripMs } satisfies MeshMessage));
          if (this.wantWidth !== null) dc.send(JSON.stringify({ type: 'want', width: this.wantWidth } satisfies MeshMessage));
        } catch {
          /* closing */
        }
      };
      peer.dc = dc;
    } catch {
      peer.dc = null;
    }
    // Always have a video transceiver so the offer is the same whether or not our camera is ready.
    const track = this.local?.getVideoTracks()[0] ?? null;
    if (track && this.local && !this.receiveOnly) pc.addTrack(track, this.local);
    else pc.addTransceiver('video', { direction: this.receiveOnly ? 'recvonly' : 'sendrecv' });
    const codecs = preferredVideoCodecs();
    if (codecs) {
      for (const t of pc.getTransceivers()) {
        if (t.receiver.track?.kind !== 'video') continue;
        try {
          t.setCodecPreferences(codecs);
        } catch {
          /* a browser that cannot order them: its own order */
        }
      }
    }
    // A publisher asks every singer for their vocal (the broadcast mix); a singer recording the show
    // asks the others for theirs and offers their own — received for the recording, never played.
    if (this.receiveOnly) pc.addTransceiver('audio', { direction: 'recvonly' });
    else if (this.wantAudio) pc.addTransceiver(this.localAudio ?? 'audio', { direction: 'sendrecv' });
    this.applyCaps(peer);

    pc.onnegotiationneeded = async () => {
      // They opened this link (their offer is on its way, maybe behind an ICE candidate the relay let
      // overtake it): answer it rather than offering back, which would only be a glare to roll back.
      if (peer.inbound && !pc.remoteDescription) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        peer.offeredAt = Date.now();
        await this.send(peer, 'offer', { ...pc.localDescription!.toJSON(), token: peer.token });
      } catch {
        /* retried on the next negotiation (or re-made when the offer times out) */
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.send(peer, 'ice', { ...e.candidate.toJSON(), token: peer.token });
    };
    // Simultaneous offers can leave a connection with more than one video transceiver; only one of
    // them carries RTP. Show whichever remote track is actually live (unmuted), and follow changes.
    pc.ontrack = (e) => {
      const track = e.track;
      if (track.kind === 'audio') {
        peer.audio = new MediaStream([track]);
        this.onRemoteAudio?.(id, peer.audio);
        track.onended = () => {
          peer.audio = null;
          this.onRemoteAudio?.(id, null);
        };
        return;
      }
      peer.tracks.add(track);
      const update = () => {
        const live = [...peer.tracks].find((t) => t.readyState === 'live' && !t.muted) ?? [...peer.tracks].find((t) => t.readyState === 'live') ?? null;
        const current = peer.stream?.getVideoTracks()[0] ?? null;
        if (live === current) return;
        peer.stream = live ? new MediaStream([live]) : null;
        this.onRemote?.(id, peer.stream, peer.state);
      };
      track.onmute = update;
      track.onunmute = update;
      track.onended = () => {
        peer.tracks.delete(track);
        update();
      };
      update();
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        peer.state = 'connected';
        peer.restarts = 0;
        peer.settledAt = 0;
        this.applyCaps(peer); // negotiated now: the bitrate caps stick
      } else if (s === 'failed') {
        peer.state = 'failed';
        if (peer.restarts++ < 3) pc.restartIce();
        else if (peer.inbound && !this.wanted.has(id)) this.drop(id, false); // a publisher that went away; it re-offers if it returns
        else peer.retryAt = Date.now() + REMAKE_AFTER_MS; // a performer we want: re-made from scratch by heal()
      } else if (s === 'disconnected' || s === 'connecting' || s === 'new') peer.state = 'connecting';
      this.onRemote?.(id, peer.stream, peer.state);
      this.schedule(0);
    };
  }

  private applyCaps(peer: Peer): void {
    // Links to other singers share the uplink; a link to a publisher (someone we did not ask for — the show view) is the broadcast's source and gets the full
    // picture — unless it said it draws a small one (a Preview tile): then the frame is scaled to that, at a singer link's bitrate.
    const singers = Math.max(1, [...this.peers.keys()].filter((id) => this.wanted.has(id)).length);
    const publisher = !this.wanted.has(peer.id);
    const small = publisher && peer.wantWidth > 0 && peer.wantWidth < PACK_WIDTH;
    const maxBitrate = publisher && !small ? PUBLISHER_BPS : Math.max(300_000, Math.min(1_200_000, publisher ? 1_200_000 : Math.round(TOTAL_UPLINK_BPS / singers)));
    for (const s of peer.pc.getSenders()) {
      if (!s.track) continue;
      const params = s.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if (s.track.kind === 'audio') {
        // The vocal goes out at music quality: a fixed, generous Opus bitrate, whatever the mesh size.
        params.encodings[0]!.maxBitrate = VOCAL_BPS;
      } else {
        // The packed frame goes out at its full size (enhance.ts): a publisher's link gets the whole of it, a singer's is scaled down to the size their stage draws.
        params.encodings[0]!.maxBitrate = maxBitrate;
        params.encodings[0]!.maxFramerate = publisher ? 24 : 15;
        params.encodings[0]!.scaleResolutionDownBy = publisher ? (small ? Math.max(1, PACK_WIDTH / peer.wantWidth) : 1) : singerLinkScale(singers);
        // A publisher's link under a strained sender gives up resolution and frame rate by turns ('balanced'): a broadcast with a softer picture for a moment, never one that freezes.
        params.degradationPreference = publisher ? 'balanced' : 'maintain-framerate';
      }
      void s.setParameters(params).catch(() => undefined);
    }
  }

  /**
   * Self-healing: a lost signal (the relay is polled over the real internet), a peer that reloaded,
   * or a link that failed for good is recovered by making the connection again — the other side
   * treats the fresh offer as a renegotiation of the same peer.
   */
  private heal(): void {
    const now = Date.now();
    for (const [id, p] of [...this.peers]) {
      if (p.inbound || !this.wanted.has(id)) continue;
      const unanswered = p.pc.signalingState === 'have-local-offer' && p.offeredAt && now - p.offeredAt > OFFER_TIMEOUT_MS && p.pc.connectionState === 'new';
      const dead = p.state === 'failed' && p.retryAt && now >= p.retryAt;
      // Descriptions in place on both sides, and still no connection: a candidate lost on its way (a relay poll that missed it,
      // a side that gathered none) leaves ICE waiting for ever — a fresh connection (a new name, an offer the other side mirrors) does not.
      const stuck = p.pc.signalingState === 'stable' && p.settledAt && now - p.settledAt > STUCK_AFTER_MS && p.pc.connectionState !== 'connected' && p.state !== 'connected';
      if (!unanswered && !dead && !stuck) continue;
      this.drop(id, false);
      this.connect(id, false);
    }
  }

  private drop(id: string, sayBye: boolean): Promise<void> {
    const p = this.peers.get(id);
    if (!p) return Promise.resolve();
    this.peers.delete(id);
    const bye = sayBye ? Promise.resolve(this.channel.sendSignal(id, 'bye', {})).then(() => undefined, () => undefined) : Promise.resolve();
    p.pc.onnegotiationneeded = null;
    p.pc.onicecandidate = null;
    p.pc.ontrack = null;
    p.pc.onconnectionstatechange = null;
    if (p.dc) {
      p.dc.onmessage = null;
      p.dc.onopen = null;
    }
    p.pc.close();
    this.onRemote?.(id, null, 'failed');
    if (p.audio) this.onRemoteAudio?.(id, null);
    return bye;
  }

  private async handle(sig: MeetSignal): Promise<void> {
    let peer = this.peers.get(sig.from);
    if (sig.type === 'bye') {
      if (peer) this.drop(sig.from, false);
      return;
    }
    const data = JSON.parse(sig.data) as (RTCSessionDescriptionInit | RTCIceCandidateInit) & { token?: string; forToken?: string };
    // A signal from a connection they have since replaced, or an answer to an offer we gave up on and re-made
    // (its name is not the one we hold): left alone. Applying it would marry the new connection to a dead one, and
    // the two sides would re-make each other without end.
    if (peer && sig.type === 'answer' && data.forToken && data.forToken !== peer.token) return;
    if (peer && sig.type === 'ice' && data.token && peer.remoteToken && data.token !== peer.remoteToken) return;
    if (peer && sig.type === 'offer' && peer.pc.remoteDescription && (data.token && peer.remoteToken ? data.token !== peer.remoteToken : fingerprintOf((data as RTCSessionDescriptionInit).sdp) !== fingerprintOf(peer.pc.remoteDescription.sdp))) {
      // A new connection on their side (reload, re-made link — a new name, or a new DTLS fingerprint from an older build): mirror it.
      this.drop(sig.from, false);
      peer = undefined;
    }
    if (!peer) {
      // Someone we did not initiate: a performer whose slot arrives in a later poll, or a publisher's show view.
      this.connect(sig.from, !this.wanted.has(sig.from));
      peer = this.peers.get(sig.from)!;
    }
    const pc = peer.pc;
    try {
      if (sig.type === 'offer' || sig.type === 'answer') {
        const desc = data as RTCSessionDescriptionInit;
        const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (data.token) peer.remoteToken = data.token;
        if (desc.type === 'answer' && pc.connectionState !== 'connected') peer.settledAt = Date.now();
        if (desc.type === 'offer') {
          // Their offer asks for my vocal (a publisher, a singer recording the show): answer with a sending
          // audio line, fed when my mic is open — and ask for theirs back when I record the show too.
          const audioT = pc.getTransceivers().find((x) => x.receiver.track?.kind === 'audio');
          if (audioT && !this.receiveOnly) {
            peer.wantsAudio = true;
            audioT.direction = this.wantAudio ? 'sendrecv' : 'sendonly';
            if (this.localAudio)
              void audioT.sender
                .replaceTrack(this.localAudio)
                .then(() => this.applyCaps(peer!))
                .catch(() => undefined);
          }
          await pc.setLocalDescription();
          if (pc.connectionState !== 'connected') peer.settledAt = Date.now();
          await this.send(peer, 'answer', { ...pc.localDescription!.toJSON(), token: peer.token, forToken: data.token });
        }
        // Candidates that overtook the description in the relay (those of another connection of theirs left out).
        const queued = peer.pendingIce.splice(0).filter((c) => !c.token || !peer.remoteToken || c.token === peer.remoteToken);
        for (const c of queued) await pc.addIceCandidate(c).catch(() => undefined);
      } else if (sig.type === 'ice') {
        const c = data as RTCIceCandidateInit;
        if (!pc.remoteDescription) peer.pendingIce.push(c);
        else {
          try {
            await pc.addIceCandidate(c);
          } catch (e) {
            if (!peer.ignoreOffer) throw e;
          }
        }
      }
    } catch {
      /* a bad signal never kills the mesh; ICE restart / a re-made offer recovers */
    }
  }

  private schedule(delayMs?: number): void {
    clearTimeout(this.timer);
    if (!this.running) return;
    const anyConnecting = [...this.peers.values()].some((p) => p.state !== 'connected');
    const pushed = this.channel.pushing === true;
    this.timer = setTimeout(() => void this.poll(), delayMs ?? (anyConnecting ? (pushed ? POLL_PUSHED_CONNECTING_MS : POLL_CONNECTING_MS) : pushed ? POLL_PUSHED_STEADY_MS : POLL_STEADY_MS));
  }

  /** A signal waits (the service said so): poll now — once more right after, when a poll was already on its way. */
  pollNow(): void {
    if (!this.running) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    clearTimeout(this.timer);
    void this.poll();
  }

  private pollAgain = false;

  private async poll(): Promise<void> {
    if (this.polling || !this.running) return;
    this.polling = true;
    try {
      const signals = await this.channel.pollSignals();
      for (const s of signals) await this.handle(s);
      this.heal();
    } catch {
      /* offline: try again next tick */
    } finally {
      this.polling = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        this.schedule(0);
      } else this.schedule();
    }
  }

  /** Says goodbye to every peer; resolves once the goodbyes went out (so a session can leave after them). */
  close(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.latencyTimer);
    return Promise.all([...this.peers.keys()].map((id) => this.drop(id, true))).then(() => undefined);
  }
}

