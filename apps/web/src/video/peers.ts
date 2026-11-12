/**
 * Performer-to-performer video for a live meet: a WebRTC mesh between the singers on stage
 * (≤ 10), video only (singers never hear each other — Solo foldback — the mix is the session
 * container's job). Signalling rides on the SVT DB relay (`/meets/:id/signal`, polled), so no
 * socket server is needed; ICE servers come from `/ice` (STUN by default, TURN when deployed).
 *
 * "Perfect negotiation": the peer with the lexically smaller participantId is polite, so two
 * simultaneous offers never deadlock. Bitrate is capped per peer and scaled with the mesh size
 * so a phone on Wi‑Fi can carry a 10-singer stage.
 */
import type { IceServer, MeetSignal } from '@singersvoice/protocol';
import { api } from '../lib/api.ts';

export interface SignalChannel {
  sendSignal(to: string, type: MeetSignal['type'], data: unknown): Promise<void>;
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
  state: PeerState;
  restarts: number;
}

const POLL_CONNECTING_MS = 900;
const POLL_STEADY_MS = 2500;
const TOTAL_UPLINK_BPS = 1_600_000;

export class PerformerMesh {
  private peers = new Map<string, Peer>();
  private local: MediaStream | null = null;
  private iceServers: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private polling = false;
  onRemote: ((id: string, stream: MediaStream | null, state: PeerState) => void) | null = null;

  constructor(
    private channel: SignalChannel,
    readonly me: string,
  ) {}

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

  /** Reconcile the mesh with the performers currently on stage (excluding me). */
  setPeers(ids: string[]): void {
    const want = new Set(ids.filter((id) => id && id !== this.me));
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id, true);
    for (const id of want) if (!this.peers.has(id)) this.connect(id);
  }

  peerStates(): Record<string, PeerState> {
    const out: Record<string, PeerState> = {};
    for (const [id, p] of this.peers) out[id] = p.state;
    return out;
  }

  private connect(id: string): void {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[], bundlePolicy: 'max-bundle' });
    const peer: Peer = { id, pc, polite: this.me < id, makingOffer: false, ignoreOffer: false, stream: null, state: 'connecting', restarts: 0 };
    this.peers.set(id, peer);
    // Always have a video transceiver so the offer is the same whether or not our camera is ready.
    const track = this.local?.getVideoTracks()[0] ?? null;
    if (track && this.local) pc.addTrack(track, this.local);
    else pc.addTransceiver('video', { direction: 'sendrecv' });
    this.applyCaps(peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        await this.channel.sendSignal(id, 'offer', pc.localDescription);
      } catch {
        /* retried on the next negotiation */
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.channel.sendSignal(id, 'ice', e.candidate.toJSON()).catch(() => undefined);
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      peer.stream = stream;
      this.onRemote?.(id, stream, peer.state);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        peer.state = 'connected';
        peer.restarts = 0;
      } else if (s === 'failed') {
        peer.state = 'failed';
        if (peer.restarts++ < 3) pc.restartIce();
      } else if (s === 'disconnected' || s === 'connecting' || s === 'new') peer.state = 'connecting';
      this.onRemote?.(id, peer.stream, peer.state);
      this.schedule(0);
    };
  }

  private applyCaps(peer: Peer): void {
    const n = Math.max(1, this.peers.size);
    const maxBitrate = Math.max(150_000, Math.min(600_000, Math.round(TOTAL_UPLINK_BPS / n)));
    for (const s of peer.pc.getSenders()) {
      if (!s.track || s.track.kind !== 'video') continue;
      const params = s.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0]!.maxBitrate = maxBitrate;
      params.encodings[0]!.maxFramerate = 15;
      params.encodings[0]!.scaleResolutionDownBy = n > 4 ? 1.5 : 1;
      params.degradationPreference = 'maintain-framerate';
      void s.setParameters(params).catch(() => undefined);
    }
  }

  private drop(id: string, sayBye: boolean): void {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    if (sayBye) void this.channel.sendSignal(id, 'bye', {}).catch(() => undefined);
    p.pc.onnegotiationneeded = null;
    p.pc.onicecandidate = null;
    p.pc.ontrack = null;
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    this.onRemote?.(id, null, 'failed');
  }

  private async handle(sig: MeetSignal): Promise<void> {
    let peer = this.peers.get(sig.from);
    if (sig.type === 'bye') {
      if (peer) this.drop(sig.from, false);
      return;
    }
    if (!peer) {
      // A performer we have not reconciled yet (their slot arrived in a later poll): connect now.
      this.connect(sig.from);
      peer = this.peers.get(sig.from)!;
    }
    const pc = peer.pc;
    const data = JSON.parse(sig.data) as RTCSessionDescriptionInit | RTCIceCandidateInit;
    try {
      if (sig.type === 'offer' || sig.type === 'answer') {
        const desc = data as RTCSessionDescriptionInit;
        const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          await this.channel.sendSignal(sig.from, 'answer', pc.localDescription);
        }
      } else if (sig.type === 'ice') {
        try {
          await pc.addIceCandidate(data as RTCIceCandidateInit);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch {
      /* a bad signal never kills the mesh; ICE restart / next offer recovers */
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
    } catch {
      /* offline: try again next tick */
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  close(): void {
    this.running = false;
    clearTimeout(this.timer);
    for (const id of [...this.peers.keys()]) this.drop(id, true);
  }
}
