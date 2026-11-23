/** The device's Track / Vocal controls: dB offsets on a mix that is already balanced (see mixBus.ts). */
export const MIX_DB_MIN = -30;
export const MIX_DB_MAX = 30;
/**
 * Where the two controls start: the track a fifth louder than the balanced mix has it (+20 %, 1.6 dB) and the
 * vocal seven tenths louder (+70 %, 4.6 dB) — the voice clearly in front of the music in every recording, mix and
 * broadcast, the way the singer hears it in their own ears; the guard and the limiter behind the controls keep the
 * whole under the ceiling, whatever the two are set to. A singer's own setting replaces them (MixBalance).
 */
export const MIX_TRACK_DEFAULT_DB = 1.6;
export const MIX_VOCAL_DEFAULT_DB = 4.6;
/** One step of the Track / Vocal controls. */
export const MIX_STEP_DB = 1.5;
export const dbToGain = (db: number): number => Math.pow(10, Math.max(MIX_DB_MIN, Math.min(MIX_DB_MAX, db)) / 20);
