/**
 * PUBLISH MODE's two controls — Track volume and Vocal volume, up and down in 1.5 dB steps over ±30 dB: the balance
 * this device mixes at — what a singer's device records and relays to the audience, what the publisher's show view
 * broadcasts. They start at 0 / 0 (audio/gain.ts: the mix itself has the voice in front of the music); Default
 * brings them back there. Kept on the device (app settings) and in the Config folder until changed. The singer's
 * own ears are PERFORMER MODE and separate (`EarsLevel` below, and the backing level they listen to): these two
 * shape what everyone else gets. The guard and the limiter behind them keep the whole under the ceiling whatever
 * they are set to.
 */
import { MIX_DB_MAX, MIX_DB_MIN, MIX_STEP_DB, MIX_TRACK_DEFAULT_DB, MIX_VOCAL_DEFAULT_DB } from '../audio/gain.ts';
import type { AudioEngine } from '../audio/engine.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../state/settings.ts';

/** +1.6 dB, −3 dB, 0 dB: one decimal where there is one. */
const fmt = (db: number): string => `${db > 0 ? '+' : ''}${Number.isInteger(db) ? db : db.toFixed(1)} dB`;
/** The same, with what it means to the ear: a fifth louder, a third quieter. */
export const dbNote = (db: number): string => {
  const pct = Math.round((Math.pow(10, db / 20) - 1) * 100);
  return pct === 0 ? 'as mixed' : `${pct > 0 ? '+' : ''}${pct} %`;
};
const clamp = (db: number): number => Math.round(Math.max(MIX_DB_MIN, Math.min(MIX_DB_MAX, db)) * 10) / 10;

export function MixBalance(props: { compact?: boolean }) {
  const app = appSettings.value;
  const step = (key: 'trackDb' | 'vocalDb', delta: number) => updateApp({ [key]: clamp(app[key] + delta) });
  const atDefault = app.trackDb === MIX_TRACK_DEFAULT_DB && app.vocalDb === MIX_VOCAL_DEFAULT_DB;
  const control = (key: 'trackDb' | 'vocalDb', label: string) => (
    <div class="mixctl" data-mix={key} data-db={app[key]}>
      <span class="small">{label}</span>
      <button class="btn icon sm" aria-label={`${label} down`} title={`${label} down ${MIX_STEP_DB} dB`} disabled={app[key] <= MIX_DB_MIN} onClick={() => step(key, -MIX_STEP_DB)}>
        −
      </button>
      <span class="mono small" style="min-width:6.5ch;text-align:center" title={dbNote(app[key])}>
        {fmt(app[key])}
      </span>
      <button class="btn icon sm" aria-label={`${label} up`} title={`${label} up ${MIX_STEP_DB} dB`} disabled={app[key] >= MIX_DB_MAX} onClick={() => step(key, MIX_STEP_DB)}>
        +
      </button>
    </div>
  );
  return (
    <div class={`mixbalance ${props.compact ? 'compact' : ''}`} role="group" aria-label="Mix balance">
      {control('trackDb', 'Track volume')}
      {control('vocalDb', 'Vocal volume')}
      {!atDefault && (
        <button class="btn ghost sm" title={`Back to the defaults: track ${fmt(MIX_TRACK_DEFAULT_DB)}, vocal ${fmt(MIX_VOCAL_DEFAULT_DB)}`} onClick={() => updateApp({ trackDb: MIX_TRACK_DEFAULT_DB, vocalDb: MIX_VOCAL_DEFAULT_DB })} data-mix-default>
          Default
        </button>
      )}
    </div>
  );
}

/** The ears' own range (dB) and its default: the performer level (loudness.ts PERFORMER_MONITOR, about half as loud as the published voice). */
export const EARS_DB_MIN = -24;
export const EARS_DB_MAX = 24;
export const EARS_DEFAULT_DB = 0;

/**
 * PERFORMER MODE's control — Your voice in your ears: how loud a singer hears themselves (Hear myself) relative to the
 * performer level, in 1.5 dB steps over ±24 dB; 0 is the mode's own level, about half as loud as the published voice. Kept
 * in the audio settings (the device, the Config folder). It never touches the recording, the film or the broadcast.
 */
export function EarsLevel(props: { compact?: boolean }) {
  const audio = audioSettings.value;
  const db = audio.monitorDb;
  const set = (v: number) => updateAudio({ monitorDb: Math.round(Math.max(EARS_DB_MIN, Math.min(EARS_DB_MAX, v)) * 10) / 10 });
  return (
    <div class={`mixbalance ${props.compact ? 'compact' : ''}`} role="group" aria-label="Your voice in your ears">
      <div class="mixctl" data-mix="monitorDb" data-db={db}>
        <span class="small">Your voice in your ears</span>
        <button class="btn icon sm" aria-label="Your voice in your ears down" title={`Down ${MIX_STEP_DB} dB`} disabled={db <= EARS_DB_MIN} onClick={() => set(db - MIX_STEP_DB)}>
          −
        </button>
        <span class="mono small" style="min-width:6.5ch;text-align:center" title={db === 0 ? 'about half as loud as in the recording' : dbNote(db)}>
          {fmt(db)}
        </span>
        <button class="btn icon sm" aria-label="Your voice in your ears up" title={`Up ${MIX_STEP_DB} dB`} disabled={db >= EARS_DB_MAX} onClick={() => set(db + MIX_STEP_DB)}>
          +
        </button>
      </div>
      {db !== EARS_DEFAULT_DB && (
        <button class="btn ghost sm" title="Back to the performer level: about half as loud as in the recording" onClick={() => set(EARS_DEFAULT_DB)} data-ears-default>
          Default
        </button>
      )}
    </div>
  );
}

/**
 * PERFORMER MODE's delay, said plainly for the singer who hears their own voice a moment late: how long the voice takes
 * from the microphone to their ears (the app's part — the chain's few milliseconds — and the device's: its microphone
 * in and speakers out, measured by the sync check or a take where it has been, else the browser's figures) and the one
 * thing that shortens it. Nothing here is a setting: the app's part is already the least the chain can do.
 */
export function EarsDelayNote(props: { engine: AudioEngine | null }) {
  const e = props.engine;
  if (!e) return null;
  const chain = Math.round(e.chainLatencyMs);
  const device = Math.round(e.deviceLatencyMs);
  const total = chain + device;
  const measured = e.measuredDeviceMs !== null;
  return (
    <p class="small muted" data-ears-delay={`${total}:${chain}:${device}:${measured ? 'measured' : 'reported'}`}>
      You hear yourself about {total} ms after you sing: {chain} ms is the app, {device} ms is this device ({measured ? 'measured' : "the browser's figure"}). Wired headphones are the quickest; Bluetooth adds 100–200 ms of its own.
    </p>
  );
}
