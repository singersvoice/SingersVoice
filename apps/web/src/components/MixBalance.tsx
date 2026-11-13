/**
 * Track volume and Vocal volume, up and down in 3 dB steps over ±30 dB: the balance this device mixes at — what
 * a singer's device records and relays to the audience, what the publisher's show view broadcasts.
 * Kept on the device (app settings) until changed. The singer's own monitor ("Hear myself") and
 * the backing level they listen to are separate: these two shape what everyone else gets.
 */
import { MIX_DB_MAX, MIX_DB_MIN } from '../video/showRecorder.ts';
import { appSettings, updateApp } from '../state/settings.ts';

const STEP_DB = 3;
const fmt = (db: number): string => `${db > 0 ? '+' : ''}${db} dB`;

export function MixBalance(props: { compact?: boolean }) {
  const app = appSettings.value;
  const step = (key: 'trackDb' | 'vocalDb', delta: number) => updateApp({ [key]: Math.max(MIX_DB_MIN, Math.min(MIX_DB_MAX, Math.round(app[key] + delta))) });
  const control = (key: 'trackDb' | 'vocalDb', label: string) => (
    <div class="mixctl" data-mix={key} data-db={app[key]}>
      <span class="small">{label}</span>
      <button class="btn icon sm" aria-label={`${label} down`} title={`${label} down ${STEP_DB} dB`} disabled={app[key] <= MIX_DB_MIN} onClick={() => step(key, -STEP_DB)}>
        −
      </button>
      <span class="mono small" style="min-width:5ch;text-align:center">{fmt(app[key])}</span>
      <button class="btn icon sm" aria-label={`${label} up`} title={`${label} up ${STEP_DB} dB`} disabled={app[key] >= MIX_DB_MAX} onClick={() => step(key, STEP_DB)}>
        +
      </button>
    </div>
  );
  return (
    <div class={`mixbalance ${props.compact ? 'compact' : ''}`} role="group" aria-label="Mix balance">
      {control('trackDb', 'Track volume')}
      {control('vocalDb', 'Vocal volume')}
      {(app.trackDb !== 0 || app.vocalDb !== 0) && (
        <button class="btn ghost sm" onClick={() => updateApp({ trackDb: 0, vocalDb: 0 })}>
          Reset
        </button>
      )}
    </div>
  );
}
