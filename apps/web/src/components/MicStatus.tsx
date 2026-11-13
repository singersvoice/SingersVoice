/**
 * What the microphone is really giving us, where the singer can see it: the device, its sample
 * rate (a Bluetooth headset's mic is phone-call quality, 8–16 kHz — the usual "my voice sounds
 * terrible"), the automatic level, and two things to change on the spot: the microphone, and
 * speakers vs headphones (echo cancellation only when the track plays out of speakers).
 */
import { useEffect, useState } from 'preact/hooks';
import type { AudioEngine } from '../audio/engine.ts';
import { appSettings, updateApp } from '../state/settings.ts';

export function MicStatus(props: { engine: AudioEngine | null; onChange?: () => void }) {
  const info = props.engine?.inputInfo.value ?? null;
  const trim = props.engine?.inputTrimDb.value ?? 0;
  const app = appSettings.value;
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakersOut, setSpeakersOut] = useState(false);
  useEffect(() => {
    if (!info) return;
    void navigator.mediaDevices?.enumerateDevices?.().then((d) => {
      setMics(d.filter((x) => x.kind === 'audioinput'));
      // The sound goes out through speakers (by the default output's name) → the track will leak into the mic unless echo cancellation is on.
      const outs = d.filter((x) => x.kind === 'audiooutput');
      const def = outs.find((x) => x.deviceId === 'default') ?? outs[0];
      setSpeakersOut(Boolean(def && /speaker/i.test(def.label) && !/head|ear|bud|airpod/i.test(def.label)));
    });
  }, [info?.label]);
  if (!info) return null;
  const khz = info.sampleRate ? `${Math.round(info.sampleRate / 1000)} kHz` : '';
  return (
    <div class={`micstatus ${info.narrowband ? 'warn' : ''}`} data-mic-rate={info.sampleRate ?? ''}>
      <div class="row between">
        <span class="small">
          <b>Mic</b> {info.label || 'Microphone'}
          {khz && ` · ${khz}`}
          {trim !== 0 && ` · auto level ${trim > 0 ? '+' : ''}${trim} dB`}
          {info.narrowband && <span class="chip warn">phone-call quality</span>}
        </span>
        <label class="small row" style="gap:6px">
          <input
            type="checkbox"
            checked={app.echoCancellation}
            onChange={(e) => {
              updateApp({ echoCancellation: (e.currentTarget as HTMLInputElement).checked });
              props.onChange?.();
            }}
          />
          <span title="On speakers the track leaks into the mic; echo cancellation takes it back out. With headphones leave this off for the cleanest voice.">I'm on speakers</span>
        </label>
      </div>
      {info.narrowband && (
        <div class="small">
          This microphone is a phone-call line (a Bluetooth headset's mic): the voice comes in thin and muffled. Keep listening on the headset if you like, but sing into another microphone:
        </div>
      )}
      {speakersOut && !app.echoCancellation && (
        <div class="small" data-mic-speakers-hint>
          The sound is coming out of speakers: tick “I'm on speakers” so the track does not leak into your recording — or put on headphones for the cleanest voice.
        </div>
      )}
      {(info.narrowband || mics.length > 1) && (
        <select
          class="input"
          value={app.audioInputId}
          aria-label="Microphone"
          onChange={(e) => {
            updateApp({ audioInputId: (e.currentTarget as HTMLSelectElement).value });
            props.onChange?.();
          }}
        >
          <option value="">Default microphone</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label || `Microphone ${m.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
