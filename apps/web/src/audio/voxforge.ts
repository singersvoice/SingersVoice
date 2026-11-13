/**
 * VoxForge vocal chain on Web Audio (the browser twin of the JUCE plugin):
 * trim → pitch/auto-tune (worklet) → HPF → EQ (low · body · mid · presence · air) → compressor → parallel
 * "punch" compression → de-esser → exciter → saturation → chorus → stereo delay → reverb → rider →
 * safety (limiter + soft clip) → out.
 *
 * Everything runs on the audio thread in 128-frame blocks. The dynamics stages are our own
 * ('sv-dynamics': an honest makeup gain, no hidden lookahead — see dynamics.ts for what the browser's
 * node does instead), so the chain adds about 7 ms (the safety limiter's 1.5 ms lookahead and the two
 * oversampled shapers); every parallel path (the dry side of the punch compressor, the de-esser's low
 * band, the exciter's and saturation's dry paths) is delayed to meet its processed twin exactly, so
 * nothing comb-filters. Only the pitch stage holds one grain (~46 ms) while it is correcting.
 * The rider is the one stage steered from the main thread — a slow gain that only ever moves a few
 * dB per second, so a late timer costs nothing audible.
 */
import { totalSemitones, type VoxForgeParams } from '@singersvoice/protocol';
import { makeCompressor, safetyStage, SHAPER_LATENCY_FRAMES } from './dynamics.ts';

export interface VoxForgeChain {
  input: GainNode;
  output: GainNode;
  pitchNode: AudioWorkletNode | null;
  apply(p: VoxForgeParams): void;
  dispose(): void;
  /** The rider's current gain in dB (for meters / tests). */
  readonly riderDb: number;
  /** Frames the chain delays the voice by while the pitch stage is neutral. */
  readonly latencyFrames: number;
}

const dB = (v: number) => Math.pow(10, v / 20);
/**
 * Web Audio's lowpass / highpass take their Q in DECIBELS (a resonance), not as a quality factor:
 * a Butterworth section (Q 0.7071) is −3.01 dB there. Two in a row make a Linkwitz-Riley split.
 */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/** Where a sung vocal should sit (RMS): the rider steers every phrase toward this. */
const RIDER_TARGET_DB = -20;
/** Below this the rider holds still — room noise and breaths are not phrases. */
const RIDER_GATE_DB = -50;
const RIDER_MAX_CUT_DB = -6;
const RIDER_MAX_LIFT_DB = 12;
/** The parallel compressor's own makeup: the crushed copy lands around the dry vocal's level at full mix. */
const PUNCH_MAKEUP_DB = 16;
/** The vocal leaves the chain under this (dBFS): never a clipped sample on its way to the mesh or the recorder. */
const VOCAL_CEILING_DB = -3;

function saturationCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + drive * 24;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

function makeImpulse(ctx: BaseAudioContext, decaySeconds: number, size: number): AudioBuffer {
  const seconds = Math.min(5, Math.max(0.3, decaySeconds));
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  // Larger rooms: darker tail and a slower build-up of early energy.
  const dark = 0.15 + size * 0.6;
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 2.2 + size * 2) * Math.exp(-3 * t);
      const noise = Math.random() * 2 - 1;
      lp += (noise - lp) * (1 - dark);
      const build = Math.min(1, i / (rate * (0.005 + size * 0.03)));
      d[i] = lp * env * build;
    }
  }
  return ir;
}

/** A delay of exactly `frames` (the dry side of a parallel path, matched to its processed twin). */
function alignment(ctx: BaseAudioContext, frames: number): DelayNode {
  const d = ctx.createDelay(Math.max(0.01, (frames + 1) / ctx.sampleRate));
  d.delayTime.value = frames / ctx.sampleRate;
  return d;
}

export function createVoxForgeChain(ctx: BaseAudioContext, workletAvailable: boolean): VoxForgeChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  let pitchNode: AudioWorkletNode | null = null;
  if (workletAvailable) {
    try {
      pitchNode = new AudioWorkletNode(ctx, 'sv-pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    } catch {
      pitchNode = null;
    }
  }

  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.Q.value = BUTTERWORTH_Q_DB;
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const lm = ctx.createBiquadFilter(); // body: the 300 Hz region that makes a close mic boxy
  lm.type = 'peaking';
  lm.frequency.value = 300;
  lm.Q.value = 1.1;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1200;
  mid.Q.value = 1;
  const pres = ctx.createBiquadFilter(); // presence: where a voice cuts through a track (2–5 kHz, the singer's choice)
  pres.type = 'peaking';
  pres.frequency.value = 3200;
  pres.Q.value = 1.1;
  const hi = ctx.createBiquadFilter(); // air
  hi.type = 'highshelf';
  hi.frequency.value = 8000;

  const comp = makeCompressor(ctx, workletAvailable);
  const makeup = ctx.createGain();

  // Parallel ("New York") compression: the dry vocal plus a crushed copy underneath — soft phrases come
  // up, loud ones keep their transients, nothing sounds squashed. The dry side waits for the compressor.
  const pcIn = ctx.createGain();
  const pcComp = makeCompressor(ctx, workletAvailable);
  pcComp.set({ thresholdDb: -36, kneeDb: 10, ratio: 10, attackS: 0.002, releaseS: 0.09, makeupDb: PUNCH_MAKEUP_DB }, 0);
  const pcDryDelay = alignment(ctx, pcComp.latencyFrames);
  const pcDry = ctx.createGain();
  const pcWet = ctx.createGain();
  const pcOut = ctx.createGain();

  // De-esser: a Linkwitz-Riley split where the sibilance starts (4–9 kHz, the singer's choice; 6 kHz
  // by default so the presence region stays whole); the top band goes through a fast compressor of
  // its own, so an "s" is ducked for the few milliseconds it spikes and the rest of the voice is
  // untouched. The low band (and the bypass) wait for that compressor, so the two halves meet in time.
  const dsIn = ctx.createGain();
  const dsComp = makeCompressor(ctx, workletAvailable);
  const dsBypassDelay = alignment(ctx, dsComp.latencyFrames);
  const dsBypass = ctx.createGain();
  const dsLo1 = ctx.createBiquadFilter();
  const dsLo2 = ctx.createBiquadFilter();
  const dsHi1 = ctx.createBiquadFilter();
  const dsHi2 = ctx.createBiquadFilter();
  for (const f of [dsLo1, dsLo2]) {
    f.type = 'lowpass';
    f.frequency.value = 6000;
    f.Q.value = BUTTERWORTH_Q_DB;
  }
  for (const f of [dsHi1, dsHi2]) {
    f.type = 'highpass';
    f.frequency.value = 6000;
    f.Q.value = BUTTERWORTH_Q_DB;
  }
  const dsLoDelay = alignment(ctx, dsComp.latencyFrames);
  const dsLoGain = ctx.createGain();
  const dsHiGain = ctx.createGain();
  const dsOut = ctx.createGain();

  // Exciter: harmonics generated from the top of the voice (above 3 kHz) and blended in — the sparkle
  // and "air" of a studio chain, not a plain treble boost. The oversampled shaper is 128 frames late.
  const exIn = ctx.createGain();
  const exDryDelay = alignment(ctx, SHAPER_LATENCY_FRAMES['2x']);
  const exDry = ctx.createGain();
  const exHp = ctx.createBiquadFilter();
  exHp.type = 'highpass';
  exHp.frequency.value = 3000;
  exHp.Q.value = BUTTERWORTH_Q_DB;
  const exShaper = ctx.createWaveShaper();
  exShaper.oversample = '2x';
  exShaper.curve = saturationCurve(0.6);
  const exWet = ctx.createGain();
  const exOut = ctx.createGain();

  // Rider: a slow automatic level after the effects, steered from the main thread.
  const riderIn = ctx.createGain();
  const rider = ctx.createGain();
  const riderMeter = ctx.createAnalyser();
  riderMeter.fftSize = 2048;
  riderMeter.smoothingTimeConstant = 0;

  // Saturation (dry/wet)
  const satIn = ctx.createGain();
  const satDryDelay = alignment(ctx, SHAPER_LATENCY_FRAMES['2x']);
  const satDry = ctx.createGain();
  const satWet = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '2x';
  shaper.curve = saturationCurve(0.25);
  const satOut = ctx.createGain();

  // Chorus / doubler
  const chDry = ctx.createGain();
  const chWet = ctx.createGain();
  const chDelay = ctx.createDelay(0.1);
  chDelay.delayTime.value = 0.022;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  const lfoGain = ctx.createGain();
  lfo.connect(lfoGain).connect(chDelay.delayTime);
  lfo.start();
  const chOut = ctx.createGain();

  // Ping-pong stereo delay
  const dlDry = ctx.createGain();
  const dlWet = ctx.createGain();
  const dlL = ctx.createDelay(2);
  const dlR = ctx.createDelay(2);
  const fbL = ctx.createGain();
  const fbR = ctx.createGain();
  const panL = ctx.createStereoPanner();
  const panR = ctx.createStereoPanner();
  panL.pan.value = -0.6;
  panR.pan.value = 0.6;
  const dlOut = ctx.createGain();

  // Reverb
  const rvDry = ctx.createGain();
  const rvWet = ctx.createGain();
  const preDelay = ctx.createDelay(0.2);
  const conv = ctx.createConvolver();
  conv.normalize = true;
  conv.buffer = makeImpulse(ctx, 2.4, 0.4);

  // The way out: never a sample over the ceiling, whatever the preset and the singer do.
  const safety = safetyStage(ctx, workletAvailable, VOCAL_CEILING_DB);

  // ---- wiring ----
  let last: AudioNode = input;
  if (pitchNode) {
    last.connect(pitchNode);
    last = pitchNode;
  }
  last.connect(hpf).connect(low).connect(lm).connect(mid).connect(pres).connect(hi).connect(comp.input);
  comp.output.connect(makeup).connect(pcIn);
  pcIn.connect(pcDryDelay).connect(pcDry).connect(pcOut);
  pcIn.connect(pcComp.input);
  pcComp.output.connect(pcWet).connect(pcOut);
  pcOut.connect(dsIn);
  dsIn.connect(dsBypassDelay).connect(dsBypass).connect(dsOut);
  dsIn.connect(dsLo1).connect(dsLo2).connect(dsLoDelay).connect(dsLoGain).connect(dsOut);
  dsIn.connect(dsHi1).connect(dsHi2).connect(dsComp.input);
  dsComp.output.connect(dsHiGain).connect(dsOut);
  dsOut.connect(exIn);
  exIn.connect(exDryDelay).connect(exDry).connect(exOut);
  exIn.connect(exHp).connect(exShaper).connect(exWet).connect(exOut);
  exOut.connect(satIn);
  satIn.connect(satDryDelay).connect(satDry).connect(satOut);
  satIn.connect(shaper).connect(satWet).connect(satOut);
  satOut.connect(chDry).connect(chOut);
  satOut.connect(chDelay).connect(chWet).connect(chOut);
  chOut.connect(dlDry).connect(dlOut);
  chOut.connect(dlL);
  dlL.connect(fbL).connect(dlR);
  dlR.connect(fbR).connect(dlL);
  dlL.connect(panL).connect(dlWet);
  dlR.connect(panR).connect(dlWet);
  dlWet.connect(dlOut);
  dlOut.connect(rvDry).connect(riderIn);
  dlOut.connect(preDelay).connect(conv).connect(rvWet).connect(riderIn);
  riderIn.connect(rider).connect(safety.input);
  riderIn.connect(riderMeter);
  safety.output.connect(output);

  const latencyFrames = comp.latencyFrames + pcComp.latencyFrames + dsComp.latencyFrames + 2 * SHAPER_LATENCY_FRAMES['2x'] + safety.latencyFrames;

  let lastIrKey = '';
  let irTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- the rider: RMS every 50 ms; soft phrases lifted slowly, loud ones pulled down a little faster ----
  let riderOn = false;
  let riderLift = RIDER_MAX_LIFT_DB;
  let riderDb = 0;
  const meterBuf = new Float32Array(riderMeter.fftSize);
  const riderTimer = setInterval(() => {
    if (!riderOn) {
      if (riderDb !== 0) {
        riderDb = 0;
        rider.gain.setTargetAtTime(1, ctx.currentTime, 0.1);
      }
      return;
    }
    riderMeter.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i]! * meterBuf[i]!;
    const rms = 20 * Math.log10(Math.sqrt(sum / meterBuf.length) + 1e-9);
    if (rms < RIDER_GATE_DB) return; // nothing sung right now: hold the level
    const wanted = Math.max(RIDER_MAX_CUT_DB, Math.min(riderLift, RIDER_TARGET_DB - rms));
    // Up slowly (a phrase, not a syllable), down a little faster, never more than a few dB a second.
    const step = wanted > riderDb ? 0.35 : 0.6;
    riderDb += Math.max(-step, Math.min(step, wanted - riderDb));
    rider.gain.setTargetAtTime(dB(riderDb), ctx.currentTime, 0.08);
  }, 50);

  function apply(p: VoxForgeParams): void {
    const t = ctx.currentTime;
    const ramp = 0.03;
    input.gain.setTargetAtTime(dB(p.inGain), t, ramp);
    output.gain.setTargetAtTime(dB(p.outGain), t, ramp);

    if (pitchNode) {
      pitchNode.parameters.get('pitch')?.setValueAtTime(totalSemitones(p), t);
      pitchNode.parameters.get('autoStrength')?.setValueAtTime(p.pitchOn ? p.autoStr : 0, t);
      pitchNode.parameters.get('autoSpeed')?.setValueAtTime(p.autoSpeed, t);
    }

    hpf.frequency.setTargetAtTime(p.eqOn ? p.hpfHz : 20, t, ramp);
    low.gain.setTargetAtTime(p.eqOn ? p.eqLow : 0, t, ramp);
    lm.gain.setTargetAtTime(p.eqOn ? p.eqLm : 0, t, ramp);
    mid.gain.setTargetAtTime(p.eqOn ? p.eqMid : 0, t, ramp);
    pres.frequency.setTargetAtTime(p.presHz, t, ramp);
    pres.gain.setTargetAtTime(p.eqOn ? p.eqPres : 0, t, ramp);
    hi.gain.setTargetAtTime(p.eqOn ? p.eqHi : 0, t, ramp);

    comp.set({ thresholdDb: p.compOn ? p.cThr : 0, kneeDb: 6, ratio: p.compOn ? p.cRat : 1, attackS: p.cAtk / 1000, releaseS: p.cRel / 1000, makeupDb: 0 }, t);
    makeup.gain.setTargetAtTime(p.compOn ? dB(p.cMk) : 1, t, ramp);

    pcWet.gain.setTargetAtTime(p.pcOn ? p.pcMx * 0.8 : 0, t, ramp);
    pcDry.gain.setTargetAtTime(p.pcOn ? 1 - p.pcMx * 0.25 : 1, t, ramp);

    // De-ess: where the band starts, how early it is caught and how hard — only the spikes (an "s"
    // sits well above a vowel's top in this band), never the air of the voice itself.
    const dsActive = p.dsOn && p.dsAmt > 0;
    for (const f of [dsLo1, dsLo2, dsHi1, dsHi2]) f.frequency.setTargetAtTime(p.dsHz, t, ramp);
    dsBypass.gain.setTargetAtTime(dsActive ? 0 : 1, t, ramp);
    dsLoGain.gain.setTargetAtTime(dsActive ? 1 : 0, t, ramp);
    dsHiGain.gain.setTargetAtTime(dsActive ? 1 : 0, t, ramp);
    dsComp.set({ thresholdDb: dsActive ? -18 - p.dsAmt * 12 : 0, kneeDb: 4, ratio: dsActive ? 2.5 + p.dsAmt * 4.5 : 1, attackS: 0.0005, releaseS: 0.04, makeupDb: 0 }, t);

    exWet.gain.setTargetAtTime(p.exOn ? p.exAmt * 0.45 : 0, t, ramp);
    exDry.gain.setTargetAtTime(1, t, ramp);

    riderOn = p.rdOn && p.rdAmt > 0;
    riderLift = RIDER_MAX_LIFT_DB * Math.max(0, Math.min(1, p.rdAmt));

    shaper.curve = saturationCurve(p.satDr);
    satWet.gain.setTargetAtTime(p.satOn ? p.satMx : 0, t, ramp);
    satDry.gain.setTargetAtTime(p.satOn ? 1 - p.satMx * 0.5 : 1, t, ramp);

    lfo.frequency.setTargetAtTime(p.chRt, t, ramp);
    lfoGain.gain.setTargetAtTime(p.chOn ? p.chDp * 0.006 : 0, t, ramp);
    chWet.gain.setTargetAtTime(p.chOn ? p.chMx : 0, t, ramp);
    chDry.gain.setTargetAtTime(p.chOn ? 1 - p.chMx * 0.4 : 1, t, ramp);

    dlL.delayTime.setTargetAtTime(p.dlTm, t, ramp);
    dlR.delayTime.setTargetAtTime(p.dlTm, t, ramp);
    fbL.gain.setTargetAtTime(p.dlOn ? p.dlFb : 0, t, ramp);
    fbR.gain.setTargetAtTime(p.dlOn ? p.dlFb : 0, t, ramp);
    dlWet.gain.setTargetAtTime(p.dlOn ? p.dlMx : 0, t, ramp);

    preDelay.delayTime.setTargetAtTime(p.rvPd, t, ramp);
    rvWet.gain.setTargetAtTime(p.rvOn ? p.rvMx : 0, t, ramp);
    rvDry.gain.setTargetAtTime(p.rvOn ? 1 - p.rvMx * 0.3 : 1, t, ramp);
    const irKey = `${p.rvSz.toFixed(2)}|${p.rvDc.toFixed(1)}`;
    if (irKey !== lastIrKey) {
      lastIrKey = irKey;
      clearTimeout(irTimer);
      irTimer = setTimeout(() => {
        conv.buffer = makeImpulse(ctx, p.rvDc, p.rvSz);
      }, 150);
    }
  }

  function dispose(): void {
    clearInterval(riderTimer);
    clearTimeout(irTimer);
    try {
      lfo.stop();
    } catch {
      /* already stopped */
    }
    for (const n of [input, output, hpf, low, lm, mid, pres, hi, makeup, pcIn, pcDryDelay, pcDry, pcWet, pcOut, dsIn, dsBypassDelay, dsBypass, dsLo1, dsLo2, dsHi1, dsHi2, dsLoDelay, dsLoGain, dsHiGain, dsOut, exIn, exDryDelay, exDry, exHp, exShaper, exWet, exOut, riderIn, rider, riderMeter, satIn, satDryDelay, satDry, satWet, shaper, satOut, chDry, chWet, chDelay, chOut, dlDry, dlWet, dlL, dlR, fbL, fbR, panL, panR, dlOut, rvDry, rvWet, preDelay, conv, safety.output]) n.disconnect();
    for (const c of [comp, pcComp, dsComp, safety.limiter]) c.disconnect();
    pitchNode?.disconnect();
  }

  return {
    input,
    output,
    pitchNode,
    apply,
    dispose,
    latencyFrames,
    get riderDb() {
      return riderDb;
    },
  };
}
