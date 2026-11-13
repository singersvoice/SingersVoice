/**
 * The audio lab's entry: the real chain and mix bus, bundled for a page that renders them offline
 * (tools/ci/audio-lab.mjs) and measures what comes out. Nothing here ships in the app.
 */
import { applyPreset, AUDIO_SETTINGS_DEFAULTS, VOXFORGE_DEFAULTS, VOXFORGE_PRESETS, type VoxForgeParams } from '@singersvoice/protocol';
import { compressorMakeupDb, safetyStage } from './dynamics.ts';
import { dbToGain } from './gain.ts';
import { measureLoudness, MIX_TARGETS, normalizationDb } from './loudness.ts';
import { MIX_GUARD, MixBus, VOCAL_RIDER } from './mixBus.ts';
import { createVoxForgeChain } from './voxforge.ts';

export function presetParams(id: string): VoxForgeParams {
  const preset = VOXFORGE_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no preset ${id}`);
  return applyPreset(VOXFORGE_DEFAULTS, preset);
}

declare global {
  interface Window {
    svLab: typeof lab;
  }
}

const lab = { createVoxForgeChain, MixBus, measureLoudness, normalizationDb, MIX_TARGETS, MIX_GUARD, VOCAL_RIDER, presetParams, VOXFORGE_DEFAULTS, AUDIO_SETTINGS_DEFAULTS, compressorMakeupDb, safetyStage, dbToGain };
window.svLab = lab;
