/**
 * The broadcast's segments (broadcast/liveCore.ts): the sound is the clock, the picture best effort — a segment goes out
 * with all of its sound and never a block out of order; a picture that stops is held (a keyframe asked for where the
 * sound is) and the stream runs on; a frame that comes late for a segment already out is left out; without sound,
 * or with the sound itself stalled, the wall clock keeps time.
 */
import { describe, expect, it } from 'vitest';
import { AAC_FRAME, AUDIO_RATE, AUDIO_STALL_US, LiveCore, STALL_GRACE_US, type CoreSegment } from '../src/broadcast/liveCore.ts';

const SEG = 1_000_000;
const FRAME_US = Math.round((AAC_FRAME * 1e6) / AUDIO_RATE); // 21333
const adts = () => new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 1, 2, 3]);
const nal = (key: boolean) => new Uint8Array(key ? [0, 0, 0, 1, 0x65, 1] : [0, 0, 0, 1, 0x41, 1]);

function make(audio = true) {
  const out: CoreSegment[] = [];
  const core = new LiveCore({ audio, segmentUs: SEG, run: 'r', onSegment: (s) => out.push(s) });
  return { core, out };
}
/** Feed sound from `fromUs` up to (not including) `toUs`, one AAC frame at a time, the wall clock alongside. */
function sound(core: LiveCore, fromUs: number, toUs: number) {
  for (let t = fromUs; t < toUs; t += FRAME_US) core.audioChunk(t, [adts()], t);
}
/** Video at 25 fps from `fromUs` to `toUs`, a keyframe every SEG. */
function video(core: LiveCore, fromUs: number, toUs: number) {
  for (let t = fromUs; t < toUs; t += 40_000) core.videoChunk(t, t % SEG === 0, nal(t % SEG === 0));
}

describe('LiveCore — segments cut by the sound', () => {
  it('a segment goes out once the sound has reached the next keyframe, with all of its sound, in order', () => {
    const { core, out } = make();
    video(core, 0, 2 * SEG + 1);
    expect(out).toHaveLength(0); // keyframes at 0, 1 s, 2 s are in, but no sound yet: nothing goes out
    sound(core, 0, SEG - 3 * FRAME_US);
    expect(out).toHaveLength(0); // the sound stops a few frames short of the second keyframe
    sound(core, SEG - 3 * FRAME_US, SEG + 3 * FRAME_US);
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect([s.fromUs, s.toUs, s.durationMs, s.name, s.audio]).toEqual([0, SEG, 1000, 'svr-0.ts', true]);
    expect(s.packets.filter((p) => p.kind === 'video')).toHaveLength(25);
    expect(s.packets[0]!.key).toBe(true);
    const audioTs = s.packets.filter((p) => p.kind === 'audio').map((p) => p.ts);
    expect(audioTs.length).toBeGreaterThan(8); // four frames a PES
    expect(audioTs.every((t) => t >= 0 && t < SEG)).toBe(true);
    expect([...audioTs].sort((a, b) => a - b)).toEqual(audioTs); // in order
    sound(core, SEG + 3 * FRAME_US, 2 * SEG + FRAME_US);
    expect(out).toHaveLength(2);
    expect(out[1]!.packets.filter((p) => p.kind === 'audio').every((p) => p.ts >= SEG && p.ts < 2 * SEG)).toBe(true); // nothing of the first segment's sound leaks into the second
  });

  it('sound that arrives late for a span holds that segment back rather than landing in the next one with an earlier stamp', () => {
    const { core, out } = make();
    video(core, 0, 3 * SEG + 1); // keyframes at 0, 1, 2, 3 s: the picture is well ahead
    expect(out).toHaveLength(0);
    sound(core, 0, 2 * SEG + FRAME_US); // the sound catches up two segments' worth in one go
    expect(out).toHaveLength(2);
    expect(out.map((s) => [s.fromUs, s.toUs])).toEqual([
      [0, SEG],
      [SEG, 2 * SEG],
    ]);
    for (const s of out) expect(s.packets.filter((p) => p.kind === 'audio').every((p) => p.ts >= s.fromUs && p.ts < s.toUs)).toBe(true);
  });

  it('a picture that stops: the segment is cut where the sound is, a keyframe is asked for there, and the stream runs on; late frames are left out', () => {
    const { core, out } = make();
    video(core, 0, 400_000); // the picture stops 0.4 s in
    sound(core, 0, SEG + 200_000);
    expect(core.tick(SEG + 200_000)).toBeNull(); // within the grace: still waiting for the next keyframe
    const askAt = SEG + STALL_GRACE_US + 2 * FRAME_US;
    sound(core, SEG + 200_000, askAt);
    const ask = core.tick(askAt);
    expect(ask).not.toBeNull();
    expect(ask!).toBeGreaterThanOrEqual(SEG + STALL_GRACE_US);
    expect(out).toHaveLength(1);
    expect(out[0]!.fromUs).toBe(0);
    expect(out[0]!.toUs).toBe(ask!); // cut where the sound is
    expect(out[0]!.durationMs).toBe(Math.round(ask! / 1000));
    expect(out[0]!.packets.filter((p) => p.kind === 'video')).toHaveLength(10); // the frames that came, nothing invented
    expect(core.stats.held).toBe(1);
    expect(core.tick(askAt + 1000)).toBeNull(); // asked once; not again until the clock ran a segment past it
    // The caller encodes its last picture as a keyframe at the instant asked for: the next segment begins there.
    core.videoChunk(ask!, true, nal(true));
    // Frames the stalled main thread hands over late, stamped inside the segment already out, are left out.
    core.videoChunk(600_000, false, nal(false));
    core.videoChunk(900_000, false, nal(false));
    expect(core.stats.lateVideo).toBe(2);
    // The picture comes back: a keyframe a segment after the held one; the sound reaches it; the held segment goes out.
    const nextKey = ask! + SEG;
    core.videoChunk(nextKey, true, nal(true));
    sound(core, askAt, nextKey + FRAME_US);
    expect(out).toHaveLength(2);
    expect([out[1]!.fromUs, out[1]!.toUs]).toEqual([ask!, nextKey]);
    expect(out[1]!.packets.filter((p) => p.kind === 'video')).toHaveLength(1); // the held picture alone
    expect(out[1]!.packets.filter((p) => p.kind === 'audio').every((p) => p.ts >= ask! && p.ts < nextKey)).toBe(true);
    expect(out[1]!.packets.every((p) => p.ts >= out[0]!.toUs)).toBe(true); // never a stamp going backwards across segments
  });

  it('without sound the wall clock keeps time: segments at the keyframes, and a stalled picture held by the wall', () => {
    const { core, out } = make(false);
    video(core, 0, SEG + 1);
    expect(out).toHaveLength(1); // the second keyframe closes the first segment at once
    expect(out[0]!.audio).toBe(false);
    expect(core.tick(SEG + 500_000)).toBeNull();
    const ask = core.tick(2 * SEG + STALL_GRACE_US + 1);
    expect(ask).toBe(2 * SEG + STALL_GRACE_US + 1);
    expect(out).toHaveLength(2);
    expect([out[1]!.fromUs, out[1]!.toUs]).toEqual([SEG, ask!]);
  });

  it('sound that itself stops coming hands the clock to the wall: the picture is not held hostage to a dead tap', () => {
    const { core, out } = make();
    video(core, 0, 3 * SEG + 1);
    sound(core, 0, 500_000); // the sound stops half a second in
    const lastWall = Math.floor((500_000 - 1) / FRAME_US) * FRAME_US; // the wall clock at the last block
    expect(out).toHaveLength(0); // waiting for the sound
    core.tick(lastWall + AUDIO_STALL_US - 1000);
    expect(out).toHaveLength(0);
    core.tick(lastWall + AUDIO_STALL_US + 1000); // the sound has been silent for AUDIO_STALL_US of wall time
    expect(out.length).toBeGreaterThanOrEqual(2); // the segments go out on their keyframes, the sound they have with them
  });

  it("the sound's stamps are its own: counted from the first block, however the encoder stamps its chunks", () => {
    const { core, out } = make();
    video(core, 0, SEG + 1);
    // An encoder that stamps every chunk 0 (a browser that does not stamp): the timeline still runs.
    for (let i = 0; i < 50; i++) core.audioChunk(0, [adts()], i * FRAME_US);
    expect(core.audioEndUs).toBe(Math.round((50 * AAC_FRAME * 1e6) / AUDIO_RATE));
    expect(core.stats.audioTimestampsOff).toBeGreaterThan(0);
    expect(out).toHaveLength(1);
    const ts = out[0]!.packets.filter((p) => p.kind === 'audio').map((p) => p.ts);
    expect(new Set(ts).size).toBe(ts.length); // every PES its own stamp
  });
});
