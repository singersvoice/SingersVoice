import { describe, expect, it } from 'vitest';
import { AUDIO_SETTINGS_DEFAULTS, initialsOf, parseSoundSettings, SOUND_NAME, SOUND_SETTINGS_SCHEMA, soundSettingsName, VOXFORGE_RANGES } from '../src/index.ts';

describe('sound settings files (sounds.ts)', () => {
  it('names a file by the initials, the date and the time', () => {
    expect(initialsOf('Hari Narayan')).toBe('HN');
    expect(initialsOf('madonna')).toBe('M');
    expect(initialsOf('Jean-Luc de la Fontaine')).toBe('JLD');
    expect(initialsOf('')).toBe('SV');
    expect(initialsOf('  ')).toBe('SV');
    const name = soundSettingsName('Hari Narayan', new Date(2026, 10, 24, 20, 51, 30));
    expect(name).toBe('HN_20261124_205130');
    expect(SOUND_NAME.test(name)).toBe(true);
    expect(SOUND_NAME.test('my sound')).toBe(false);
  });

  it('reads a file back checked and clamped; anything else is null', () => {
    expect(parseSoundSettings(null)).toBeNull();
    expect(parseSoundSettings({ schema: 'other' })).toBeNull();
    expect(parseSoundSettings({ schema: SOUND_SETTINGS_SCHEMA })).toBeNull();
    const f = parseSoundSettings({
      schema: SOUND_SETTINGS_SCHEMA,
      name: 'HN_20261124_205130',
      ownerName: 'Hari',
      createdAt: '2026-11-24T20:51:30.000Z',
      audio: { ...AUDIO_SETTINGS_DEFAULTS, activePresetId: 'no-such-preset', params: { ...AUDIO_SETTINGS_DEFAULTS.params, eqPres: 50, gtAmt: -3, hpfHz: 'x' }, tempo: 9, keyShift: -2.4, monitorDb: 100, backingGain: 2, extra: 'dropped' },
      balance: { trackDb: -99, vocalDb: 'loud' },
    })!;
    expect(f).not.toBeNull();
    expect(f.name).toBe('HN_20261124_205130');
    expect(f.audio.activePresetId).toBe('custom'); // an unknown preset id becomes custom (the params carry the sound)
    expect(f.audio.params.eqPres).toBe(VOXFORGE_RANGES.eqPres.max);
    expect(f.audio.params.gtAmt).toBe(0);
    expect(f.audio.params.hpfHz).toBe(AUDIO_SETTINGS_DEFAULTS.params.hpfHz);
    expect(f.audio.tempo).toBe(1.5);
    expect(f.audio.keyShift).toBe(-2);
    expect(f.audio.monitorDb).toBe(24);
    expect(f.audio.backingGain).toBe(1);
    expect((f.audio as unknown as { extra?: string }).extra).toBeUndefined();
    expect(f.balance).toEqual({ trackDb: -30, vocalDb: 0 });
    // A known preset and a user preset of the file's own are kept.
    const g = parseSoundSettings({ schema: SOUND_SETTINGS_SCHEMA, name: 'x', audio: { activePresetId: 'mine', userPresets: [{ id: 'mine', name: 'Mine', params: { eqHi: 2 } }] }, balance: {} })!;
    expect(g.audio.activePresetId).toBe('mine');
    expect(g.audio.userPresets[0]!.params.eqHi).toBe(2);
    expect(SOUND_NAME.test(g.name)).toBe(true); // a bad name is replaced by a fresh one
    expect(parseSoundSettings({ schema: SOUND_SETTINGS_SCHEMA, audio: { activePresetId: 'warm' }, balance: {} })!.audio.activePresetId).toBe('warm');
  });
});
