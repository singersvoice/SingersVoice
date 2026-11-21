/**
 * Putting the voice on the beat (audio/sync.ts): the lag of what the microphone heard of the track is
 * found from the envelopes; a sync check's clicks are timed in a recording; nothing is "found" in noise.
 */
import { describe, expect, it } from 'vitest';
import { bleedOffset, clicksHeard, envelope, envelopeLag, lagIsClear } from '../src/audio/sync.ts';

const RATE = 48000;
/** A deterministic noise source. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
/** A "track": bursts of noise with a rhythm that is not regular (a song's hits), `seconds` long. */
function track(seconds: number, seed = 7): Float32Array {
  const r = rng(seed);
  const x = new Float32Array(Math.round(seconds * RATE));
  let t = 0.2;
  while (t < seconds) {
    const len = 0.05 + r() * 0.25;
    const amp = 0.2 + r() * 0.6;
    const a = Math.round(t * RATE);
    const b = Math.min(x.length, Math.round((t + len) * RATE));
    for (let i = a; i < b; i++) x[i] = amp * (r() * 2 - 1) * Math.exp(-((i - a) / RATE) * 8);
    t += len + 0.1 + r() * 0.5;
  }
  return x;
}
/** The track as a microphone heard it: `lagMs` later, quieter, under its own noise. */
function heard(x: Float32Array, lagMs: number, gain = 0.3, noise = 0.01, seed = 11): Float32Array {
  const r = rng(seed);
  const d = Math.round((lagMs / 1000) * RATE);
  const y = new Float32Array(x.length);
  for (let i = 0; i < y.length; i++) y[i] = (i >= d ? x[i - d]! * gain : 0) + noise * (r() * 2 - 1);
  return y;
}

describe('the lag between two envelopes', () => {
  it('finds how far a delayed, quieter, noisier copy lags the original, to a few milliseconds, with a clear peak', () => {
    const x = track(20);
    for (const lag of [0, 48, 137, 310]) {
      const y = heard(x, lag);
      const r = envelopeLag(envelope(x, RATE), envelope(y, RATE), 0);
      expect(Math.abs(r.lagMs - lag)).toBeLessThanOrEqual(5);
      expect(lagIsClear(r)).toBe(true);
    }
  });

  it('a nominal alignment is taken into account: the lag found is what the alignment was short by', () => {
    const x = track(20);
    const y = heard(x, 200);
    // The copy laid on the original as if it lagged 150 ms (the figures said 150: its sample 0 at −150 ms): 50 ms short.
    const r = envelopeLag(envelope(x, RATE), envelope(y, RATE), -Math.round(0.15 * 400));
    expect(Math.abs(r.lagMs - 50)).toBeLessThanOrEqual(5);
  });

  it('finds nothing clear in an unrelated signal', () => {
    const x = track(20, 1);
    const y = track(20, 2);
    const r = envelopeLag(envelope(x, RATE), envelope(y, RATE), 0);
    expect(lagIsClear(r)).toBe(false);
  });
});

describe('a take laid against its track', () => {
  it('says how far the voice lags beyond the figures, or nothing for a short take or an unrelated one', () => {
    const x = track(30);
    const mic = heard(x, 180, 0.25, 0.02);
    // The take: the recording started 2 s before the track (vocalOffsetMs −2000), the figures said 120 ms: 60 short.
    const pcm = new Float32Array(mic.length + 2 * RATE);
    pcm.set(mic, 2 * RATE);
    const found = bleedOffset(pcm, RATE, x, RATE, -2000 - 120);
    expect(found).not.toBeNull();
    expect(Math.abs(found!.shiftMs - 60)).toBeLessThanOrEqual(5);
    expect(bleedOffset(pcm.subarray(0, 4 * RATE), RATE, x, RATE, -2120)).toBeNull(); // too short to tell
    expect(bleedOffset(heard(track(30, 3), 180), RATE, x, RATE, 0)).toBeNull(); // another song
  });
});

describe("the sync check's clicks", () => {
  /** A recording: silence with the four clicks `lagMs` after they were sent, under a little noise. */
  function recording(sentMs: number[], lagMs: number, level = 0.3, noise = 0.003): Float32Array {
    const r = rng(5);
    const x = new Float32Array(3 * RATE);
    for (let i = 0; i < x.length; i++) x[i] = noise * (r() * 2 - 1);
    for (const s of sentMs) {
      const a = Math.round(((s + lagMs) / 1000) * RATE);
      for (let i = 0; i < 0.015 * RATE && a + i < x.length; i++) x[a + i]! += level * Math.sin((2 * Math.PI * 1000 * i) / RATE) * Math.min(1, i / 48);
    }
    return x;
  }
  const sent = [400, 900, 1400, 1900];

  it('times the clicks heard and gives the round trip, to a few milliseconds', () => {
    for (const lag of [12, 85, 230, 480]) {
      const r = clicksHeard(recording(sent, lag), RATE, sent);
      expect(r).not.toBeNull();
      expect(Math.abs(r!.roundTripMs - lag)).toBeLessThanOrEqual(5);
      expect(r!.lags).toHaveLength(4);
    }
  });

  it('hears nothing in a recording without clicks (headphones on), and nothing from one click alone', () => {
    expect(clicksHeard(recording([], 0), RATE, sent)).toBeNull();
    expect(clicksHeard(recording([400], 100), RATE, sent)).toBeNull();
  });
});
