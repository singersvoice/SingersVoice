import { describe, expect, it } from 'vitest';
import {
  activeLineIndex,
  assignSlots,
  autoSpace,
  cleanLyricText,
  cleanV1Text,
  createTrack,
  cueDeck,
  cueDeckFor,
  importTrackV1,
  isMyLine,
  partColor,
  partLabel,
  partSingers,
  planParts,
  SLOT_COLORS,
  normalizeTrack,
  lyricsPace,
  lyricsWindow,
  normalizeLyrics,
  PACE_DEFAULT_MS,
  sungChars,
  sungSpanMs,
  parseLrc,
  toLrc,
  validateTrack,
  type LyricLine,
  type SingerSlot,
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
  it('a lead lights the next line a breath early, its fill still starting on time', () => {
    const w = lyricsWindow(lines, 2900, 1, 3, { leadMs: 150 });
    expect(w.active).toBe(2); // "three" starts at 3000
    expect(w.progress).toBe(0);
    expect(lyricsWindow(lines, 2800, 1, 3, { leadMs: 150 }).active).toBe(1);
  });
  it('fills a line over the time its words take, not over the pause after it', () => {
    const song: LyricLine[] = [
      { startMs: 0, endMs: 2000, text: 'ten letters!', singerSlot: 1 }, // 10 sung chars in 2 s → 200 ms/char
      { startMs: 2000, endMs: 4000, text: 'ten letters', singerSlot: 1 },
      { startMs: 4000, endMs: 6000, text: 'ten letters', singerSlot: 1 },
      { startMs: 6000, endMs: 12000, text: 'ten letters', singerSlot: 1 }, // then a 4 s instrumental
      { startMs: 12000, endMs: 14000, text: 'fin', singerSlot: 1 },
    ];
    const pace = lyricsPace(song);
    expect(pace).toBe(200);
    expect(sungSpanMs(song[3]!, pace)).toBe(2000); // the words, not the six-second span
    expect(sungSpanMs(song[0]!, pace)).toBe(2000); // never past the line's own span
    const w = lyricsWindow(song, 7000, 1, 3, { paceMsPerChar: pace });
    expect(w.progress).toBeCloseTo(0.5); // halfway through the words, not a sixth of the way through the span
    expect(lyricsWindow(song, 9000, 1, 3, { paceMsPerChar: pace }).progress).toBe(1); // sung: the line stays lit
    expect(lyricsWindow(song, 7000, 1, 3).progress).toBeCloseTo(1 / 6); // without a pace: the old stretch
    expect(sungChars('అలా చూడకయ్యా, ok!')).toBe(13);
    expect(lyricsPace(song.slice(0, 2))).toBe(PACE_DEFAULT_MS); // too few lines to measure
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
    // SVOld's stray markers never meant line breaks: every lyric line is one row.
    expect(t.lyrics[1]!.text).toBe('నువ్వే దగ్గరైతే హాయి లోన తేలిపోతా');
    expect(t.lyrics[2]!.text).toBe('సరా గా ల సంబ ర మవు తా');
    expect(t.singerCount).toBe(4);
    expect(t.origin).toBe('import-v1');
  });
  it('rejects other schemas', () => {
    expect(() => importTrackV1({ schema: 'nope' } as never)).toThrow();
  });
  it('cleanV1Text handles plain text', () => {
    expect(cleanV1Text('hello')).toBe('hello');
  });
  it('cleanLyricText collapses markers and embedded breaks, keeps a lone slash', () => {
    expect(cleanLyricText('చెలి\\నువ్వు\\అవునంటే//??')).toBe('చెలి నువ్వు అవునంటే');
    expect(cleanLyricText('one\ntwo\r\nthree')).toBe('one two three');
    expect(cleanLyricText('rock/roll  tonight??')).toBe('rock/roll tonight');
    expect(cleanLyricText('  a \\\\ b  ')).toBe('a b');
  });
  it('normalizeTrack repairs multi-row lines in older saves', () => {
    const pkg = createTrack({ durationMs: 10000, lyrics: [{ startMs: 0, endMs: 1000, text: 'x', singerSlot: 1 }] });
    pkg.lyrics[0]!.text = 'సరా\nగా\nల';
    expect(normalizeTrack(pkg).lyrics[0]!.text).toBe('సరా గా ల');
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

describe('who sings what — the song divided among the singers in the song, one colour each', () => {
  it('two singers take a four-part song 1,2,1,2 — two colours for the whole song', () => {
    const plan = planParts(4, [1, 2]);
    expect([1, 2, 3, 4].map((p) => partSingers(plan, p))).toEqual([[1], [2], [1], [2]]);
    expect([1, 2, 3, 4].map((p) => partColor(plan, p))).toEqual([SLOT_COLORS[1], SLOT_COLORS[2], SLOT_COLORS[1], SLOT_COLORS[2]]);
    expect([1, 2, 3, 4].map((p) => partLabel(plan, p))).toEqual(['S1', 'S2', 'S1', 'S2']);
    expect(new Set([1, 2, 3, 4].map((p) => partColor(plan, p))).size).toBe(2);
    expect(isMyLine(plan, 3, 1)).toBe(true);
    expect(isMyLine(plan, 3, 2)).toBe(false);
    expect(isMyLine(plan, 0, 2)).toBe(true); // a chorus line is everyone's
    expect(partLabel(plan, 0)).toBe('ALL');
    expect(partColor(plan, 0)).toBe(SLOT_COLORS[0]);
  });
  it('a third singer joins: the same song is divided for three, three colours', () => {
    const plan = planParts(4, [1, 2, 3]);
    expect([1, 2, 3, 4].map((p) => partSingers(plan, p))).toEqual([[1], [2], [3], [1]]);
    expect(new Set([1, 2, 3, 4].map((p) => partColor(plan, p))).size).toBe(3);
  });
  it('ten singers on a five-part song: 1 and 6 share a part and a colour, 2 and 7, 3 and 8, 4 and 9, 5 and 10', () => {
    const plan = planParts(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([1, 2, 3, 4, 5].map((p) => partSingers(plan, p))).toEqual([
      [1, 6],
      [2, 7],
      [3, 8],
      [4, 9],
      [5, 10],
    ]);
    expect(partLabel(plan, 1)).toBe('S1·S6');
    expect(partColor(plan, 1)).toBe(SLOT_COLORS[1]);
    expect(isMyLine(plan, 1, 6)).toBe(true);
    expect(isMyLine(plan, 2, 6)).toBe(false);
    expect(new Set([1, 2, 3, 4, 5].map((p) => partColor(plan, p))).size).toBe(5); // five colours, evenly shared
  });
  it('the singers are whoever is in the song, by stage slot — gaps and order do not matter; a line marked past the parts wraps round', () => {
    const plan = planParts(2, [7, 3, 3]);
    expect(plan.singers).toEqual([3, 7]);
    expect(partSingers(plan, 1)).toEqual([3]);
    expect(partSingers(plan, 2)).toEqual([7]);
    expect(partSingers(plan, 5)).toEqual([3]); // part 5 of a two-part song = part 1
    expect(partColor(plan, 2)).toBe(SLOT_COLORS[7]);
    expect(partSingers(plan, 0)).toEqual([3, 7]);
  });
  it('nobody in the song yet (the Studio, the count-in): a part is sung by the slot of its number', () => {
    const plan = planParts(3, []);
    expect([1, 2, 3].map((p) => partSingers(plan, p))).toEqual([[1], [2], [3]]);
    expect(partLabel(plan, 2)).toBe('S2');
    expect(isMyLine(plan, 2, 2)).toBe(true);
    expect(planParts(0, []).parts).toBe(1);
  });
  it('the cue deck follows the plan: my next lines are the lines of my parts', () => {
    const lines = [1, 2, 3, 4, 0, 1].map((slot, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: `L${i + 1}`, singerSlot: slot as SingerSlot }));
    const plan = planParts(4, [1, 2]);
    expect(cueDeckFor(lines, 0, (l) => isMyLine(plan, l.singerSlot, 2), 3).map((l) => l.text)).toEqual(['L2', 'L4', 'L5']);
    expect(cueDeckFor(lines, 1500, (l) => isMyLine(plan, l.singerSlot, 1), 3).map((l) => l.text)).toEqual(['L3', 'L5', 'L6']);
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
