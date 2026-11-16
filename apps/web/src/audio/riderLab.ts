/**
 * The vocal rider, measured (tools/ci/rider-lab.mjs): the real `sv-leveler` worklet with the real
 * VOCAL_RIDER (or MIX_GUARD) settings on an OfflineAudioContext at 48 kHz, fed a synthetic
 * microphone — a steady hiss at one level, and over it a voice (harmonics on 180 Hz with a vibrato)
 * sung in phrases — and what comes out, measured in half-second windows, each marked as inside a
 * phrase, outside one, or across an edge. Not part of the app: bundled by the lab alone.
 */
import { leveler, MIX_GUARD, VOCAL_RIDER } from './mixBus.ts';

export interface RiderLabOptions {
  workletBase: string;
  seconds: number;
  /** The hiss's RMS (dBFS); -Infinity for a dead-silent microphone. */
  noiseDb: number;
  /** The voice's RMS (dBFS) while a phrase is sung; null for no voice at all. */
  voiceDb: number | null;
  /** Phrases: this long sung, this long silent, from `voiceFromS` on. */
  phraseOnS: number;
  phraseOffS: number;
  voiceFromS: number;
  config: 'vocal' | 'guard';
}

export interface RiderLabWindow {
  t: number;
  rms: number;
  /** 'on': the whole window inside a phrase; 'off': the whole window outside one; 'edge': across an edge. */
  voice: 'on' | 'off' | 'edge';
}

const RATE = 48000;
const WINDOW_S = 0.5;

const db = (rms: number) => 20 * Math.log10(rms + 1e-9);

/** Deterministic noise (an LCG), unit RMS. */
function noise(n: number): Float32Array {
  const out = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * Math.sqrt(3);
  }
  return out;
}

/** The test voice at unit RMS: five harmonics on 180 Hz, a 5.5 Hz vibrato (the same voice the live e2e's fake microphone sings). */
function voice(n: number): Float32Array {
  const out = new Float32Array(n);
  const amps = [1, 0.5, 0.33, 0.25, 0.2];
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (let h = 1; h <= 5; h++) v += amps[h - 1]! * Math.sin(2 * Math.PI * h * 180 * t + ((h * 0.012 * 180) / 5.5) * Math.sin(2 * Math.PI * 5.5 * t));
    out[i] = v;
    sq += v * v;
  }
  const k = 1 / Math.sqrt(sq / n);
  for (let i = 0; i < n; i++) out[i]! *= k;
  return out;
}

/** Whether second `t` is inside a phrase (`on`), and the phrase edges for the window marks. */
function phraseAt(o: RiderLabOptions, t: number): boolean {
  if (o.voiceDb === null || t < o.voiceFromS) return false;
  const period = o.phraseOnS + o.phraseOffS;
  return ((t - o.voiceFromS) % period) < o.phraseOnS;
}

export async function riderLab(o: RiderLabOptions): Promise<{ windows: RiderLabWindow[]; inputDb: { noise: number; voice: number | null } }> {
  const n = Math.round(o.seconds * RATE);
  const ctx = new OfflineAudioContext(1, n, RATE);
  await ctx.audioWorklet.addModule(`${o.workletBase}leveler.js`);
  const buf = ctx.createBuffer(1, n, RATE);
  const d = buf.getChannelData(0);
  const hiss = noise(n);
  const gNoise = o.noiseDb === -Infinity ? 0 : Math.pow(10, o.noiseDb / 20);
  for (let i = 0; i < n; i++) d[i] = hiss[i]! * gNoise;
  if (o.voiceDb !== null) {
    const v = voice(n);
    const gVoice = Math.pow(10, o.voiceDb / 20);
    const ramp = Math.round(0.02 * RATE); // 20 ms in and out of a phrase
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      if (!phraseAt(o, t)) continue;
      const period = o.phraseOnS + o.phraseOffS;
      const into = ((t - o.voiceFromS) % period) * RATE;
      const left = o.phraseOnS * RATE - into;
      const env = Math.min(1, into / ramp, left / ramp);
      d[i]! += v[i]! * gVoice * Math.max(0, env);
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const node = leveler(ctx, o.config === 'vocal' ? VOCAL_RIDER : MIX_GUARD);
  if (!node) throw new Error('the leveler worklet did not load');
  src.connect(node).connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  const out = rendered.getChannelData(0);
  const windows: RiderLabWindow[] = [];
  const w = Math.round(WINDOW_S * RATE);
  for (let a = 0; a + w <= out.length; a += w) {
    let sq = 0;
    for (let i = a; i < a + w; i++) sq += out[i]! * out[i]!;
    const t0 = a / RATE;
    const t1 = (a + w) / RATE;
    // Inside a phrase: every 10 ms of the window is sung (and not within the ramps); outside: none of it.
    let on = 0;
    let off = 0;
    for (let t = t0; t < t1; t += 0.01) (phraseAt(o, t) ? on++ : off++);
    const mark: RiderLabWindow['voice'] = off === 0 && on > 0 ? 'on' : on === 0 ? 'off' : 'edge';
    windows.push({ t: t0, rms: db(Math.sqrt(sq / w)), voice: mark });
  }
  return { windows, inputDb: { noise: o.noiseDb, voice: o.voiceDb } };
}

(window as unknown as { svRiderLab: typeof riderLab }).svRiderLab = riderLab;
