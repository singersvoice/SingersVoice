/**
 * Joining from the singer's side (lib/joins.ts): the layers a take is opened with (the ones it inherited and
 * its own, in stage order, with the cut-out's place on the show), the join a saved take records, and the
 * earlier singers' cut-outs held on the show's clock while a take runs.
 */
import type { JoinInvite, PerformanceManifest } from '@singersvoice/protocol';
import { describe, expect, it } from 'vitest';
import { fakeDom } from './helpers/fakeDom.ts';

const dom = fakeDom();
const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
const { JoinLayers, joinOfTake, layersOf } = await import('../src/lib/joins.ts');

const manifest = (over: Partial<PerformanceManifest>): PerformanceManifest =>
  ({ schema: 'singersvoice.performance.v2', performanceId: 'perf-1', mode: 'offline', state: 'kept', kind: 'show', createdAt: '2026-11-18T00:00:00Z', expiresAt: null, trackId: 'trk-1', trackTitle: 'Ammo', trackArtist: '', singerSlot: 1, meetId: null, durationMs: 180000, timeline: { startedAtEpochMs: 0, vocalOffsetMs: 0, videoOffsetMs: -270, cutoutOffsetMs: -20, latencyCompMs: 90, sampleRate: 48000 }, playback: { tempo: 1, keyShift: 0, backingGain: 0.85 }, fx: {} as PerformanceManifest['fx'], device: { userAgent: '', platform: '', headphones: null }, files: [], notes: '', ...over }) as PerformanceManifest;
const summary = { performanceId: 'perf-1', trackId: 'trk-1', trackTitle: 'Ammo', state: 'kept' as const, mode: 'offline' as const, kind: 'show' as const, durationMs: 180000, createdAt: '', expiresAt: null, ref: 'show00000001', hasVideo: true, cutout: { driveId: 'cut000000001', mimeType: 'video/webm', bytes: 5 } };
const invite: JoinInvite = { performanceId: 'perf-a', ownerUserId: 'g-a', ownerName: 'alice', registryId: 'r', trackTitle: 'Ammo', trackArtist: '', durationMs: 180000, show: { driveId: 'show00000001', mimeType: 'video/mp4', bytes: 1, link: '' }, offsetMs: -250, tempo: 1, layers: [{ slot: 1, displayName: 'alice', userId: 'g-a', cutout: { driveId: 'cut000000001', mimeType: 'video/webm', bytes: 5 }, atShowMs: 230 }], joinedFrom: null, createdAt: '', joins: 0 };

describe('the layers a take is opened with', () => {
  it("a solo take: its singer alone, the cut-out's frame 0 against the show's", () => {
    expect(layersOf(manifest({}), summary, { userId: 'g-a', displayName: 'alice' })).toEqual([{ slot: 1, displayName: 'alice', userId: 'g-a', cutout: { driveId: 'cut000000001', mimeType: 'video/webm', bytes: 5 }, atShowMs: 250 }]);
  });
  it('a joined take: the singers it inherited (already on its clock) and its own, in stage order; no cut-out when none was saved', () => {
    const joined = manifest({ singerSlot: 2, join: { fromPerformanceId: 'perf-a', fromOwnerName: 'alice', layers: [{ slot: 1, displayName: 'alice', userId: 'g-a', cutout: null, atShowMs: 620 }], offsetMs: -640, tempo: 1 } });
    const layers = layersOf(joined, { ...summary, cutout: undefined }, { userId: 'g-b', displayName: 'bob' });
    expect(layers.map((l) => `${l.slot}:${l.displayName}:${l.atShowMs}:${l.cutout ? 'cut' : 'none'}`)).toEqual(['1:alice:620:none', '2:bob:250:none']);
  });
  it("the join a saved take records: the invite's layers moved onto its clock, the song offset with them", () => {
    const j = joinOfTake(invite, { videoOffsetMs: -300, latencyCompMs: 90 });
    expect(j).toEqual({ fromPerformanceId: 'perf-a', fromOwnerName: 'alice', layers: [{ ...invite.layers[0], atShowMs: 620 }], offsetMs: -640, tempo: 1 });
  });
});

describe('the earlier singers on my stage while a take runs', () => {
  it("one performer per layer — a frame source for a cut-out, a name alone without one — held on the show's clock: still before the song, in step while it plays, paused with it", () => {
    const layers = new JoinLayers(
      [
        { slot: 1, displayName: 'Alice Singer', userId: 'g-a', cutout: { driveId: 'c', mimeType: 'video/webm', bytes: 1 }, atShowMs: 230 },
        { slot: 2, displayName: 'Bob', userId: 'g-b', cutout: null, atShowMs: 0 },
      ],
      new Map([[1, new Blob([new Uint8Array([1])], { type: 'video/webm' })]]),
    );
    expect(layers.performers.map((p) => `${p.id}:${p.slot}:${p.label}:${p.source.kind}`)).toEqual(['layer-1:1:Alice:frame', 'layer-2:2:Bob:none']);
    const video = dom.current.video;
    expect(video.muted).toBe(true);
    // Before the song: at its first frame, still.
    layers.sync(0, 350, false);
    expect(video.currentTime).toBe(0);
    // Five seconds in, the mix 350 ms behind: the cut-out at 5 − 0.35 − 0.23 s, playing.
    let played = 0;
    video.play = () => (played++, Promise.resolve());
    video.paused = true;
    layers.sync(5000, 350, true);
    expect(video.currentTime).toBeCloseTo(4.42, 3);
    expect(played).toBe(1);
    // In step already (the browser advanced it): no seek.
    video.paused = false;
    video.currentTime = 4.5;
    layers.sync(5100, 350, true);
    expect(video.currentTime).toBe(4.5);
    // Drifted: seeked back into step.
    video.currentTime = 4.0;
    layers.sync(5200, 350, true);
    expect(video.currentTime).toBeCloseTo(4.62, 3);
    // Paused with the song.
    let paused = 0;
    video.pause = () => (paused++, void (video.paused = true));
    layers.sync(5200, 350, false);
    expect(paused).toBe(1);
    layers.dispose();
  });
});
