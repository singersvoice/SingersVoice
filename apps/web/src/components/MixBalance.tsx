/**
 * Track volume and Vocal volume, up and down in 1.5 dB steps over ±30 dB: the balance this device mixes at — what
 * a singer's device records and relays to the audience, what the publisher's show view broadcasts. They start at
 * the track a fifth up and the vocal seven tenths up (audio/gain.ts: the voice in front of the music); Default
 * brings them back there. Kept on the device (app settings) and in the Config folder until changed. The singer's
 * own monitor ("Hear myself") and the backing level they listen to are separate: these two shape what everyone
 * else gets. The guard and the limiter behind them keep the whole mix under the ceiling whatever they are set to.
 */
import { MIX_DB_MAX, MIX_DB_MIN, MIX_STEP_DB, MIX_TRACK_DEFAULT_DB, MIX_VOCAL_DEFAULT_DB } from '../audio/gain.ts';
import { appSettings, updateApp } from '../state/settings.ts';

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
