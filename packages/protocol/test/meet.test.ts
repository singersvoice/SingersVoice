import { describe, expect, it } from 'vitest';
import { clockOffsetMs, emptyStage, MAX_PERFORMERS, performanceFolderName, tempExpiry, applyPreset, clampParams, totalSemitones, VOXFORGE_DEFAULTS, VOXFORGE_PRESETS } from '../src/index.ts';

describe('meet', () => {
  it('builds a 10-slot stage', () => {
    expect(emptyStage()).toHaveLength(MAX_PERFORMERS);
    expect(emptyStage()[9]!.slot).toBe(10);
  });
  it('computes NTP-style offsets', () => {
    const { offsetMs, rttMs } = clockOffsetMs(1000, 1500, 1200);
    expect(rttMs).toBe(200);
    expect(offsetMs).toBe(400);
  });
});

describe('performance helpers', () => {
  it('temp expiry is 7 days out', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(tempExpiry(from)).toBe('2026-01-08T00:00:00.000Z');
  });
  it('folder name is sortable and human readable', () => {
    expect(performanceFolderName({ createdAt: '2026-01-02T03:04:05.000Z', trackTitle: 'AA', performanceId: 'perf-abc123' })).toBe(
      '2026-01-02 0304 AA (abc123)',
    );
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
});
