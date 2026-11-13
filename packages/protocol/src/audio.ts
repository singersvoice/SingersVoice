/**
 * VoxForge parameter set. Mirrors the JUCE plugin layout (VoxForge-VST3-AU-JUCE/Source/PluginProcessor.cpp)
 * so presets round-trip between the web chain, the native plugin and the session mixer.
 *
 * Chain: input trim → pitch (octave/semitone/cents + chromatic auto-tune) → HPF → EQ (120 Hz shelf ·
 *        1.2 kHz peak · 3.2 kHz presence peak · 6.5 kHz shelf) → compressor → parallel "punch"
 *        compression → de-esser → exciter (air) → saturation → chorus/doubler → stereo delay → reverb
 *        → vocal rider → output gain.
 *
 * The stages after the compressor are what turns a clean capture into a finished vocal: the parallel
 * compressor lifts every soft phrase without squashing the loud ones (punch without over-compression),
 * the de-esser tames the "s" that a bright, present vocal otherwise spits, the exciter adds the sparkle
 * of a studio chain, and the rider keeps the vocal up front at one level whatever the singer does.
 */
export interface VoxForgeParams {
  inGain: number; // dB -24..24
  outGain: number; // dB -24..24
  pitchOn: boolean;
  octave: number; // -2..2 (×12 st)
  pitchSt: number; // -12..12 semitones
  pitchCt: number; // -100..100 cents ("Sharp")
  autoStr: number; // 0..1 chromatic auto-tune strength
  autoSpeed: number; // 0..1 retune speed (1 = hard "robot" snap)
  eqOn: boolean;
  hpfHz: number; // 20..400
  eqLow: number; // dB -12..12 @120 Hz shelf
  eqMid: number; // dB -12..12 @1.2 kHz peak
  eqHi: number; // dB -12..12 @6.5 kHz shelf
  eqPres: number; // dB -12..12 @3.2 kHz presence peak (the band that cuts through a track)
  compOn: boolean;
  cThr: number; // dB -60..0
  cRat: number; // 1..20
  cAtk: number; // ms 1..200
  cRel: number; // ms 20..1000
  cMk: number; // dB 0..18
  pcOn: boolean; // parallel ("New York") compression: a crushed copy blended under the dry vocal
  pcMx: number; // 0..1 how much of the crushed copy
  dsOn: boolean; // de-esser (5–9 kHz band ducked when it spikes)
  dsAmt: number; // 0..1
  exOn: boolean; // exciter: harmonics added above 3 kHz (air, sparkle)
  exAmt: number; // 0..1
  rdOn: boolean; // vocal rider: slow automatic level, every phrase up front
  rdAmt: number; // 0..1 how far it may lift a soft phrase (1 = +12 dB)
  satOn: boolean;
  satDr: number; // 0..1
  satMx: number; // 0..1
  chOn: boolean;
  chRt: number; // Hz 0.1..6
  chDp: number; // 0..1
  chMx: number; // 0..1
  dlOn: boolean;
  dlTm: number; // s 0.02..1.5
  dlFb: number; // 0..0.85
  dlMx: number; // 0..1
  rvOn: boolean;
  rvSz: number; // 0..1
  rvDc: number; // s 0.3..8
  rvPd: number; // s 0..0.15
  rvMx: number; // 0..1
}

export interface ParamRange {
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string;
}

export const VOXFORGE_RANGES: Record<Exclude<keyof VoxForgeParams, `${string}On`>, ParamRange> = {
  inGain: { min: -24, max: 24, step: 0.5, unit: 'dB', label: 'Input trim' },
  outGain: { min: -24, max: 24, step: 0.5, unit: 'dB', label: 'Output gain' },
  octave: { min: -2, max: 2, step: 1, unit: 'oct', label: 'Octave' },
  pitchSt: { min: -12, max: 12, step: 1, unit: 'st', label: 'Pitch' },
  pitchCt: { min: -100, max: 100, step: 1, unit: 'ct', label: 'Sharp' },
  autoStr: { min: 0, max: 1, step: 0.01, unit: '', label: 'Auto-tune' },
  autoSpeed: { min: 0, max: 1, step: 0.01, unit: '', label: 'Retune speed' },
  hpfHz: { min: 20, max: 400, step: 1, unit: 'Hz', label: 'High-pass' },
  eqLow: { min: -12, max: 12, step: 0.5, unit: 'dB', label: 'Low 120 Hz' },
  eqMid: { min: -12, max: 12, step: 0.5, unit: 'dB', label: 'Mid 1.2 kHz' },
  eqHi: { min: -12, max: 12, step: 0.5, unit: 'dB', label: 'Air 6.5 kHz' },
  eqPres: { min: -12, max: 12, step: 0.5, unit: 'dB', label: 'Presence 3.2 kHz' },
  cThr: { min: -60, max: 0, step: 0.5, unit: 'dB', label: 'Threshold' },
  cRat: { min: 1, max: 20, step: 0.1, unit: ':1', label: 'Ratio' },
  cAtk: { min: 1, max: 200, step: 1, unit: 'ms', label: 'Attack' },
  cRel: { min: 20, max: 1000, step: 1, unit: 'ms', label: 'Release' },
  cMk: { min: 0, max: 18, step: 0.5, unit: 'dB', label: 'Makeup' },
  pcMx: { min: 0, max: 1, step: 0.01, unit: '', label: 'Punch (parallel comp)' },
  dsAmt: { min: 0, max: 1, step: 0.01, unit: '', label: 'De-ess' },
  exAmt: { min: 0, max: 1, step: 0.01, unit: '', label: 'Air (exciter)' },
  rdAmt: { min: 0, max: 1, step: 0.01, unit: '', label: 'Rider' },
  satDr: { min: 0, max: 1, step: 0.01, unit: '', label: 'Drive' },
  satMx: { min: 0, max: 1, step: 0.01, unit: '', label: 'Sat mix' },
  chRt: { min: 0.1, max: 6, step: 0.01, unit: 'Hz', label: 'Chorus rate' },
  chDp: { min: 0, max: 1, step: 0.01, unit: '', label: 'Chorus depth' },
  chMx: { min: 0, max: 1, step: 0.01, unit: '', label: 'Chorus mix' },
  dlTm: { min: 0.02, max: 1.5, step: 0.01, unit: 's', label: 'Delay time' },
  dlFb: { min: 0, max: 0.85, step: 0.01, unit: '', label: 'Feedback' },
  dlMx: { min: 0, max: 1, step: 0.01, unit: '', label: 'Delay mix' },
  rvSz: { min: 0, max: 1, step: 0.01, unit: '', label: 'Room size' },
  rvDc: { min: 0.3, max: 8, step: 0.1, unit: 's', label: 'Decay' },
  rvPd: { min: 0, max: 0.15, step: 0.001, unit: 's', label: 'Pre-delay' },
  rvMx: { min: 0, max: 1, step: 0.01, unit: '', label: 'Reverb mix' },
};

export const VOXFORGE_DEFAULTS: VoxForgeParams = {
  inGain: 0,
  outGain: 0,
  pitchOn: true,
  octave: 0,
  pitchSt: 0,
  pitchCt: 0,
  autoStr: 0,
  autoSpeed: 0.5,
  eqOn: true,
  hpfHz: 90,
  eqLow: 0,
  eqMid: 1,
  eqHi: 2.5,
  eqPres: 1.5,
  compOn: true,
  cThr: -20,
  cRat: 3.5,
  cAtk: 5,
  cRel: 120,
  cMk: 5,
  pcOn: false,
  pcMx: 0.3,
  dsOn: true,
  dsAmt: 0.4,
  exOn: false,
  exAmt: 0.3,
  rdOn: false,
  rdAmt: 0.6,
  satOn: false,
  satDr: 0.25,
  satMx: 0.35,
  chOn: false,
  chRt: 0.6,
  chDp: 0.4,
  chMx: 0.35,
  dlOn: false,
  dlTm: 0.28,
  dlFb: 0.25,
  dlMx: 0.25,
  rvOn: true,
  rvSz: 0.4,
  rvDc: 2.4,
  rvPd: 0.02,
  rvMx: 0.22,
};

export interface VoxForgePreset {
  id: string;
  name: string;
  blurb: string;
  params: Partial<VoxForgeParams>;
}

/**
 * Factory presets — one click, applied live to the captured voice (the web counterparts of VoxForge's
 * templates). The first six are the finished-vocal treatments: Studio, Natural Tune, Punch, Up Front,
 * Radio-Ready and Vibrant; the rest are characters and effects.
 */
export const VOXFORGE_PRESETS: VoxForgePreset[] = [
  { id: 'natural', name: 'Natural', blurb: 'Clean, present vocal, light room.', params: {} },
  {
    id: 'studio',
    name: 'Studio',
    blurb: 'Studio quality: clean low end, presence, de-essed, a touch of air, held at one level.',
    params: { hpfHz: 95, eqLow: -1, eqMid: 1, eqPres: 2.5, eqHi: 2, cThr: -20, cRat: 3, cMk: 5, pcOn: true, pcMx: 0.25, dsOn: true, dsAmt: 0.5, exOn: true, exAmt: 0.25, rdOn: true, rdAmt: 0.6, rvSz: 0.35, rvDc: 1.8, rvMx: 0.16, rvPd: 0.025 },
  },
  {
    id: 'tune',
    name: 'Natural Tune',
    blurb: 'Studio chain plus natural pitch correction: gentle, slow, keeps the vibrato.',
    params: { autoStr: 0.75, autoSpeed: 0.35, hpfHz: 95, eqLow: -1, eqMid: 1, eqPres: 2.5, eqHi: 2, cThr: -20, cRat: 3, cMk: 5, pcOn: true, pcMx: 0.25, dsOn: true, dsAmt: 0.5, exOn: true, exAmt: 0.25, rdOn: true, rdAmt: 0.6, rvSz: 0.35, rvDc: 1.8, rvMx: 0.16, rvPd: 0.025 },
  },
  {
    id: 'punch',
    name: 'Punch',
    blurb: 'Punch without over-compression: light main compressor, a crushed copy blended under.',
    params: { eqPres: 3, eqHi: 2, cThr: -16, cRat: 2, cAtk: 12, cRel: 150, cMk: 3, pcOn: true, pcMx: 0.55, dsOn: true, dsAmt: 0.5, exOn: true, exAmt: 0.2, rdOn: true, rdAmt: 0.4, rvMx: 0.14 },
  },
  {
    id: 'upfront',
    name: 'Up Front',
    blurb: 'Perfect placement: sits on top of the track, every phrase at one level, short pre-delayed room.',
    params: { hpfHz: 110, eqLow: -2, eqMid: 1.5, eqPres: 3, eqHi: 2, cThr: -22, cRat: 3.5, cMk: 6, pcOn: true, pcMx: 0.3, dsOn: true, dsAmt: 0.55, exOn: true, exAmt: 0.3, rdOn: true, rdAmt: 0.85, rvSz: 0.3, rvDc: 1.4, rvPd: 0.045, rvMx: 0.14 },
  },
  {
    id: 'radio',
    name: 'Radio-Ready',
    blurb: 'Radio-ready: bright, dense and loud, a hint of grit, the softest line comes out strong.',
    params: { hpfHz: 100, eqLow: -1.5, eqMid: 1, eqPres: 3.5, eqHi: 3, cThr: -24, cRat: 4, cAtk: 4, cRel: 110, cMk: 7, pcOn: true, pcMx: 0.35, dsOn: true, dsAmt: 0.6, exOn: true, exAmt: 0.4, rdOn: true, rdAmt: 0.8, satOn: true, satDr: 0.15, satMx: 0.2, rvMx: 0.12, rvDc: 1.6, dlOn: true, dlTm: 0.22, dlFb: 0.12, dlMx: 0.08 },
  },
  {
    id: 'vibrant',
    name: 'Vibrant',
    blurb: 'More vibrant: maximum air and presence, the rider all the way — even a whisper fills the stage.',
    params: { hpfHz: 100, eqLow: -1, eqMid: 1.5, eqPres: 4, eqHi: 3.5, cThr: -26, cRat: 5, cAtk: 3, cRel: 100, cMk: 8, pcOn: true, pcMx: 0.45, dsOn: true, dsAmt: 0.7, exOn: true, exAmt: 0.5, rdOn: true, rdAmt: 1, chOn: true, chRt: 0.4, chDp: 0.25, chMx: 0.15, rvSz: 0.45, rvDc: 2.2, rvMx: 0.2 },
  },
  {
    id: 'popstar',
    name: 'Pop Star',
    blurb: 'Bright, tight, modern tune.',
    params: { autoStr: 0.6, autoSpeed: 0.6, eqHi: 3, eqPres: 2, eqLow: -1.5, cThr: -22, cRat: 4, cMk: 5, dsOn: true, dsAmt: 0.5, exOn: true, exAmt: 0.25, rdOn: true, rdAmt: 0.5, rvMx: 0.18, dlOn: true, dlTm: 0.25, dlMx: 0.14 },
  },
  {
    id: 'warm',
    name: 'Warm',
    blurb: 'Round and close: fuller low end, softer top, a little tape.',
    params: { eqLow: 2, eqPres: 0.5, eqHi: -1, satOn: true, satDr: 0.15, satMx: 0.2, cThr: -18, cRat: 3, rdOn: true, rdAmt: 0.5, rvMx: 0.18 },
  },
  {
    id: 'bright',
    name: 'Bright',
    blurb: 'Sharp and forward: presence and air up, every consonant clear.',
    params: { eqLow: -2, eqPres: 4, eqHi: 4.5, exOn: true, exAmt: 0.45, dsOn: true, dsAmt: 0.75, cThr: -20, cRat: 3.5, rdOn: true, rdAmt: 0.5, rvMx: 0.16 },
  },
  {
    id: 'ballad',
    name: 'Warm Ballad',
    blurb: 'Big hall, soft top end.',
    params: { eqLow: 2, eqHi: -1, eqPres: 0, rvSz: 0.75, rvDc: 4.2, rvMx: 0.34, rvPd: 0.04, cThr: -16, cRat: 2.5, rdOn: true, rdAmt: 0.4 },
  },
  {
    id: 'stadium',
    name: 'Stadium',
    blurb: 'Huge slap-back and long tail.',
    params: { dlOn: true, dlTm: 0.42, dlFb: 0.4, dlMx: 0.3, rvSz: 0.9, rvDc: 6, rvMx: 0.4, cMk: 4, eqPres: 2 },
  },
  {
    id: 'telephone',
    name: 'Telephone',
    blurb: 'Narrow band, saturated, dry — the old radio effect.',
    params: { hpfHz: 260, eqMid: 5, eqPres: 2, eqHi: -4, eqLow: -6, satOn: true, satDr: 0.5, satMx: 0.6, rvOn: false, cThr: -26, cRat: 6, dsOn: false },
  },
  {
    id: 'doubler',
    name: 'Doubler',
    blurb: 'Chorus thickening for choruses.',
    params: { chOn: true, chRt: 0.35, chDp: 0.55, chMx: 0.45, rvMx: 0.2 },
  },
  {
    id: 'robot',
    name: 'Robot',
    blurb: 'Hard tune: instant chromatic snap, the machine voice.',
    params: { autoStr: 1, autoSpeed: 1, eqHi: 2, eqPres: 2, rvMx: 0.15 },
  },
  {
    id: 'octave-down',
    name: 'Octave Down',
    blurb: 'Sub-octave for harmonies.',
    params: { octave: -1, rvMx: 0.2 },
  },
];

export function applyPreset(base: VoxForgeParams, preset: VoxForgePreset): VoxForgeParams {
  return { ...VOXFORGE_DEFAULTS, ...preset.params, inGain: base.inGain, outGain: base.outGain };
}

export function clampParams(p: Partial<VoxForgeParams>): VoxForgeParams {
  const out: VoxForgeParams = { ...VOXFORGE_DEFAULTS };
  for (const key of Object.keys(VOXFORGE_DEFAULTS) as (keyof VoxForgeParams)[]) {
    const v = p[key];
    if (v === undefined || v === null) continue;
    if (typeof VOXFORGE_DEFAULTS[key] === 'boolean') {
      (out as unknown as Record<string, unknown>)[key] = Boolean(v);
    } else {
      const r = VOXFORGE_RANGES[key as keyof typeof VOXFORGE_RANGES];
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      (out as unknown as Record<string, unknown>)[key] = r ? Math.min(r.max, Math.max(r.min, n)) : n;
    }
  }
  return out;
}

/** Total pitch shift sent to the worklet, in semitones. */
export function totalSemitones(p: VoxForgeParams): number {
  return p.pitchOn ? p.octave * 12 + p.pitchSt + p.pitchCt / 100 : 0;
}

/** Saved as `SingersVoice/Config/audio_plugin_settings.json`. */
export interface AudioPluginSettings {
  schema: 'singersvoice.audio-plugin-settings.v2';
  updatedAt: string;
  activePresetId: string;
  params: VoxForgeParams;
  userPresets: VoxForgePreset[];
  monitor: boolean;
  backingGain: number;
  tempo: number; // 0.5..1.5
  keyShift: number; // -6..6 semitones
}

/** A new singer starts on Studio: the finished-vocal chain, nothing to set up. */
export const AUDIO_SETTINGS_DEFAULTS: AudioPluginSettings = {
  schema: 'singersvoice.audio-plugin-settings.v2',
  updatedAt: new Date(0).toISOString(),
  activePresetId: 'studio',
  params: { ...VOXFORGE_DEFAULTS, ...VOXFORGE_PRESETS.find((p) => p.id === 'studio')!.params },
  userPresets: [],
  monitor: false,
  backingGain: 0.85,
  tempo: 1,
  keyShift: 0,
};
