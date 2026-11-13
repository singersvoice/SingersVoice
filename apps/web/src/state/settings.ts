/**
 * Settings: audio (VoxForge preset + params, monitor, tempo, key) and app (text scale, background,
 * camera, singer slot). Mirrored in localStorage for instant boot and synced to
 * `SingersVoice/Config/*.json` in the active provider (Drive or device).
 */
import { effect, signal } from '@preact/signals';
import { AUDIO_SETTINGS_DEFAULTS, CONFIG_FILES, clampParams, type AudioPluginSettings } from '@singersvoice/protocol';
import { provider } from './session.ts';

export interface AppSettings {
  schema: 'singersvoice.app-settings.v2';
  textScale: number; // 1.0 | 1.3 | 1.6 | 2.0
  backgroundId: string;
  cameraOn: boolean;
  cameraFacing: 'user' | 'environment';
  cameraDeviceId: string;
  /** Base framing on the virtual stage: wide (default) shows the whole camera frame, scaled down on stage. */
  zoomPreset: 'wide' | 'mid' | 'close';
  /** Vocal-driven auto zoom: ease closer while this singer sings, back to the preset when silent. */
  autoZoom: boolean;
  /** Kept for older saves; the stage always blends the singer (the model is the only mode). */
  cutout: boolean;
  /** One-time migration marker for the virtual-stage defaults. */
  stageV3: boolean;
  singerSlot: number;
  countIn: boolean;
  showCueDeck: boolean;
  audioInputId: string;
  echoCancellation: boolean;
  highContrastLyrics: boolean;
  onboarded: boolean;
  /** The mix balance on this device (dB): the backing track and the vocals in what is recorded, relayed and broadcast from here. */
  trackDb: number;
  vocalDb: number;
}

export const APP_DEFAULTS: AppSettings = {
  schema: 'singersvoice.app-settings.v2',
  textScale: 1,
  backgroundId: 'mytestbg1',
  cameraOn: true,
  cameraFacing: 'user',
  cameraDeviceId: '',
  zoomPreset: 'wide',
  autoZoom: true,
  cutout: true,
  stageV3: true,
  singerSlot: 1,
  countIn: true,
  showCueDeck: true,
  audioInputId: '',
  echoCancellation: false,
  highContrastLyrics: false,
  onboarded: false,
  trackDb: 0,
  vocalDb: 0,
};

const APP_KEY = 'sv.settings.app';
const AUDIO_KEY = 'sv.settings.audio';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

function migrateApp(v: AppSettings): AppSettings {
  // Saves from before the virtual stage carried the old defaults (mid framing, cut-out off):
  // reset those once so every device starts wide, blended, with vocal-driven auto zoom.
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(APP_KEY) ?? '{}') as Partial<AppSettings>;
  } catch {
    /* fresh */
  }
  if (stored.stageV3 === true) return v;
  return { ...v, zoomPreset: 'wide', autoZoom: true, cutout: true, stageV3: true };
}

export const appSettings = signal<AppSettings>(migrateApp(read(APP_KEY, APP_DEFAULTS)));
export const audioSettings = signal<AudioPluginSettings>(sanitizeAudio(read(AUDIO_KEY, AUDIO_SETTINGS_DEFAULTS)));

function sanitizeAudio(a: AudioPluginSettings): AudioPluginSettings {
  return {
    ...AUDIO_SETTINGS_DEFAULTS,
    ...a,
    params: clampParams(a.params ?? {}),
    tempo: Math.min(1.5, Math.max(0.5, Number(a.tempo) || 1)),
    keyShift: Math.min(6, Math.max(-6, Math.round(Number(a.keyShift) || 0))),
    backingGain: Math.min(1, Math.max(0, Number(a.backingGain) ?? 0.85)),
  };
}

export function updateApp(patch: Partial<AppSettings>): void {
  appSettings.value = { ...appSettings.value, ...patch };
}

export function updateAudio(patch: Partial<AudioPluginSettings>): void {
  audioSettings.value = sanitizeAudio({ ...audioSettings.value, ...patch, updatedAt: new Date().toISOString() });
}

// Persist locally on every change; push to the provider (debounced) so Drive holds the latest copy.
let appTimer: ReturnType<typeof setTimeout> | undefined;
let audioTimer: ReturnType<typeof setTimeout> | undefined;

effect(() => {
  const v = appSettings.value;
  try {
    localStorage.setItem(APP_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
  document.documentElement.style.setProperty('--text-scale', String(v.textScale));
  document.documentElement.dataset.contrast = v.highContrastLyrics ? 'high' : 'normal';
  clearTimeout(appTimer);
  appTimer = setTimeout(() => void provider.peek().setConfig(CONFIG_FILES.app, v).catch(() => undefined), 2500);
});

effect(() => {
  const v = audioSettings.value;
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
  clearTimeout(audioTimer);
  audioTimer = setTimeout(() => void provider.peek().setConfig(CONFIG_FILES.audioPlugin, v).catch(() => undefined), 2500);
});

/** Pull the provider's copies (e.g. after linking Drive on a new device). Newer `updatedAt` wins for audio. */
export async function pullSettings(): Promise<void> {
  const p = provider.peek();
  try {
    const remoteAudio = await p.getConfig<AudioPluginSettings>(CONFIG_FILES.audioPlugin);
    if (remoteAudio && (remoteAudio.updatedAt ?? '') > (audioSettings.peek().updatedAt ?? '')) audioSettings.value = sanitizeAudio(remoteAudio);
    const remoteApp = await p.getConfig<AppSettings>(CONFIG_FILES.app);
    if (remoteApp) appSettings.value = { ...APP_DEFAULTS, ...remoteApp, onboarded: appSettings.peek().onboarded || remoteApp.onboarded };
  } catch {
    /* offline or not linked yet */
  }
}
