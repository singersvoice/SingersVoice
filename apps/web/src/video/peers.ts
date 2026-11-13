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
 */
import type { IceServer, MeetSignal } from '@singersvoice/protocol';
import { api } from '../lib/api.ts';
import { fingerprintOf } from './sdp.ts';

export interface SignalChannel {
  /** false = the addressee is gone (left the meet). */
  sendSignal(to: string, type: MeetSignal['type'], data: unknown): Promise<boolean | void>;
  pollSignals(): Promise<MeetSignal[]>;
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
  /** Remote ICE candidates that arrived before the remote description (the relay may reorder them). */
  pendingIce: RTCIceCandidateInit[];
  /** When our offer went out (ms); an offer nobody answers is re-made. */
  offeredAt: number;
  /** When a dropped peer may be re-made (ms), so a dead link is retried with backoff instead of hammered. */
  retryAt: number;
}

const POLL_CONNECTING_MS = 900;
const POLL_STEADY_MS = 2500;
const TOTAL_UPLINK_BPS = 1_600_000;
/** A vocal over the mesh: Opus at 96 kbps (the browser's phone-call default is ~32 kbps and thins a singing voice). */
const VOCAL_BPS = 96_000;
/** An offer unanswered this long (a lost signal, a peer that reloaded) is made again from a fresh connection. */
const OFFER_TIMEOUT_MS = 9000;
/** A link that failed its ICE restarts is re-made after this long. */
const REMAKE_AFTER_MS = 4000;

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
  private localAudio: MediaStreamTrack | null = null;
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

  peerStates(): Record<string, PeerState> {
    const out: Record<string, PeerState> = {};
    for (const [id, p] of this.peers) out[id] = p.state;
    return out;
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
    const peer: Peer = { id, pc, polite: this.me < id, makingOffer: false, ignoreOffer: false, stream: null, tracks: new Set(), state: 'connecting', restarts: 0, inbound, wantsAudio: false, audio: null, sendChain: Promise.resolve(), pendingIce: [], offeredAt: 0, retryAt: 0 };
    this.peers.set(id, peer);
    // Always have a video transceiver so the offer is the same whether or not our camera is ready.
    const track = this.local?.getVideoTracks()[0] ?? null;
    if (track && this.local && !this.receiveOnly) pc.addTrack(track, this.local);
    else pc.addTransceiver('video', { direction: this.receiveOnly ? 'recvonly' : 'sendrecv' });
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
        await this.send(peer, 'offer', pc.localDescription);
      } catch {
        /* retried on the next negotiation (or re-made when the offer times out) */
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.send(peer, 'ice', e.candidate.toJSON());
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
    const n = Math.max(1, this.peers.size);
    const maxBitrate = Math.max(150_000, Math.min(600_000, Math.round(TOTAL_UPLINK_BPS / n)));
    for (const s of peer.pc.getSenders()) {
      if (!s.track) continue;
      const params = s.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if (s.track.kind === 'audio') {
        // The vocal goes out at music quality: a fixed, generous Opus bitrate, whatever the mesh size.
        params.encodings[0]!.maxBitrate = VOCAL_BPS;
      } else {
        params.encodings[0]!.maxBitrate = maxBitrate;
        params.encodings[0]!.maxFramerate = 15;
        params.encodings[0]!.scaleResolutionDownBy = n > 4 ? 1.5 : 1;
        params.degradationPreference = 'maintain-framerate';
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
      if (!unanswered && !dead) continue;
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
    const data = JSON.parse(sig.data) as RTCSessionDescriptionInit | RTCIceCandidateInit;
    if (peer && sig.type === 'offer' && peer.pc.remoteDescription && fingerprintOf((data as RTCSessionDescriptionInit).sdp) !== fingerprintOf(peer.pc.remoteDescription.sdp)) {
      // A new DTLS fingerprint means a new RTCPeerConnection on their side (reload, re-made link): mirror it.
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
          await this.send(peer, 'answer', pc.localDescription);
        }
        // Candidates that overtook the description in the relay.
        const queued = peer.pendingIce.splice(0);
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
    this.timer = setTimeout(() => void this.poll(), delayMs ?? (anyConnecting ? POLL_CONNECTING_MS : POLL_STEADY_MS));
  }

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
      this.schedule();
    }
  }

  /** Says goodbye to every peer; resolves once the goodbyes went out (so a session can leave after them). */
  close(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    return Promise.all([...this.peers.keys()].map((id) => this.drop(id, true))).then(() => undefined);
  }
}

