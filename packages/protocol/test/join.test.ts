/**
 * Joining a performance (join.ts): the next slot on the stage, the song's time from the show's clock, where a
 * layer's cut-out should be while a take runs, and the clock arithmetic a joined take inherits by — a singer's
 * cut-out keeps its place on the song through every generation of joins.
 */
import { describe, expect, it } from 'vitest';
import { inheritLayers, inheritOffsetMs, joinPath, layerTimeS, MAX_LAYERS, nextSlot, ownLayerAt, singersLine, songTimeMs, type JoinLayer } from '../src/join.ts';

const layer = (slot: number, atShowMs: number, name = `singer${slot}`): JoinLayer => ({ slot, displayName: name, userId: `g-${slot}`, cutout: { driveId: `cut${slot}`, mimeType: 'video/webm', bytes: 1 }, atShowMs });

describe('joining a performance', () => {
  it('the next singer stands after the last one; ten is the stage', () => {
    expect(nextSlot([])).toBe(1);
    expect(nextSlot([layer(1, 0)])).toBe(2);
    expect(nextSlot([layer(2, 0)])).toBe(3); // a solo take sung as singer 2 leaves slot 1 empty: the row is in slot order
    expect(nextSlot([layer(1, 0), layer(3, 0)])).toBe(4);
    expect(nextSlot(Array.from({ length: MAX_LAYERS }, (_, i) => layer(i + 1, 0)))).toBe(0);
  });

  it("the song's time for the lyrics comes from the show's clock: its frame 0 on the song, and the pace it was sung at", () => {
    expect(songTimeMs(1000, { offsetMs: -250, tempo: 1 })).toBe(750);
    expect(songTimeMs(10000, { offsetMs: 0, tempo: 0.8 })).toBe(8000); // sung slower: ten seconds of show are eight of song
    expect(songTimeMs(10000, { offsetMs: 0, tempo: 0 })).toBe(10000); // an unknown pace is 1×
  });

  it("a layer's cut-out sits where the mix has the show — held back by the lag and the round trip — less its own start", () => {
    expect(layerTimeS(5000, 350, -120)).toBeCloseTo(4.77, 3);
    expect(layerTimeS(0, 350, -120)).toBeCloseTo(-0.23, 3); // before its first frame: the stage waits
  });

  it("the joiner's own layer: the cut-out's frame 0 against the show's (the recorders ran on one clock)", () => {
    expect(ownLayerAt({ cutoutOffsetMs: -20, videoOffsetMs: -270 })).toBe(250);
    expect(ownLayerAt({ videoOffsetMs: -270 })).toBe(270);
  });

  it('a joined show inherits every layer moved onto its own clock, and the song offset with it — a cut-out keeps its place on the song through two generations', () => {
    // alice's take: her show's frame 0 is 250 ms before the song; her cut-out started 20 ms before the song.
    const alice = { offsetMs: -250, tempo: 1, layers: [layer(1, 230, 'alice')] };
    // bob joins: his show's frame 0 fell 300 ms before HIS song (alice's show from 0); his round trip was 90 ms.
    const bob = { videoOffsetMs: -300, roundTripMs: 90 };
    const bobLayers = inheritLayers(alice.layers, bob);
    const bobOffset = inheritOffsetMs(alice, bob);
    expect(bobLayers).toEqual([{ ...alice.layers[0], atShowMs: 230 + 300 + 90 }]);
    expect(bobOffset).toBe(-250 - 300 - 90);
    // On alice's show, her cut-out's frame 0 is at song time songTimeMs(230, alice); on bob's, at songTimeMs(620, bobOffset): the same instant.
    expect(songTimeMs(bobLayers[0]!.atShowMs, { offsetMs: bobOffset, tempo: 1 })).toBe(songTimeMs(alice.layers[0]!.atShowMs, alice));
    // carol joins bob's: the same again, one generation down.
    const carol = { videoOffsetMs: -260, roundTripMs: 110 };
    const carolLayers = inheritLayers([...bobLayers, layer(2, -40, 'bob')], carol);
    const carolOffset = inheritOffsetMs({ offsetMs: bobOffset }, carol);
    expect(songTimeMs(carolLayers[0]!.atShowMs, { offsetMs: carolOffset, tempo: 1 })).toBe(songTimeMs(alice.layers[0]!.atShowMs, alice));
    expect(songTimeMs(carolLayers[1]!.atShowMs, { offsetMs: carolOffset, tempo: 1 })).toBe(songTimeMs(-40, { offsetMs: bobOffset, tempo: 1 }));
  });

  it('names and the link', () => {
    expect(singersLine([])).toBe('');
    expect(singersLine([layer(1, 0, 'Alice Singer')])).toBe('Alice');
    expect(singersLine([layer(1, 0, 'Alice Singer'), layer(2, 0, 'Bob')])).toBe('Alice & Bob');
    expect(singersLine([layer(1, 0, 'Alice'), layer(2, 0, 'Bob'), layer(3, 0, 'Carol')])).toBe('Alice, Bob & Carol');
    expect(joinPath('perf-1')).toBe('/studio/join/perf-1');
  });
});
