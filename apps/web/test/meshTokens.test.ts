/**
 * Every connection in the mesh has a name, carried on every signal it sends: an answer to an offer
 * we gave up on (and re-made), or a candidate for a connection they closed, is left alone — never
 * applied to the new connection — and a new name on their offer means a new connection to mirror.
 * Before this, one late answer made the two sides re-make each other without end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.ts', () => ({ api: { get: async () => ({ iceServers: [] }) } }));
const { PerformerMesh } = await import('../src/video/peers.ts');

class FakePC {
  static made: FakePC[] = [];
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: ((e: { candidate: { toJSON(): object } | null }) => void) | null = null;
  ontrack: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  signalingState = 'stable';
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string; toJSON(): { type: string; sdp: string } } | null = null;
  remotes: { type: string; sdp: string }[] = [];
  candidates: unknown[] = [];
  closed = false;
  constructor() {
    FakePC.made.push(this);
  }
  createDataChannel(): { readyState: string; onmessage: null } {
    return { readyState: 'connecting', onmessage: null };
  }
  addTransceiver(): void {}
  addTrack(): void {}
  getSenders(): unknown[] {
    return [];
  }
  getTransceivers(): unknown[] {
    return [];
  }
  async setLocalDescription(): Promise<void> {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    const sdp = `v=0\na=fingerprint:sha-256 ${FakePC.made.indexOf(this)}\n`;
    this.localDescription = { type, sdp, toJSON: () => ({ type, sdp }) };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.remotes.push(d);
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: unknown): Promise<void> {
    this.candidates.push(c);
  }
  close(): void {
    this.closed = true;
  }
}

/** The relay as the mesh sees it: what each side sent, and signals the test hands back. */
function fakeChannel() {
  const sent: { to: string; type: string; data: Record<string, unknown> }[] = [];
  return {
    sent,
    sendSignal: async (to: string, type: string, data: unknown) => {
      sent.push({ to, type, data: data as Record<string, unknown> });
      return true;
    },
    pollSignals: async () => [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('mesh connection names', () => {
  beforeEach(() => {
    FakePC.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePC);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers carry the connection name; a stale answer (for an offer since re-made) is ignored, the right one applied', async () => {
    const ch = fakeChannel();
    const mesh = new PerformerMesh(ch, 'me');
    mesh.setPeers(['them']);
    const pc1 = FakePC.made[0]!;
    await pc1.onnegotiationneeded!();
    await flush();
    const offer1 = ch.sent.find((s) => s.type === 'offer')!;
    expect(typeof offer1.data.token).toBe('string');
    // The offer goes unanswered for too long: the link is re-made (a new connection, a new name).
    (mesh as unknown as { peers: Map<string, { offeredAt: number }> }).peers.get('them')!.offeredAt = Date.now() - 20_000;
    (mesh as unknown as { heal(): void }).heal();
    expect(pc1.closed).toBe(true);
    const pc2 = FakePC.made[1]!;
    await pc2.onnegotiationneeded!();
    await flush();
    const offer2 = ch.sent.filter((s) => s.type === 'offer')[1]!;
    expect(offer2.data.token).not.toBe(offer1.data.token);
    // Their late answer to the FIRST offer arrives: left alone. Their answer to the second: applied.
    const handle = (sig: { type: string; data: object }) => (mesh as unknown as { handle(s: unknown): Promise<void> }).handle({ seq: 1, from: 'them', type: sig.type, data: JSON.stringify(sig.data), sentAt: '' });
    pc2.signalingState = 'have-local-offer';
    await handle({ type: 'answer', data: { type: 'answer', sdp: 'v=0\na=fingerprint:sha-256 old\n', token: 'theirs-old', forToken: offer1.data.token } });
    expect(pc2.remotes).toHaveLength(0);
    await handle({ type: 'answer', data: { type: 'answer', sdp: 'v=0\na=fingerprint:sha-256 new\n', token: 'theirs-new', forToken: offer2.data.token } });
    expect(pc2.remotes).toHaveLength(1);
    // Candidates of their old connection are dropped; of the new one, added.
    await handle({ type: 'ice', data: { candidate: 'old', token: 'theirs-old' } });
    await handle({ type: 'ice', data: { candidate: 'new', token: 'theirs-new' } });
    expect(pc2.candidates.map((c) => (c as { candidate: string }).candidate)).toEqual(['new']);
    // A signal with no name (an older build) is taken as before.
    await handle({ type: 'ice', data: { candidate: 'untagged' } });
    expect(pc2.candidates).toHaveLength(2);
    expect(FakePC.made).toHaveLength(2); // nothing was re-made by the stale signals
  });

  it('an offer under a new name is a new connection on their side: mirrored, the old one closed', async () => {
    const ch = fakeChannel();
    const mesh = new PerformerMesh(ch, 'me');
    const handle = (sig: { type: string; data: object }) => (mesh as unknown as { handle(s: unknown): Promise<void> }).handle({ seq: 1, from: 'them', type: sig.type, data: JSON.stringify(sig.data), sentAt: '' });
    await handle({ type: 'offer', data: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 a\n', token: 't1' } });
    const pc1 = FakePC.made[0]!;
    expect(pc1.remotes).toHaveLength(1);
    expect(ch.sent.find((s) => s.type === 'answer')!.data.forToken).toBe('t1'); // the answer names the offer it answers
    await handle({ type: 'offer', data: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 a\n', token: 't1' } }); // the same connection offering again: kept
    expect(FakePC.made).toHaveLength(1);
    await handle({ type: 'offer', data: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 b\n', token: 't2' } }); // a new connection: mirrored
    expect(pc1.closed).toBe(true);
    expect(FakePC.made).toHaveLength(2);
    expect(FakePC.made[1]!.remotes[0]!.sdp).toContain('sha-256 b');
  });
});
