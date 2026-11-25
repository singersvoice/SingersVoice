/**
 * Two plain buttons beside the sound settings, wherever they appear (Settings → VoxForge voice, the Studio's and
 * the live stage's Sound sheets):
 *
 * - Preview my voice / Stop preview: the microphone through the voice chain exactly as the settings stand — the
 *   preset, every tweak, the Vocal volume — into the ears, live, changed on the spot as the controls move. It is
 *   the same chain the stage and the recording use and the same mix bus (its rider, its guard, its limiter), so
 *   what is heard is what goes out; nothing is simulated and nothing restarts: a preset tap re-tunes the chain in
 *   place. On a stage where the microphone is already open the preview only adds the ears; elsewhere it opens the
 *   microphone for the preview and closes it with the Stop. Headphones, or the voice feeds back from the speakers.
 * - Save Sound Settings (24 Nov; lib/sounds.ts): the complete sound of this device — the preset and every tweak, the
 *   monitor and its level, the tempo and the key, the Backing level, the Track / Vocal balance — written to the Config
 *   folder as a file of its own, `<initials>_<date>_<time>.svsound.json` (and the two settings files refreshed with
 *   it). Import Sound Settings lists the files saved here and the ones other singers have shared, and applies the one
 *   picked: every control follows. A saved file can be shared with everyone (the service's sound catalog) or deleted.
 *   The settings are still saved by themselves a moment after every change, as before.
 */
import type { SharedSound, SoundSettingsFile } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getEngine, type AudioEngine } from '../audio/engine.ts';
import { MixBus } from '../audio/mixBus.ts';
import { applySoundFile, deleteSoundFile, listSharedSounds, listSoundFiles, loadSharedSound, loadSoundFile, mySoundUserId, saveSoundFile, shareSoundFile, soundSharingAvailable, unshareSoundFile } from '../lib/sounds.ts';
import type { SoundSettingsEntry } from '../lib/storage/types.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive } from '../state/session.ts';
import { appSettings, audioSettings, saveSettingsNow, settingsSaved } from '../state/settings.ts';
import { IcHeadphones, IcMic, IcStop } from './icons.tsx';
import { LevelDot } from './MicStatus.tsx';
import { Field, Spinner } from './ui.tsx';

type PreviewState = 'off' | 'starting' | 'on';

export function VoicePreview(props: { /** The stage's engine (its microphone, when open, is the one previewed); none: the shared engine, its microphone opened for the preview. */ engine?: AudioEngine | null; compact?: boolean }) {
  const [state, setState] = useState<PreviewState>('off');
  const run = useRef<{ engine: AudioEngine; bus: MixBus; openedHere: boolean } | null>(null);
  const audio = audioSettings.value;
  const app = appSettings.value;

  const stop = () => {
    const r = run.current;
    run.current = null;
    setState('off');
    if (!r) return;
    try {
      r.bus.dispose();
    } catch {
      /* gone */
    }
    if (r.openedHere) r.engine.closeMic();
    r.engine.muteMonitor(false);
  };

  const start = async () => {
    if (run.current) return;
    setState('starting');
    try {
      const engine = props.engine ?? getEngine();
      await engine.resume(); // inside the tap
      let openedHere = false;
      if (!engine.micOpen.value) {
        const a = appSettings.peek();
        await engine.openMic({ deviceId: a.audioInputId || undefined, echoCancellation: a.echoCancellation });
        openedHere = true;
      }
      engine.applyFx(audioSettings.peek().params);
      engine.muteMonitor(true); // the engine's own monitor steps aside: the preview is the one way the voice reaches the ears
      // The voice as it leaves the chain, through the mix bus (its rider and limiter) at the device's Vocal volume, into the ears.
      const bus = new MixBus(engine.ctx, engine.workletAvailable);
      bus.addVocal('preview', engine.voice);
      bus.setBalance(appSettings.peek().trackDb, appSettings.peek().vocalDb);
      bus.output.connect(engine.master);
      run.current = { engine, bus, openedHere };
      setState('on');
    } catch (e) {
      setState('off');
      toast(`The preview could not start: ${errorText(e)}`, 'error', 7000);
    }
  };

  // Every change reaches the running preview on the spot: the preset and its tweaks, the Vocal (and Track) volume.
  useEffect(() => {
    run.current?.engine.applyFx(audio.params);
  }, [audio.params]);
  useEffect(() => {
    run.current?.bus.setBalance(app.trackDb, app.vocalDb);
  }, [app.trackDb, app.vocalDb]);
  useEffect(() => stop, []);

  const on = state === 'on';
  return (
    <div class={`preview ${props.compact ? 'compact' : ''}`} data-voice-preview={state}>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <button class={`btn ${on ? 'accent' : 'primary'}`} disabled={state === 'starting'} onClick={() => (on ? stop() : void start())} data-preview-button>
          {state === 'starting' ? <Spinner /> : on ? <IcStop /> : <IcMic />} {state === 'starting' ? 'Opening the microphone…' : on ? 'Stop preview' : 'Preview my voice'}
        </button>
        {on && run.current && (
          <span class="row small" style="gap:6px">
            <LevelDot engine={run.current.engine} /> live — sing or talk; every change applies as you make it
          </span>
        )}
      </div>
      {!props.compact && (
        <div class="small faint" style="margin-top:6px">
          <IcHeadphones size={14} /> Headphones on: through speakers your voice feeds back into the microphone. The preview is the real thing — the preset, every tweak and the Vocal volume, through the same chain and mix the recording gets.
        </div>
      )}
    </div>
  );
}

/**
 * Save Sound Settings, Import Sound Settings (a list of the files saved here and the ones shared by others), and for a
 * saved file of mine: Share / Withdraw and Delete. Used in Settings → Voice, the Studio's Sound sheet and the live
 * stage's (compact there).
 */
export function SoundSettingsPanel(props: { compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [mine, setMine] = useState<SoundSettingsEntry[] | null>(null);
  const [shared, setShared] = useState<SharedSound[]>([]);
  const [picked, setPicked] = useState('');
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const saved = settingsSaved.value;
  const where = isDrive.value ? 'Drive › SingersVoice › Config' : 'this device';
  const me = mySoundUserId();

  const refresh = async () => {
    const [m, sh] = await Promise.all([listSoundFiles().catch(() => [] as SoundSettingsEntry[]), listSharedSounds().catch(() => [] as SharedSound[])]);
    setMine(m);
    setShared(sh);
  };
  useEffect(() => void refresh(), []);

  const save = async () => {
    setBusy('save');
    try {
      const { entry } = await saveSoundFile();
      await saveSettingsNow().catch(() => undefined); // the two settings files refreshed too (the automatic saves go on as before)
      setLastSaved(entry.name);
      setPicked(`mine:${entry.id}`);
      toast(`Sound settings saved as ${entry.name} (${where})`, 'ok', 5000);
      await refresh();
    } catch (e) {
      toast(`Could not save the sound settings: ${errorText(e)}`, 'error', 8000, { label: 'Retry', onClick: () => void save() });
    } finally {
      setBusy(null);
    }
  };

  /** The file behind the picked entry (mine, from the Config folder; shared, from the service), checked. */
  const pickedFile = async (): Promise<SoundSettingsFile | null> => {
    if (picked.startsWith('mine:')) return loadSoundFile(picked.slice(5));
    if (picked.startsWith('shared:')) return loadSharedSound(picked.slice(7));
    return null;
  };

  const apply = async () => {
    setBusy('apply');
    try {
      const file = await pickedFile();
      if (!file) throw new Error('That is not a sound settings file (or it was removed)');
      applySoundFile(file);
      toast(`Sound settings ${file.name}${file.ownerName ? ` by ${file.ownerName}` : ''} applied — every control follows`, 'ok', 5000);
    } catch (e) {
      toast(`Could not import: ${errorText(e)}`, 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const pickedMine = picked.startsWith('mine:') ? mine?.find((m) => `mine:${m.id}` === picked) : undefined;
  const pickedShare = pickedMine ? shared.find((s) => s.ownerUserId === me && s.name === pickedMine.name) : undefined;

  const share = async () => {
    if (!pickedMine) return;
    setBusy('share');
    try {
      if (pickedShare) {
        await unshareSoundFile(pickedShare.soundId);
        toast(`${pickedMine.name} is no longer shared`, 'ok', 4000);
      } else {
        const file = await loadSoundFile(pickedMine.id);
        if (!file) throw new Error('That is not a sound settings file');
        await shareSoundFile(file);
        toast(`${pickedMine.name} shared — every SingersVoice singer can import it now`, 'ok', 5000);
      }
      await refresh();
    } catch (e) {
      toast(`Could not ${pickedShare ? 'withdraw' : 'share'}: ${errorText(e)}`, 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!pickedMine || !confirm(`Delete the saved sound settings ${pickedMine.name}?${pickedShare ? ' It is withdrawn from the shared list too.' : ''}`)) return;
    setBusy('delete');
    try {
      if (pickedShare) await unshareSoundFile(pickedShare.soundId).catch(() => undefined);
      await deleteSoundFile(pickedMine.id);
      setPicked('');
      toast(`${pickedMine.name} deleted`, 'ok', 4000);
      await refresh();
    } catch (e) {
      toast(`Could not delete: ${errorText(e)}`, 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const others = shared.filter((s) => s.ownerUserId !== me);
  const mineShared = new Set(shared.filter((s) => s.ownerUserId === me).map((s) => s.name));
  return (
    <div class="stack" style="gap:8px" data-sound-settings data-save-sound={saved ? (saved.error ? 'error' : 'ok') : ''}>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn" disabled={busy !== null} onClick={() => void save()} data-save-sound-button>
          {busy === 'save' ? <Spinner /> : null} Save Sound Settings
        </button>
        <span class="small muted">
          {lastSaved ? `Saved as ${lastSaved} in ${where}.` : saved && !saved.error ? `Settings saved ${new Date(saved.at).toLocaleTimeString()} to ${where}.` : saved?.error ? `Not saved: ${saved.error}` : props.compact ? `A file of the whole sound, named by your initials, the date and the time (${where}); saved by itself after every change as well.` : `A file of the whole sound — the preset and its tweaks, the Track / Vocal volume, the tempo and key, what you hear of yourself — named by your initials, the date and the time, in ${where}. Share it with other singers, or import theirs, below. (The settings are also saved by themselves a moment after every change.)`}
        </span>
      </div>
      <Field label="Import Sound Settings" hint={props.compact ? undefined : 'Your saved sound settings files, and the ones other singers have shared. Apply one and every control follows; your own can be shared with everyone or deleted.'}>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <select class="input" value={picked} onChange={(e) => setPicked((e.currentTarget as HTMLSelectElement).value)} data-import-sound style="flex:1;min-width:min(14em, 100%)">
            <option value="">{mine === null ? 'Loading…' : mine.length || others.length ? 'Choose sound settings…' : 'No saved or shared sound settings yet'}</option>
            {mine && mine.length > 0 && (
              <optgroup label={`My saved settings (${where})`}>
                {mine.map((m) => (
                  <option key={m.id} value={`mine:${m.id}`}>
                    {m.name}
                    {mineShared.has(m.name) ? ' · shared' : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Shared by other singers">
                {others.map((s) => (
                  <option key={s.soundId} value={`shared:${s.soundId}`}>
                    {s.name} · {s.ownerName || 'a singer'} · {s.presetId}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button class="btn primary" disabled={!picked || busy !== null} onClick={() => void apply()} data-import-sound-apply>
            {busy === 'apply' ? <Spinner /> : null} Apply
          </button>
          {pickedMine && soundSharingAvailable() && (
            <button class="btn" disabled={busy !== null} onClick={() => void share()} data-share-sound>
              {busy === 'share' ? <Spinner /> : null} {pickedShare ? 'Withdraw share' : 'Share'}
            </button>
          )}
          {pickedMine && (
            <button class="btn danger" disabled={busy !== null} onClick={() => void remove()} data-delete-sound>
              Delete
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}
