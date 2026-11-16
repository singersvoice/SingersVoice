/**
 * Crackle-free sound for the audience and the broadcast: the block resampler carries its place
 * across blocks (no seam), and the mix-out worklet plays pushed PCM as one continuous stream at
 * the device's rate, behind a cushion, silent (not noisy) when it runs dry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LinearResampler } from '../src/audio/resample.ts';

/** The biggest jump between neighbouring samples of a sine at `hz` sampled at `rate`. */
const maxJump = (x: Float32Array | number[]) => {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i]! - x[i - 1]!));
  return m;
};
const sine = (n: number, rate: number, hz: number, phase0 = 0) => Float32Array.from({ length: n }, (_, i) => Math.sin(phase0 + (2 * Math.PI * hz * i) / rate));

describe('LinearResampler', () => {
  it('44.1 → 48 kHz in 20 ms blocks is one continuous curve: no seam at a block edge', () => {
    const from = 44100;
    const to = 48000;
    const r = new LinearResampler(from, to);
    const hz = 440;
    const out: number[] = [];
    const block = Math.round(from / 50);
    for (let b = 0; b < 50; b++) out.push(...r.push(sine(block, from, hz, (2 * Math.PI * hz * b * block) / from)));
    // a 440 Hz sine at 48 kHz moves at most 2π·440/48000 ≈ 0.0576 per sample
    const ideal = (2 * Math.PI * hz) / to;
    expect(maxJump(out)).toBeLessThan(ideal * 1.05);
    expect(out.length).toBeGreaterThan(48000 * 0.99); // a second in, a second out
    expect(out.length).toBeLessThan(48000 * 1.01);
    // and it is the same sine: compare against the ideal at 48 kHz (a small lag from interpolation, the shape intact)
    const ref = sine(out.length, to, hz);
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i]! - ref[i]!));
    expect(err).toBeLessThan(0.02);
  });
  it('the same rate passes through untouched; 48 → 44.1 kHz works the other way', () => {
    const same = new LinearResampler(48000, 48000);
    const x = sine(960, 48000, 1000);
    expect(Array.from(same.push(x))).toEqual(Array.from(x));
    const down = new LinearResampler(48000, 44100);
    const out: number[] = [];
    for (let b = 0; b < 20; b++) out.push(...down.push(sine(960, 48000, 1000, (2 * Math.PI * 1000 * b * 960) / 48000)));
    expect(maxJump(out)).toBeLessThan(((2 * Math.PI * 1000) / 44100) * 1.05);
    expect(out.length).toBeGreaterThan(44100 * 0.4 * 0.99);
  });
});

/** The worklet, loaded with stand-ins for the AudioWorklet globals. */
function loadMixOut(rate: number) {
  const src = readFileSync(new URL('../public/worklets/mix-out.js', import.meta.url), 'utf8');
  let registered: new (o: unknown) => { process(i: unknown, o: Float32Array[][]): boolean; port: { onmessage: ((e: { data: unknown }) => void) | null } } = null!;
  const messages: unknown[] = [];
  class AudioWorkletProcessor {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (m: unknown) => messages.push(m),
    };
  }
  const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentTime', src);
  fn(AudioWorkletProcessor, (_n: string, c: typeof registered) => (registered = c), rate, 0);
  return { Processor: registered, messages };
}

describe("'sv-mix-out' worklet", () => {
  const push = (p: { port: { onmessage: ((e: { data: unknown }) => void) | null } }, data: Float32Array) => p.port.onmessage!({ data: { type: 'pcm', data } });
  const render = (p: { process(i: unknown, o: Float32Array[][]): boolean }, blocks: number) => {
    const out: number[] = [];
    for (let b = 0; b < blocks; b++) {
      const buf = new Float32Array(128);
      p.process([], [[buf]]);
      out.push(...buf);
    }
    return out;
  };

  it('waits for the cushion, then plays the pushed sound back to back without a seam', () => {
    const { Processor } = loadMixOut(48000);
    const p = new Processor({ processorOptions: { sampleRate: 48000, cushionFrames: 960 } });
    expect(render(p, 4).every((v) => v === 0)).toBe(true); // nothing queued: silence
    const hz = 1000;
    for (let b = 0; b < 10; b++) push(p, sine(960, 48000, hz, (2 * Math.PI * hz * b * 960) / 48000)); // ten 20 ms packets
    const out = render(p, 75); // 9600 frames: all of it
    const played = out.slice(0, 9600); // the cushion was there: sound from the first frame (the sine starts at 0, as the reference does)
    expect(maxJump(played)).toBeLessThan(((2 * Math.PI * hz) / 48000) * 1.05); // one curve through every packet edge
    const ref = sine(9600, 48000, hz);
    let err = 0;
    for (let i = 0; i < 9600; i++) err = Math.max(err, Math.abs(played[i]! - ref[i]!));
    expect(err).toBeLessThan(1e-5); // at the same rate the samples pass through exactly
  });

  it('resamples to the device rate in one piece (44.1 kHz device, 48 kHz sound): no seam between packets', () => {
    const { Processor } = loadMixOut(44100);
    const p = new Processor({ processorOptions: { sampleRate: 48000, cushionFrames: 960 } });
    const hz = 440;
    for (let b = 0; b < 25; b++) push(p, sine(960, 48000, hz, (2 * Math.PI * hz * b * 960) / 48000));
    const out = render(p, 150).slice(0, 19000);
    expect(maxJump(out)).toBeLessThan(((2 * Math.PI * hz) / 44100) * 1.05);
    const ref = sine(out.length, 44100, hz);
    let err = 0;
    for (let i = 0; i < out.length; i++) err = Math.max(err, Math.abs(out[i]! - ref[i]!));
    expect(err).toBeLessThan(0.02);
  });

  it('runs dry into silence, not noise, and starts again once the cushion is back; reports how far it played', () => {
    const { Processor, messages } = loadMixOut(48000);
    const p = new Processor({ processorOptions: { sampleRate: 48000, cushionFrames: 960 } });
    push(p, sine(960, 48000, 500));
    push(p, sine(960, 48000, 500, (2 * Math.PI * 500 * 960) / 48000));
    const out = render(p, 20); // 2560 frames asked, 1920 queued
    expect(out.slice(0, 1920).some((v) => v !== 0)).toBe(true);
    expect(out.slice(1920).every((v) => v === 0)).toBe(true); // dry: silence
    push(p, sine(500, 48000, 500));
    expect(render(p, 4).every((v) => v === 0)).toBe(true); // under the cushion: still waiting
    push(p, sine(500, 48000, 500));
    const again = render(p, 8);
    expect(again.some((v) => v !== 0)).toBe(true); // the cushion is back: sound again
    render(p, 40); // long enough for a progress report (one every tenth of a second)
    const pos = messages.filter((m) => (m as { type: string }).type === 'pos') as { consumed: number; playing: boolean }[];
    expect(pos.length).toBeGreaterThan(0);
    expect(pos[pos.length - 1]!.consumed).toBeGreaterThan(1920);
  });
});
