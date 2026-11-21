/**
 * The mesh's message channel: every link gets a negotiated data channel before its first offer;
 * `say` tells every open link; a "changed" message from a peer reaches `onMessage` — the path by
 * which a change on one singer's device reaches the others and the show view at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mesh asks the service for ICE servers when it starts; the api module itself wants a browser (localStorage).
vi.mock('../src/lib/api.ts', () => ({ api: { get: async () => ({ iceServers: [] }) } }));
const { PerformerMesh } = await import('../src/video/peers.ts');
const { PACK_WIDTH } = await import('../src/video/enhance.ts');
type MeshMessage = import('../src/video/peers.ts').MeshMessage;

class FakeChannel {
  readyState = 'connecting';
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit,
  ) {}
  send(text: string): void {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(text);
  }
}

class FakePC {
  static made: FakePC[] = [];
  channels: FakeChannel[] = [];
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: (() => void) | null = null;
  ontrack: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  signalingState = 'stable';
  remoteDescription = null;
  constructor() {
    FakePC.made.push(this);
  }
  createDataChannel(label: string, init: RTCDataChannelInit): FakeChannel {
    const c = new FakeChannel(label, init);
    this.channels.push(c);
    return c;
  }
  addTransceiver(): void {}
  addTrack(): void {}
  getSenders(): unknown[] {
    return [];
  }
  getTransceivers(): unknown[] {
    return [];
  }
  close(): void {}
}

describe('mesh messages', () => {
  beforeEach(() => {
    FakePC.made = [];
    vi.stubGlobal('RTCPeerConnection', FakePC);
  });
  afterEach(() => vi.unstubAllGlobals());

  const channel = { sendSignal: async () => true, pollSignals: async () => [] };

  it('every link carries one negotiated channel from the start; say reaches the open ones; a peer message comes through', () => {
    const mesh = new PerformerMesh(channel, 'me');
    const heard: { from: string; m: MeshMessage }[] = [];
    mesh.onMessage = (from, m) => heard.push({ from, m });
    mesh.setPeers(['p1', 'p2']);
    expect(FakePC.made).toHaveLength(2);
    for (const pc of FakePC.made) {
      expect(pc.channels).toHaveLength(1);
      expect(pc.channels[0]!.label).toBe('sv');
      expect(pc.channels[0]!.init).toMatchObject({ negotiated: true, id: 1 }); // the same id on both sides: no renegotiation, ever
    }
    // nothing open yet: nobody is told, nothing throws
    expect(mesh.say({ type: 'changed' })).toBe(0);
    FakePC.made[0]!.channels[0]!.readyState = 'open';
    expect(mesh.say({ type: 'changed' })).toBe(1);
    expect(FakePC.made[0]!.channels[0]!.sent).toEqual(['{"type":"changed"}']);
    expect(FakePC.made[1]!.channels[0]!.sent).toEqual([]);
    // a peer says something changed
    FakePC.made[1]!.channels[0]!.onmessage!({ data: '{"type":"changed"}' });
    FakePC.made[1]!.channels[0]!.onmessage!({ data: 'not json' }); // ignored
    FakePC.made[1]!.channels[0]!.onmessage!({ data: '{"type":"other"}' }); // not ours: ignored
    expect(heard).toEqual([{ from: 'p2', m: { type: 'changed' } }]);
  });

  it("a device says how wide a picture it draws of us: told to every open link now and to each new one as it opens; what a peer said is kept on its link and its sender's encoding follows (a small frame for a Preview tile, the whole one for a show view)", () => {
    const mesh = new PerformerMesh(channel, 'me');
    mesh.setPeers(['p1']);
    const p1 = FakePC.made[0]!;
    // Nothing open: the width is remembered and said when the channel opens.
    mesh.announceWant(320);
    expect(p1.channels[0]!.sent).toEqual([]);
    p1.channels[0]!.readyState = 'open';
    (p1.channels[0] as unknown as { onopen: () => void }).onopen();
    expect(p1.channels[0]!.sent).toEqual(['{"type":"want","width":320}']);
    mesh.announceWant(320); // the same again: nothing said
    expect(p1.channels[0]!.sent).toHaveLength(1);
    mesh.announceWant(0);
    expect(p1.channels[0]!.sent.at(-1)).toBe('{"type":"want","width":0}');
    // A publisher's view (a peer we did not ask for) tells us it draws a small picture: its sender is scaled to it.
    const params = { encodings: [{}] as Record<string, unknown>[], degradationPreference: '' };
    let applied: typeof params | null = null;
    const sender = { track: { kind: 'video' }, getParameters: () => params, setParameters: async (p: typeof params) => void (applied = p) };
    const viewer = new (class extends FakePC {
      override getSenders() {
        return [sender];
      }
    })();
    const inbound = mesh as unknown as { connect: (id: string, inbound: boolean) => void };
    vi.stubGlobal('RTCPeerConnection', class { constructor() { return viewer; } });
    inbound.connect('show-view', true);
    viewer.channels[0]!.onmessage!({ data: '{"type":"want","width":160}' });
    expect(applied).not.toBeNull();
    expect((applied!.encodings[0] as { scaleResolutionDownBy: number }).scaleResolutionDownBy).toBe(PACK_WIDTH / 160); // the packed frame scaled to what they draw
    expect((applied!.encodings[0] as { maxBitrate: number }).maxBitrate).toBeLessThanOrEqual(1_200_000);
    viewer.channels[0]!.onmessage!({ data: '{"type":"want","width":0}' }); // the whole frame: the show view
    expect((applied!.encodings[0] as { scaleResolutionDownBy: number }).scaleResolutionDownBy).toBe(1);
    expect((applied!.encodings[0] as { maxBitrate: number }).maxBitrate).toBe(4_500_000);
  });
});
