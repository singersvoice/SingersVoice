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
 * - Save my sound: the settings written to the Config folder now (Drive › SingersVoice › Config, or this device),
 *   with the word on when it was done. They are saved by themselves a moment after every change as well; this is
 *   for the singer who wants to see it done.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { getEngine, type AudioEngine } from '../audio/engine.ts';
import { MixBus } from '../audio/mixBus.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive } from '../state/session.ts';
import { appSettings, audioSettings, saveSettingsNow, settingsSaved } from '../state/settings.ts';
import { IcHeadphones, IcMic, IcStop } from './icons.tsx';
import { LevelDot } from './MicStatus.tsx';
import { Spinner } from './ui.tsx';

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

export function SaveSoundButton(props: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const saved = settingsSaved.value;
  const where = isDrive.value ? 'Drive › SingersVoice › Config' : 'this device';
  const save = async () => {
    setBusy(true);
    try {
      await saveSettingsNow();
      toast(`Sound settings saved to ${where}`, 'ok', 4000);
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error', 8000, { label: 'Retry', onClick: () => void save() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap" data-save-sound={saved ? (saved.error ? 'error' : 'ok') : ''}>
      <button class="btn" disabled={busy} onClick={() => void save()} data-save-sound-button>
        {busy ? <Spinner /> : null} Save my sound
      </button>
      <span class="small muted">
        {saved && !saved.error ? `Saved ${new Date(saved.at).toLocaleTimeString()} to ${where}` : saved?.error ? `Not saved: ${saved.error}` : props.compact ? `Saved by itself after every change (${where}).` : `The preset, its tweaks, the Track / Vocal volume, the microphone: saved by themselves a moment after every change, to ${where}, and back on every start and every stage.`}
      </span>
    </div>
  );
}
