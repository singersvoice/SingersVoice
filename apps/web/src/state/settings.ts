/**
 * Settings: audio (VoxForge preset + params, monitor, tempo, key) and app (text scale, background,
 * camera, singer slot). Mirrored in localStorage for instant boot and synced to
 * `SingersVoice/Config/*.json` in the active provider (Drive or device).
 */
import { effect, signal } from '@preact/signals';
import { applyPreset, AUDIO_SETTINGS_DEFAULTS, CONFIG_FILES, clampParams, TV_LOOKS, VOXFORGE_PRESETS, type AudioPluginSettings, type TvLook } from '@singersvoice/protocol';
import { FRAMINGS, PICTURES, type Framing, type Picture } from '../video/framing.ts';
import { provider } from './session.ts';

export interface AppSettings {
  schema: 'singersvoice.app-settings.v2';
  textScale: number; // 1.0 | 1.3 | 1.6 | 2.0
  backgroundId: string;
  cameraOn: boolean;
  cameraFacing: 'user' | 'environment';
  cameraDeviceId: string;
  /** Kept for older saves (`picture` says it now). */
  cutout: boolean;
  /** My picture on every stage: me cut out of my room ('cutout'), or my camera picture as it is, room and all ('camera'). video/framing.ts. */
  picture: Picture;
  /** How my frame behaves: still (the default), following me when I move, or pushed in on me by my voice. video/framing.ts. */
  framing: Framing;
  /** One-time migration markers for the virtual-stage defaults. */
  stageV3: boolean;
  stageV4: boolean;
  singerSlot: number;
  countIn: boolean;
  showCueDeck: boolean;
  audioInputId: string;
  echoCancellation: boolean;
  /** The instrument: a second input (a guitar, keys… on a USB interface) summed into this singer's sound; which input, and its level in dB. */
  instrumentOn: boolean;
  instrumentDeviceId: string;
  instrumentDb: number;
  highContrastLyrics: boolean;
  onboarded: boolean;
  /** The mix balance on this device (dB): the backing track and the vocals in what is recorded, relayed and broadcast from here. */
  trackDb: number;
  vocalDb: number;
  /** Host: the whole meet is filmed on this device (the show picture with the stage mix) straight into Drive, as one video. */
  recordMeet: boolean;
  /**
   * Publisher, YouTube connected: who can open the broadcasts the app makes. Unlisted by default — the link the
   * publisher hands out plays for whoever has it, and the channel's page does not list the show; public puts it
   * on the channel for everyone to find.
   */
  youtubePrivacy: 'public' | 'unlisted';
  /** What the TV in the room shows beside my stage (lib/tv.ts): the words and the stage, the stage alone, the words alone. */
  tvLook: TvLook;
  /** After a take is kept: offer to post a clip of it (components/ClipSheet.tsx) — the box in Settings → Social. */
  socialOffer: boolean;
  /** The length a clip starts out with (seconds; the picker moves it). */
  clipSeconds: number;
}

export const APP_DEFAULTS: AppSettings = {
  schema: 'singersvoice.app-settings.v2',
  textScale: 1,
  backgroundId: 'mytestbg1',
  cameraOn: true,
  cameraFacing: 'user',
  cameraDeviceId: '',
  cutout: true,
  picture: 'cutout',
  framing: 'still',
  stageV3: true,
  stageV4: true,
  singerSlot: 1,
  countIn: true,
  showCueDeck: true,
  audioInputId: '',
  echoCancellation: false,
  instrumentOn: false,
  instrumentDeviceId: '',
  instrumentDb: 0,
  highContrastLyrics: false,
  onboarded: false,
  trackDb: 0,
  vocalDb: 0,
  recordMeet: true,
  youtubePrivacy: 'unlisted',
  tvLook: 'both',
  socialOffer: true,
  clipSeconds: 60,
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
  // Saves from before the virtual stage carried the old defaults (cut-out off): reset those once so
  // every device starts blended.
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(APP_KEY) ?? '{}') as Partial<AppSettings>;
  } catch {
    /* fresh */
  }
  if (stored.stageV3 !== true) v = { ...v, cutout: true, stageV3: true };
  if (stored.stageV4 !== true) v = { ...v, stageV4: true };
  // The framing presets (chest / wide / mid / close, Auto) are gone: every singer is framed the same way (the stage frame).
  delete (v as Partial<Record<'zoomPreset' | 'autoZoom', unknown>>).zoomPreset;
  delete (v as Partial<Record<'zoomPreset' | 'autoZoom', unknown>>).autoZoom;
  // The picture and framing choices: a save from before them keeps what its cut-out switch said; anything odd is the default.
  if (!PICTURES.includes(v.picture)) v = { ...v, picture: v.cutout === false ? 'camera' : 'cutout' };
  if (!FRAMINGS.includes(v.framing)) v = { ...v, framing: 'still' };
  if (!TV_LOOKS.includes(v.tvLook)) v = { ...v, tvLook: 'both' };
  if (typeof v.socialOffer !== 'boolean') v = { ...v, socialOffer: true };
  if (!Number.isFinite(v.clipSeconds) || v.clipSeconds < 15 || v.clipSeconds > 180) v = { ...v, clipSeconds: 60 };
  return v;
}

export const appSettings = signal<AppSettings>(migrateApp(read(APP_KEY, APP_DEFAULTS)));
export const audioSettings = signal<AudioPluginSettings>(sanitizeAudio(read(AUDIO_KEY, AUDIO_SETTINGS_DEFAULTS)));

function sanitizeAudio(a: AudioPluginSettings): AudioPluginSettings {
  // A factory preset means its current values (presets improve; a tweak switches to "custom", which keeps the tweak).
  const factory = VOXFORGE_PRESETS.find((p) => p.id === a.activePresetId);
  const params = clampParams(a.params ?? {});
  return {
    ...AUDIO_SETTINGS_DEFAULTS,
    ...a,
    params: factory ? applyPreset(params, factory) : params,
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
    if (remoteApp) appSettings.value = migrateApp({ ...APP_DEFAULTS, ...remoteApp, onboarded: appSettings.peek().onboarded || remoteApp.onboarded });
  } catch {
    /* offline or not linked yet */
  }
}
