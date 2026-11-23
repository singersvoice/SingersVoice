/** The device's Track / Vocal controls: dB offsets on a mix that is already balanced (see mixBus.ts). */
export const MIX_DB_MIN = -30;
export const MIX_DB_MAX = 30;
/**
 * Where the two controls start: at 0 / 0 — the mix itself is right (loudness.ts PUBLISH_MIX: the music full at
 * −16 LUFS, the voice in front at −9, ducked under, the whole near a record's −10 LUFS); the controls are the
 * singer's own PUBLISH MODE balance on top of it, in 1.5 dB steps, in every recording, mix and broadcast — what
 * the singer hears of themselves (PERFORMER MODE) is a setting of its own (audio settings `monitorDb`). (Earlier
 * builds started them elsewhere, or had balances set to make up for a mix that was not right; every stored
 * balance took the 0 / 0 start once on 23 Nov — settings.ts `mixV4`.)
 */
export const MIX_TRACK_DEFAULT_DB = 0;
export const MIX_VOCAL_DEFAULT_DB = 0;
/** One step of the Track / Vocal controls. */
export const MIX_STEP_DB = 1.5;
export const dbToGain = (db: number): number => Math.pow(10, Math.max(MIX_DB_MIN, Math.min(MIX_DB_MAX, db)) / 20);
