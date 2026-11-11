/**
 * VoxForge vocal chain on Web Audio (the browser twin of the JUCE plugin):
 * trim → pitch/auto-tune (worklet) → HPF → 3-band EQ → compressor → saturation → chorus → stereo delay → reverb → out.
 */
import { totalSemitones, type VoxForgeParams } from '@singersvoice/protocol';

export interface VoxForgeChain {
  input: GainNode;
  output: GainNode;
  pitchNode: AudioWorkletNode | null;
  apply(p: VoxForgeParams): void;
  dispose(): void;
}

const dB = (v: number) => Math.pow(10, v / 20);

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

export function createVoxForgeChain(ctx: AudioContext, workletAvailable: boolean): VoxForgeChain {
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
  hpf.Q.value = 0.7;
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1200;
  mid.Q.value = 1;
  const hi = ctx.createBiquadFilter();
  hi.type = 'highshelf';
  hi.frequency.value = 6500;

  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6;
  const makeup = ctx.createGain();

  // Saturation (dry/wet)
  const satIn = ctx.createGain();
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

  // ---- wiring ----
  let last: AudioNode = input;
  if (pitchNode) {
    last.connect(pitchNode);
    last = pitchNode;
  }
  last.connect(hpf).connect(low).connect(mid).connect(hi).connect(comp).connect(makeup).connect(satIn);
  satIn.connect(satDry).connect(satOut);
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
  dlOut.connect(rvDry).connect(output);
  dlOut.connect(preDelay).connect(conv).connect(rvWet).connect(output);

  let lastIrKey = '';
  let irTimer: ReturnType<typeof setTimeout> | undefined;

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
    mid.gain.setTargetAtTime(p.eqOn ? p.eqMid : 0, t, ramp);
    hi.gain.setTargetAtTime(p.eqOn ? p.eqHi : 0, t, ramp);

    comp.threshold.setTargetAtTime(p.compOn ? p.cThr : 0, t, ramp);
    comp.ratio.setTargetAtTime(p.compOn ? p.cRat : 1, t, ramp);
    comp.attack.setTargetAtTime(p.cAtk / 1000, t, ramp);
    comp.release.setTargetAtTime(p.cRel / 1000, t, ramp);
    makeup.gain.setTargetAtTime(p.compOn ? dB(p.cMk) : 1, t, ramp);

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
    try {
      lfo.stop();
    } catch {
      /* already stopped */
    }
    for (const n of [input, output, hpf, low, mid, hi, comp, makeup, satIn, satDry, satWet, shaper, satOut, chDry, chWet, chDelay, chOut, dlDry, dlWet, dlL, dlR, fbL, fbR, panL, panR, dlOut, rvDry, rvWet, preDelay, conv]) n.disconnect();
    pitchNode?.disconnect();
  }

  return { input, output, pitchNode, apply, dispose };
}
