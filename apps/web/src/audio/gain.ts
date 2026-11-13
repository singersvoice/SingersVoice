/** The device's Track / Vocal controls: dB offsets on a mix that is already balanced (see mixBus.ts). */
export const MIX_DB_MIN = -30;
export const MIX_DB_MAX = 30;
export const dbToGain = (db: number): number => Math.pow(10, Math.max(MIX_DB_MIN, Math.min(MIX_DB_MAX, db)) / 20);
