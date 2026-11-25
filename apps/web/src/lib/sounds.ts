/**
 * Sound settings files (protocol sounds.ts): "Save Sound Settings" writes the complete sound of this device to
 * the Config folder as `<initials>_<date>_<time>.svsound.json`; "Import Sound Settings" lists the files saved
 * here and the ones other singers have shared, and applies one — every control on the Sound sheet and in
 * Settings → Voice follows, since they all read the same signals (state/settings.ts). Sharing puts the file
 * (its JSON, a few kilobytes) in the service's sound catalog, where anyone signed in can list and import it; a
 * share is withdrawn the same way. Nothing here needs another account's Drive.
 */
import { parseSoundSettings, soundSettingsName, type SharedSound, type SoundSettingsFile, SOUND_SETTINGS_SCHEMA } from '@singersvoice/protocol';
import { api, ApiError, controlConfigured } from './api.ts';
import type { SoundSettingsEntry } from './storage/types.ts';
import { profile, provider } from '../state/session.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../state/settings.ts';

/** The sound of this device right now, as a file. */
export function snapshotSound(name = soundSettingsName(profile.peek()?.name ?? '')): SoundSettingsFile {
  const a = audioSettings.peek();
  const app = appSettings.peek();
  return { schema: SOUND_SETTINGS_SCHEMA, name, ownerName: profile.peek()?.name ?? '', createdAt: new Date().toISOString(), audio: { ...a }, balance: { trackDb: app.trackDb, vocalDb: app.vocalDb } };
}

/** Save the sound of this device as a new file in the Config folder; the entry as listed. */
export async function saveSoundFile(): Promise<{ entry: SoundSettingsEntry; file: SoundSettingsFile }> {
  const file = snapshotSound();
  const p = provider.peek();
  await p.ready();
  const entry = await p.saveSoundSettings(file.name, file);
  return { entry, file };
}

/** The files saved here (the Config folder), newest first. */
export async function listSoundFiles(): Promise<SoundSettingsEntry[]> {
  const p = provider.peek();
  await p.ready();
  return p.listSoundSettings();
}

/** A saved file read back and checked (null: not a sound settings file). */
export async function loadSoundFile(id: string): Promise<SoundSettingsFile | null> {
  const p = provider.peek();
  await p.ready();
  return parseSoundSettings(await p.getSoundSettings(id));
}

export async function deleteSoundFile(id: string): Promise<void> {
  const p = provider.peek();
  await p.ready();
  await p.deleteSoundSettings(id);
}

/**
 * Apply a sound settings file to this device: the voice chain, the monitor, the tempo, the key, the Backing level
 * and the Track / Vocal balance — every control follows. The file's own user presets come along (added to this
 * device's, by id).
 */
export function applySoundFile(file: SoundSettingsFile): void {
  const mine = audioSettings.peek();
  const presets = [...mine.userPresets.filter((p) => !file.audio.userPresets.some((q) => q.id === p.id)), ...file.audio.userPresets];
  updateAudio({ ...file.audio, userPresets: presets });
  updateApp({ trackDb: file.balance.trackDb, vocalDb: file.balance.vocalDb });
}

export const soundSharingAvailable = (): boolean => controlConfigured.value;

/** Share a saved file with every singer (the service's sound catalog); the entry as shared. */
export async function shareSoundFile(file: SoundSettingsFile): Promise<SharedSound> {
  if (!controlConfigured.value) throw new Error('Sharing needs the SingersVoice service');
  const r = await api.post('POST /catalog/sounds', '/catalog/sounds', { file });
  return r.sound;
}

export async function unshareSoundFile(soundId: string): Promise<void> {
  if (!controlConfigured.value) return;
  await api.del('DELETE /catalog/sounds/:id', `/catalog/sounds/${encodeURIComponent(soundId)}`).catch((e) => {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  });
}

/** Everyone's shared sounds (newest first), and which of them are this account's. */
export async function listSharedSounds(): Promise<SharedSound[]> {
  if (!controlConfigured.value) return [];
  const r = await api.get('GET /catalog/sounds', '/catalog/sounds?limit=100');
  return r.items;
}

/** The shared sound's file, checked (null: withdrawn, or not a sound settings file). */
export async function loadSharedSound(soundId: string): Promise<SoundSettingsFile | null> {
  if (!controlConfigured.value) return null;
  try {
    const r = await api.get('GET /catalog/sounds/:id', `/catalog/sounds/${encodeURIComponent(soundId)}`);
    return parseSoundSettings(r.sound.file);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** My id as the catalog knows it (whose shares are mine). */
export function mySoundUserId(): string {
  return profile.peek()?.sub ? `g-${profile.peek()!.sub}` : '';
}
