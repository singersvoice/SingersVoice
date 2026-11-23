/** The device's Track / Vocal controls: dB offsets on a mix that is already balanced (see mixBus.ts). */
export const MIX_DB_MIN = -30;
export const MIX_DB_MAX = 30;
/**
 * Where the two controls start: at 0 / 0 — the mix itself is right (loudness.ts MIX_TARGETS: the music full at
 * −16 LUFS, the voice in front at −11, ducked under, the whole near a record's −10 LUFS); the controls are the
 * singer's own balance on top of it, in 1.5 dB steps, in every recording, mix and broadcast. (An earlier build
 * started them at +1.6 / +4.6 dB to make up for a mix that was not right; a save still on those takes the new
 * start once — settings.ts.)
 */
export const MIX_TRACK_DEFAULT_DB = 0;
export const MIX_VOCAL_DEFAULT_DB = 0;
/** One step of the Track / Vocal controls. */
export const MIX_STEP_DB = 1.5;
export const dbToGain = (db: number): number => Math.pow(10, Math.max(MIX_DB_MIN, Math.min(MIX_DB_MAX, db)) / 20);
