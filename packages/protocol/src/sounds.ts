/**
 * Sound settings as a file a singer can keep and hand to another (24 Nov): the complete sound — the preset and
 * every tweak (the voice chain), the monitor and its level, the tempo and the key, the Backing level in the
 * ears, and PUBLISH MODE's Track / Vocal balance — written to the Config folder as
 * `<initials>_<YYYYMMDD>_<HHMMSS>.svsound.json` by "Save Sound Settings", listed by "Import Sound Settings",
 * and shared with everyone through the service's sound catalog (a shared file is the JSON itself, a few
 * kilobytes, stored on the service — another account's Drive cannot be listed, `drive.file` sees only what
 * the app made).
 */
import { AUDIO_SETTINGS_DEFAULTS, clampParams, VOXFORGE_PRESETS, type AudioPluginSettings, type VoxForgePreset } from './audio.ts';

export const SOUND_SETTINGS_SCHEMA = 'singersvoice.sound-settings.v1';
/** The file name's tail in the Config folder. */
export const SOUND_SETTINGS_EXT = '.svsound.json';

export interface SoundSettingsFile {
  schema: typeof SOUND_SETTINGS_SCHEMA;
  /** `<initials>_<YYYYMMDD>_<HHMMSS>` — the file's name without its extension, and the entry's id. */
  name: string;
  /** Who saved it (their display name), for the list. */
  ownerName: string;
  createdAt: string;
  /** The voice chain, the monitor, the tempo, the key, the Backing level: everything the Sound sheet holds. */
  audio: AudioPluginSettings;
  /** PUBLISH MODE's Track / Vocal volume (dB). */
  balance: { trackDb: number; vocalDb: number };
}

/** The initials of a display name ("Hari Narayan" → "HN", "madonna" → "M"; nothing usable → "SV"), at most three letters. */
export function initialsOf(displayName: string): string {
  const words = String(displayName ?? '')
    .split(/[\s._-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const initials = words
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return initials || 'SV';
}

/** The name a sound settings file saved now gets: the initials, the date and the time of the save, in the device's own time. */
export function soundSettingsName(displayName: string, at: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${initialsOf(displayName)}_${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}_${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

export const SOUND_NAME = /^[A-Za-z0-9]{1,3}_\d{8}_\d{6}$/;

/**
 * A sound settings file read back (from Drive, from the catalog, from a file someone sent): validated, every number
 * clamped to its range, unknown fields dropped — or null when it is not one at all.
 */
export function parseSoundSettings(input: unknown): SoundSettingsFile | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Partial<SoundSettingsFile>;
  if (o.schema !== SOUND_SETTINGS_SCHEMA || !o.audio || typeof o.audio !== 'object') return null;
  const a = o.audio as Partial<AudioPluginSettings>;
  const params = clampParams(a.params && typeof a.params === 'object' ? a.params : {});
  const presetId = typeof a.activePresetId === 'string' && a.activePresetId.length <= 60 ? a.activePresetId : 'custom';
  const userPresets = (Array.isArray(a.userPresets) ? a.userPresets : [])
    .filter((p): p is VoxForgePreset => Boolean(p) && typeof p === 'object' && typeof (p as VoxForgePreset).id === 'string' && typeof (p as VoxForgePreset).name === 'string' && typeof (p as VoxForgePreset).params === 'object')
    .slice(0, 24)
    .map((p) => ({ id: p.id.slice(0, 60), name: p.name.slice(0, 60), blurb: typeof p.blurb === 'string' ? p.blurb.slice(0, 200) : '', params: clampParams(p.params ?? {}) }));
  const num = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const audio: AudioPluginSettings = {
    ...AUDIO_SETTINGS_DEFAULTS,
    activePresetId: VOXFORGE_PRESETS.some((p) => p.id === presetId) || userPresets.some((p) => p.id === presetId) ? presetId : 'custom',
    params,
    userPresets,
    monitor: Boolean(a.monitor),
    backingGain: num(a.backingGain, 0, 1, AUDIO_SETTINGS_DEFAULTS.backingGain),
    monitorDb: num(a.monitorDb, -24, 24, 0),
    tempo: num(a.tempo, 0.5, 1.5, 1),
    keyShift: Math.round(num(a.keyShift, -6, 6, 0)),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
  };
  const b = (o.balance && typeof o.balance === 'object' ? o.balance : {}) as Partial<SoundSettingsFile['balance']>;
  return {
    schema: SOUND_SETTINGS_SCHEMA,
    name: typeof o.name === 'string' && SOUND_NAME.test(o.name) ? o.name : soundSettingsName('SV'),
    ownerName: typeof o.ownerName === 'string' ? o.ownerName.slice(0, 80) : '',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
    audio,
    balance: { trackDb: num(b.trackDb, -30, 30, 0), vocalDb: num(b.vocalDb, -30, 30, 0) },
  };
}

/** A sound in the service's catalog: a saved file another singer can import. */
export interface SharedSound {
  /** `${ownerUserId}:${name}` — one entry per saved file. */
  soundId: string;
  ownerUserId: string;
  ownerName: string;
  name: string;
  /** The preset the file is built on (its id), for the list. */
  presetId: string;
  publishedAt: string;
  updatedAt: string;
  file: SoundSettingsFile;
}

export interface SoundPublishRequest {
  file: SoundSettingsFile;
}

export interface SoundListResponse {
  items: SharedSound[];
  total: number;
}
