import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  bestClockOffset,
  clampParams,
  clockOffsetMs,
  emptyStage,
  fedDestinations,
  MAX_PERFORMERS,
  meetIsOpen,
  RELAY_KINDS,
  sameSong,
  songPlace,
  newJoinCode,
  localStamp,
  performanceFolderName,
  performanceVideoName,
  tempExpiry,
  totalSemitones,
  VOXFORGE_DEFAULTS,
  VOXFORGE_PRESETS,
} from '../src/index.ts';

describe('meet helpers', () => {
  it('builds a 10-slot stage', () => {
    expect(emptyStage()).toHaveLength(MAX_PERFORMERS);
    expect(emptyStage()[9]!.slot).toBe(10);
  });
  it('computes NTP-style offsets and picks the median of the fastest samples', () => {
    const { offsetMs, rttMs } = clockOffsetMs(1000, 1500, 1200);
    expect(rttMs).toBe(200);
    expect(offsetMs).toBe(400);
    const best = bestClockOffset([
      { offsetMs: 400, rttMs: 200 },
      { offsetMs: 420, rttMs: 180 },
      { offsetMs: 900, rttMs: 2000 }, // slow outlier is dropped
      { offsetMs: 410, rttMs: 190 },
    ]);
    expect(best.offsetMs).toBe(410);
    expect(best.rttMs).toBe(180);
  });
  it('join codes are 6 unambiguous characters', () => {
    const c = newJoinCode();
    expect(c).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(meetIsOpen({ state: 'lobby' })).toBe(true);
    expect(meetIsOpen({ state: 'expired' })).toBe(false);
  });
});

describe('performance helpers', () => {
  it('temp expiry is 7 days out', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(tempExpiry(from)).toBe('2026-01-08T00:00:00.000Z');
  });
  it('folder name is sortable, in local time, and names the meet by title and id', () => {
    const at = '2026-01-02T03:04:05.000Z';
    const stamp = localStamp(at);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{4}$/);
    expect(performanceFolderName({ createdAt: at, trackTitle: 'AA', performanceId: 'perf-abc123' })).toBe(`${stamp} AA (abc123)`);
    expect(performanceFolderName({ createdAt: at, trackTitle: 'Ammo', performanceId: 'perf-abc123', meetId: 'meet-mwe8q644-onrv6m', meetTitle: 'Friday Meet' })).toBe(
      `${stamp} Ammo · Friday Meet [mwe8q644-onrv6m] (abc123)`,
    );
    expect(localStamp('not a date')).toBe('not a date');
  });
  it('the saved show is named for the people a link reaches: song, meet (with id), moment', () => {
    const at = '2026-11-12T03:04:05.000Z';
    const stamp = localStamp(at);
    expect(performanceVideoName({ createdAt: at, trackTitle: 'Ammo', meetId: 'meet-mwe8q644-onrv6m', meetTitle: 'Friday Meet' }, 'mp4')).toBe(`Ammo · Friday Meet [mwe8q644-onrv6m] · ${stamp}.mp4`);
    expect(performanceVideoName({ createdAt: at, trackTitle: 'A/B: "C"?', meetTitle: null }, 'webm')).toBe(`A B C · ${stamp}.webm`);
    expect(performanceVideoName({ createdAt: at, trackTitle: '   ' }, 'mp4')).toBe(`Performance · ${stamp}.mp4`);
  });
  it('the same song is told by its ids, or by title and length (a singer\'s own copy of a shared song)', () => {
    const m = { trackId: 't1', catalogTrackId: 'c1', trackTitle: 'Ammo Ammaayena', currentDurationMs: 283_000, setList: [{ id: 's2', trackId: null, catalogTrackId: 'c2', trackTitle: 'Second', durationMs: 200_000, pickedBy: 'p', pickedByName: 'P', addedAt: '' }] };
    expect(songPlace(m, { trackId: 'own', catalogTrackId: 'c1', trackTitle: 'x' })).toEqual({ place: 'current' });
    expect(songPlace(m, { trackId: 'own', catalogTrackId: null, trackTitle: '  ammo   ammaayena ', durationMs: 283_900 })).toEqual({ place: 'current' });
    expect(songPlace(m, { trackId: 'own', catalogTrackId: null, trackTitle: 'Ammo Ammaayena', durationMs: 240_000 })).toBeNull(); // a namesake of another length
    expect(songPlace(m, { trackId: null, catalogTrackId: 'c2', trackTitle: 'whatever' })?.place).toBe('queued');
    expect(songPlace(m, { trackId: 'own', catalogTrackId: null, trackTitle: 'Second' })?.place).toBe('queued'); // no length known: the title decides
    expect(songPlace({ ...m, trackId: null, catalogTrackId: null, trackTitle: '' }, { trackId: 't1', catalogTrackId: null, trackTitle: 'Ammo Ammaayena' })).toBeNull();
    expect(sameSong({ trackId: 'a', catalogTrackId: null, trackTitle: 'One' }, { trackId: 'b', catalogTrackId: null, trackTitle: 'Two' })).toBe(false);
    expect(sameSong({ trackId: 'c9', catalogTrackId: null, trackTitle: 'One' }, { trackId: 'c9-copy-bob', catalogTrackId: null, trackTitle: 'Other title' })).toBe(true); // a pulled copy is its catalog entry
    expect(sameSong({ trackId: 'c9-copy-al', catalogTrackId: null, trackTitle: 'One' }, { trackId: null, catalogTrackId: 'c9', trackTitle: 'x' })).toBe(true);
  });
  it('which destinations the publisher\'s browser can feed: the watch page and YouTube alone, every RTMP platform with the relay', () => {
    const all = ['youtube', 'facebook', 'instagram', 'twitch', 'inhouse'] as const;
    expect(fedDestinations([...all], false)).toEqual(['youtube', 'inhouse']);
    expect(fedDestinations([...all], true)).toEqual([...all]);
    expect(fedDestinations(['twitch'], false)).toEqual([]);
    expect(RELAY_KINDS).toEqual(['youtube', 'facebook', 'instagram', 'twitch']);
  });
});

describe('voxforge params', () => {
  it('clamps out-of-range values and keeps booleans', () => {
    const p = clampParams({ hpfHz: 9999, cRat: -5, rvOn: false });
    expect(p.hpfHz).toBe(400);
    expect(p.cRat).toBe(1);
    expect(p.rvOn).toBe(false);
  });
  it('presets apply on top of defaults and keep gains', () => {
    const base = { ...VOXFORGE_DEFAULTS, inGain: 3 };
    const hard = applyPreset(base, VOXFORGE_PRESETS.find((p) => p.id === 'robot')!);
    expect(hard.autoStr).toBe(1);
    expect(hard.inGain).toBe(3);
    expect(totalSemitones({ ...hard, octave: -1, pitchSt: 2, pitchCt: 50 })).toBeCloseTo(-9.5);
  });
  it('the finished-vocal presets exist, stay within range and switch the polish stages on', () => {
    for (const id of ['studio', 'tune', 'punch', 'upfront', 'radio', 'vibrant']) {
      const preset = VOXFORGE_PRESETS.find((p) => p.id === id);
      expect(preset, id).toBeDefined();
      const p = applyPreset(VOXFORGE_DEFAULTS, preset!);
      expect(clampParams(p)).toEqual(p); // every value inside its range
      expect(p.dsOn && p.rdOn && p.pcOn, `${id} polish`).toBe(true);
    }
    expect(applyPreset(VOXFORGE_DEFAULTS, VOXFORGE_PRESETS.find((p) => p.id === 'tune')!).autoStr).toBeGreaterThan(0.5);
    expect(applyPreset(VOXFORGE_DEFAULTS, VOXFORGE_PRESETS.find((p) => p.id === 'punch')!).cRat).toBeLessThanOrEqual(2.5); // punch without over-compression
    // Settings saved by older builds carry no polish keys: they come back as the defaults.
    const old = clampParams({ hpfHz: 90, eqHi: 2 } as never);
    expect(old.dsOn).toBe(true);
    expect(old.rdOn).toBe(false);
    expect(old.eqPres).toBe(VOXFORGE_DEFAULTS.eqPres);
  });
});
