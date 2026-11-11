import { describe, expect, it } from 'vitest';
import {
  activeLineIndex,
  assignSlots,
  autoSpace,
  cleanV1Text,
  createTrack,
  cueDeck,
  importTrackV1,
  lyricsWindow,
  normalizeLyrics,
  parseLrc,
  toLrc,
  validateTrack,
  type LyricLine,
  type TrackMakerV1,
} from '../src/index.ts';

const lines: LyricLine[] = [
  { startMs: 1000, endMs: 2000, text: 'one', singerSlot: 1 },
  { startMs: 2000, endMs: 3000, text: 'two', singerSlot: 2 },
  { startMs: 3000, endMs: 4000, text: 'three', singerSlot: 1 },
  { startMs: 4000, endMs: 5000, text: 'four', singerSlot: 0 },
  { startMs: 5000, endMs: 6000, text: 'five', singerSlot: 2 },
];

describe('activeLineIndex', () => {
  it('is -1 before the first line and finds lines by binary search', () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 1000)).toBe(0);
    expect(activeLineIndex(lines, 2999)).toBe(1);
    expect(activeLineIndex(lines, 99999)).toBe(4);
  });
});

describe('lyricsWindow', () => {
  it('returns 1 done + active + 3 upcoming with progress', () => {
    const w = lyricsWindow(lines, 3500);
    expect(w.active).toBe(2);
    expect(w.items.map((i) => i.state)).toEqual(['done', 'active', 'upcoming', 'upcoming']);
    expect(w.progress).toBeCloseTo(0.5);
    expect(w.msToNext).toBe(500);
  });
  it('shows upcoming lines before the song starts', () => {
    const w = lyricsWindow(lines, 0);
    expect(w.active).toBe(-1);
    expect(w.items.map((i) => i.index)).toEqual([0, 1, 2]);
  });
});

describe('cueDeck', () => {
  it('lists the next lines for a slot, including everyone lines', () => {
    expect(cueDeck(lines, 1500, 2).map((l) => l.text)).toEqual(['two', 'four', 'five']);
  });
});

describe('normalizeLyrics', () => {
  it('sorts, trims, drops empties, repairs ends and clamps to duration', () => {
    const out = normalizeLyrics(
      [
        { startMs: 5000, endMs: 0, text: ' b ', singerSlot: 2 },
        { startMs: 1000, endMs: 9000, text: 'a', singerSlot: 99 as never },
        { startMs: 2000, endMs: 2500, text: '   ', singerSlot: 1 },
      ],
      6000,
    );
    expect(out.map((l) => l.text)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ startMs: 1000, endMs: 5000, singerSlot: 10 });
    expect(out[1]).toMatchObject({ startMs: 5000, endMs: 6000 });
  });
});

describe('import v1', () => {
  it('converts the SVOld trackmaker file and cleans break markers', () => {
    const v1: TrackMakerV1 = {
      schema: 'singersvoice.trackmaker.v1',
      trackId: 'trackmaker-1',
      title: 'AA',
      artist: 'SV TrackMaker',
      durationMs: 283506,
      bpm: 96,
      keySignature: 'C',
      lyrics: [
        { startMs: 14909, endMs: 17983, text: 'అమ్మో అమ్మాయేనా', singerSlot: 1 },
        { startMs: 217032, endMs: 222449, text: 'నువ్వే దగ్గరైతే\\\\\\హాయి లోన తేలిపోతా', singerSlot: 4 },
        { startMs: 225299, endMs: 227658, text: 'సరా\\\\గా//ల\\\\సంబ\\\\\\ర\\మవు//తా//??', singerSlot: 1 },
      ],
    };
    const t = importTrackV1(v1);
    expect(t.schema).toBe('singersvoice.track.v2');
    expect(t.trackId).toBe('trk-trackmaker-1');
    expect(t.lyrics).toHaveLength(3);
    expect(t.lyrics[1]!.text).toBe('నువ్వే దగ్గరైతే\nహాయి లోన తేలిపోతా');
    expect(t.lyrics[2]!.text).toBe('సరా\nగా\nల\nసంబ\nర\nమవు\nతా');
    expect(t.singerCount).toBe(4);
    expect(t.origin).toBe('import-v1');
  });
  it('rejects other schemas', () => {
    expect(() => importTrackV1({ schema: 'nope' } as never)).toThrow();
  });
  it('cleanV1Text handles plain text', () => {
    expect(cleanV1Text('hello')).toBe('hello');
  });
});

describe('LRC', () => {
  it('parses timestamps, singer markers and metadata; round-trips through toLrc', () => {
    const { lines: parsed, meta } = parseLrc('[ti:Song]\n[ar:Me]\n[00:01.00]v1: first\n[00:02.50]v2: second\n[00:04.00]D: both');
    expect(meta.ti).toBe('Song');
    expect(parsed.map((l) => [l.startMs, l.singerSlot, l.text])).toEqual([
      [1000, 1, 'first'],
      [2500, 2, 'second'],
      [4000, 0, 'both'],
    ]);
    const lrc = toLrc({ title: 'Song', artist: 'Me', lyrics: parsed });
    expect(lrc).toContain('[00:02.50]v2: second');
    expect(parseLrc(lrc).lines).toEqual(parsed);
  });
});

describe('slots & spacing', () => {
  it('assigns patterns', () => {
    expect(assignSlots(4, 2, 'alternate')).toEqual([1, 2, 1, 2]);
    expect(assignSlots(3, 5, 'solo')).toEqual([1, 1, 1]);
    expect(assignSlots(12, 2, 'duet-verse').slice(8, 12)).toEqual([0, 0, 0, 0]);
  });
  it('auto-spaces a range', () => {
    const spaced = autoSpace(lines, 1, 3, 1500, 3900);
    expect(spaced.slice(1, 4).map((l) => l.startMs)).toEqual([1500, 2300, 3100]);
    expect(spaced[3]!.endMs).toBe(3900);
    expect(spaced[4]!.startMs).toBe(5000);
  });
});

describe('validateTrack', () => {
  it('flags missing audio and over-length tracks', () => {
    const t = createTrack({ title: 'x', durationMs: 16 * 60 * 1000, lyrics: [] });
    const msgs = validateTrack(t).map((i) => i.message);
    expect(msgs).toContain('Tracks are limited to 15 minutes');
    expect(msgs).toContain('A backing track audio file is required');
  });
});
