import { describe, expect, it } from 'vitest';
import { compressorLatencyFrames, compressorMakeupDb } from '../src/audio/dynamics.ts';
import { kWeighting, measureLoudness, MIX_TARGETS, normalizationDb } from '../src/audio/loudness.ts';

function sine(hz: number, dbfs: number, seconds: number, rate: number): Float32Array {
  const n = Math.round(seconds * rate);
  const a = Math.pow(10, dbfs / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

describe('loudness (BS.1770)', () => {
  it('reads a 1 kHz sine at −20 dBFS as −23 LUFS (mono) and −20 LUFS (the same in both channels)', () => {
    const s = sine(1000, -20, 5, 48000);
    expect(measureLoudness([s], 48000).lufs).toBeCloseTo(-23.0, 0);
    expect(Math.abs(measureLoudness([s], 48000).lufs + 23.0)).toBeLessThan(0.3);
    expect(Math.abs(measureLoudness([s, s], 48000).lufs + 20.0)).toBeLessThan(0.3);
    expect(measureLoudness([s], 48000).peakDb).toBeCloseTo(-20, 1);
  });

  it('gives the same answer at 44.1 kHz (the K-weighting is re-derived per sample rate)', () => {
    const a = measureLoudness([sine(1000, -20, 5, 48000)], 48000).lufs;
    const b = measureLoudness([sine(1000, -20, 5, 44100)], 44100).lufs;
    expect(Math.abs(a - b)).toBeLessThan(0.2);
    // The weighting rises with frequency: a 5 kHz tone reads louder than a 100 Hz one of the same level.
    const lo = measureLoudness([sine(100, -20, 5, 48000)], 48000).lufs;
    const hi = measureLoudness([sine(5000, -20, 5, 48000)], 48000).lufs;
    expect(hi - lo).toBeGreaterThan(3);
    const [shelf, hp] = kWeighting(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 4); // BS.1770's own 48 kHz table
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 5);
  });

  it('gates: a quiet tail does not drag the loudness of the sung part down', () => {
    const loud = sine(1000, -20, 4, 48000);
    const quiet = sine(1000, -60, 4, 48000);
    const both = new Float32Array(loud.length + quiet.length);
    both.set(loud, 0);
    both.set(quiet, loud.length);
    const l = measureLoudness([both], 48000).lufs;
    expect(Math.abs(l + 23.0)).toBeLessThan(0.5);
    // Without the relative gate the mean would sit about 3 dB lower.
  });

  it('is −Infinity for silence and normalises within the range', () => {
    const z = new Float32Array(48000);
    expect(measureLoudness([z], 48000).lufs).toBe(-Infinity);
    expect(normalizationDb(-Infinity, MIX_TARGETS.trackLufs)).toBe(0);
    expect(normalizationDb(-9, -19)).toBe(-10);
    expect(normalizationDb(-50, -19)).toBe(MIX_TARGETS.trackRangeDb);
    expect(normalizationDb(-19, -19)).toBe(0);
  });
});

describe('the browser compressor, as it really behaves', () => {
  it('reproduces the automatic makeup gain Chromium applies (measured with an OfflineAudioContext)', () => {
    expect(compressorMakeupDb(-20, 6, 3)).toBeCloseTo(6.93, 1);
    expect(compressorMakeupDb(-36, 10, 10)).toBeCloseTo(17.28, 1);
    expect(compressorMakeupDb(-30, 4, 6.5)).toBeCloseTo(14.46, 1);
    expect(compressorMakeupDb(-3, 0, 20)).toBeCloseTo(1.71, 1);
    expect(compressorMakeupDb(-20, 0, 3)).toBeCloseTo(8, 1);
    expect(compressorMakeupDb(0, 0, 1)).toBe(0);
  });

  it('has a 6 ms lookahead', () => {
    expect(compressorLatencyFrames(48000)).toBe(288);
    expect(compressorLatencyFrames(44100)).toBe(264);
  });
});
