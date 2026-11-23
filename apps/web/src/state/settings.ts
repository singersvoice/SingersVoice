/**
 * Settings: audio (VoxForge preset + params, monitor, tempo, key) and app (text scale, background,
 * camera, singer slot). Mirrored in localStorage for instant boot and synced to
 * `SingersVoice/Config/*.json` in the active provider (Drive or device).
 */
import { effect, signal } from '@preact/signals';
import { applyPreset, AUDIO_SETTINGS_DEFAULTS, CONFIG_FILES, clampParams, TV_LOOKS, VOXFORGE_PRESETS, type AudioPluginSettings, type TvLook } from '@singersvoice/protocol';
import { MIX_TRACK_DEFAULT_DB, MIX_VOCAL_DEFAULT_DB } from '../audio/gain.ts';
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
  /** How my frame behaves: pushed in on my face while I sing (the default), still, or following me when I move. video/framing.ts. */
  framing: Framing;
  /** One-time migration markers for the virtual-stage defaults. */
  stageV3: boolean;
  stageV4: boolean;
  /** One-time migration marker: the framing's default became the voice zoom (a save from before keeps nothing else). */
  framingV2: boolean;
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
  /** When the camera and the microphone were asked for at the setup (ISO; '' never): the browser keeps the answer itself — this only says the question was put. */
  mediaAskedAt: string;
  /** The mix balance on this device (dB): the backing track and the vocals in what is recorded, relayed and broadcast from here (audio/gain.ts has where they start). */
  trackDb: number;
  vocalDb: number;
  /** One-time migration marker: the balance's defaults rose (the voice in front); a save still at the old 0 / 0 takes them once. */
  mixV2: boolean;
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
  /** When these were last changed (ISO; '' never): the newer of this device's copy and the Config folder's wins at the start. */
  updatedAt: string;
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
  framing: 'voice',
  stageV3: true,
  stageV4: true,
  framingV2: true,
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
  mediaAskedAt: '',
  trackDb: MIX_TRACK_DEFAULT_DB,
  vocalDb: MIX_VOCAL_DEFAULT_DB,
  mixV2: true,
  recordMeet: true,
  youtubePrivacy: 'unlisted',
  tvLook: 'both',
  socialOffer: true,
  clipSeconds: 60,
  updatedAt: '',
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
  if (!FRAMINGS.includes(v.framing)) v = { ...v, framing: 'voice' };
  // The voice zoom became the default framing: a save from before starts on it once (the choice is the singer's from then on).
  if (stored.framingV2 !== true) v = { ...v, framing: 'voice', framingV2: true };
  // The balance's defaults rose (the voice in front of the music): a save never moved off the old 0 / 0 takes the new ones once; a balance the singer set stays theirs.
  if (stored.mixV2 !== true) v = { ...v, mixV2: true, ...(Number(v.trackDb) === 0 && Number(v.vocalDb) === 0 ? { trackDb: MIX_TRACK_DEFAULT_DB, vocalDb: MIX_VOCAL_DEFAULT_DB } : {}) };
  if (!Number.isFinite(Number(v.trackDb))) v = { ...v, trackDb: MIX_TRACK_DEFAULT_DB };
  if (!Number.isFinite(Number(v.vocalDb))) v = { ...v, vocalDb: MIX_VOCAL_DEFAULT_DB };
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
  appSettings.value = { ...appSettings.value, ...patch, updatedAt: new Date().toISOString() };
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

/**
 * Saved now, by hand (the Save button beside the sound settings): both files to the Config folder at once, the
 * debounced copies cancelled — and the word on how it went (`settingsSaved`: when and where, or why not), for the
 * button to show. The automatic saves go on as before; this one is for the singer who wants to see it done.
 */
export const settingsSaved = signal<{ at: string; error: null } | { at: string; error: string } | null>(null);
export async function saveSettingsNow(): Promise<void> {
  clearTimeout(appTimer);
  clearTimeout(audioTimer);
  const p = provider.peek();
  try {
    await p.setConfig(CONFIG_FILES.audioPlugin, audioSettings.peek());
    await p.setConfig(CONFIG_FILES.app, appSettings.peek());
    settingsSaved.value = { at: new Date().toISOString(), error: null };
  } catch (e) {
    settingsSaved.value = { at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

/**
 * Pull the Config folder's copies (after linking Drive on a new device, at every start, from Settings): the newer
 * copy wins, file by file — a change made here a moment ago (or offline, before it could be saved) is never undone
 * by an older copy in the folder; a copy saved from another device comes to this one.
 */
export async function pullSettings(): Promise<void> {
  const p = provider.peek();
  try {
    const remoteAudio = await p.getConfig<AudioPluginSettings>(CONFIG_FILES.audioPlugin);
    const localAudio = audioSettings.peek();
    if (remoteAudio && (remoteAudio.updatedAt ?? '') > (localAudio.updatedAt ?? '')) audioSettings.value = sanitizeAudio(remoteAudio);
    else if ((remoteAudio?.updatedAt ?? '') < (localAudio.updatedAt ?? '')) void p.setConfig(CONFIG_FILES.audioPlugin, localAudio).catch(() => undefined); // this device's is the newer: the folder takes it
    const remoteApp = await p.getConfig<AppSettings>(CONFIG_FILES.app);
    const local = appSettings.peek();
    if (remoteApp && (remoteApp.updatedAt ?? '') >= (local.updatedAt ?? '')) appSettings.value = migrateApp({ ...APP_DEFAULTS, ...remoteApp, onboarded: local.onboarded || remoteApp.onboarded });
    else if ((remoteApp?.updatedAt ?? '') < (local.updatedAt ?? '')) void p.setConfig(CONFIG_FILES.app, local).catch(() => undefined);
  } catch {
    /* offline or not linked yet */
  }
}

/**
 * The settings at the start of the app: this device's copy is up at once (localStorage); signed in to Drive, the
 * Config folder's copy is read as well and the newer wins (`pullSettings`) — the sound set up on one device is the
 * sound on the next, and a device whose browser let its storage go gets its settings back.
 */
export function restoreSettingsAtStart(): void {
  if (provider.peek().kind === 'drive') void pullSettings();
}
