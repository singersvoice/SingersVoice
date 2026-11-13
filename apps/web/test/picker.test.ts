/**
 * The song picker's search: every typed word must appear somewhere (title, artist, …), in any
 * order, case-blind; the matched words are marked in the results; the library list the device
 * remembers answers at once.
 */
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The session module reads localStorage as it loads: a stand-in must exist before the imports below run.
const store = vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
});
import { readTrackCache, writeTrackCache } from '../src/lib/trackCache.ts';
import { Highlight, matchesWords } from '../src/portals/meets/SongPicker.tsx';

beforeEach(() => store.clear());

describe('song picker search', () => {
  it('matches every word in any order, case-blind, on partial words', () => {
    expect(matchesWords('AmmoAmmaayena SV TrackMaker', 'ammo')).toBe(true);
    expect(matchesWords('AmmoAmmaayena SV TrackMaker', 'maker AMMO')).toBe(true);
    expect(matchesWords('AmmoAmmaayena SV TrackMaker', 'ammo xyz')).toBe(false);
    expect(matchesWords('anything', '')).toBe(true);
  });
  it('marks the matched words in a result', () => {
    const html = render(h(Highlight, { text: 'AmmoAmmaayena', q: 'ammo yena' }));
    expect(html).toBe('<mark>Ammo</mark>Ammaa<mark>yena</mark>');
    expect(render(h(Highlight, { text: 'A (B) [C]', q: '(b) [c]' }))).toBe('A <mark>(B)</mark> <mark>[C]</mark>'); // regex characters are just characters
    expect(render(h(Highlight, { text: 'plain', q: '' }))).toBe('plain');
  });
  it('remembers the library on the device so the picker can search it at once', () => {
    expect(readTrackCache()).toBeNull();
    const list = [{ trackId: 't1', title: 'Ammo', artist: 'SV', durationMs: 1000, singerCount: 1, updatedAt: '', ref: '', link: '' }] as never;
    writeTrackCache(list);
    expect(readTrackCache()?.map((t) => t.title)).toEqual(['Ammo']);
  });
});
