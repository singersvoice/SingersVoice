/**
 * Songs a singer prefers and bookmarks (prefs.ts): the preference as kept (known languages and countries only),
 * the languages a preference reaches (a country stands for its languages), the line for it, a bookmark's key and
 * what is kept of one.
 */
import { describe, expect, it } from 'vitest';
import { bookmarkKey, emptyPrefs, hasPrefs, languagesLine, normalizeBookmark, normalizePrefs, prefsLanguages, SONG_COUNTRIES } from '../src/prefs.ts';
import { SONG_LANGUAGES } from '../src/registry.ts';

describe('songs a singer prefers', () => {
  it('every country stands for languages the songs are filed under', () => {
    for (const c of SONG_COUNTRIES) {
      expect(c.languages.length).toBeGreaterThan(0);
      for (const l of c.languages) expect(SONG_LANGUAGES).toContain(l);
    }
    expect(new Set(SONG_COUNTRIES.map((c) => c.name)).size).toBe(SONG_COUNTRIES.length);
  });

  it('the preference as kept: known names only, each once, at most a dozen; nothing set is nothing', () => {
    expect(normalizePrefs(null)).toEqual(emptyPrefs());
    expect(normalizePrefs({ languages: ['Hindi', 'Klingon', 'Hindi', 7], countries: ['India', 'Atlantis'] })).toEqual({ languages: ['Hindi'], countries: ['India'] });
    expect(normalizePrefs({ languages: SONG_LANGUAGES }).languages).toHaveLength(12);
    expect(hasPrefs(emptyPrefs())).toBe(false);
    expect(hasPrefs({ languages: [], countries: ['India'] })).toBe(true);
    expect(hasPrefs(null)).toBe(false);
  });

  it("the languages a preference reaches: the ones picked first, then each country's, never one twice", () => {
    expect(prefsLanguages({ languages: ['English'], countries: ['India', 'United States'] })).toEqual(['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Punjabi', 'Gujarati', 'Odia', 'Urdu', 'Spanish']);
    expect(prefsLanguages({ languages: [], countries: ['Sri Lanka'] })).toEqual(['Sinhala', 'Tamil']);
    expect(prefsLanguages(null)).toEqual([]);
    expect(languagesLine([])).toBe('');
    expect(languagesLine(['Hindi'])).toBe('Hindi');
    expect(languagesLine(['Hindi', 'Telugu', 'English'])).toBe('Hindi, Telugu & English');
  });

  it('a bookmark: one per song per singer by its key; what is kept of one is bounded and typed', () => {
    expect(bookmarkKey('registry', 'ABCDEFGH2611')).toBe('registry:ABCDEFGH2611');
    expect(normalizeBookmark({ kind: 'spotify', ref: 'x' })).toBeNull();
    expect(normalizeBookmark({ kind: 'registry', ref: '  ' })).toBeNull();
    const b = normalizeBookmark({ kind: 'youtube', ref: 'dQw4w9WgXcQ', title: ' Never Gonna ', artist: 'Rick', language: 'English', durationMs: 212345.6, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg', youtube: { id: 'dQw4w9WgXcQ', title: 'Never Gonna', channel: 'Karaoke', durationMs: 212345, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg', views: 12, url: 'javascript:alert(1)' } });
    expect(b).toMatchObject({ kind: 'youtube', ref: 'dQw4w9WgXcQ', title: 'Never Gonna', artist: 'Rick', durationMs: 212346, registryId: null, catalogTrackId: null });
    expect(b!.youtube).toMatchObject({ id: 'dQw4w9WgXcQ', views: 12, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }); // the link is YouTube's, never the caller's
    const c = normalizeBookmark({ kind: 'catalog', ref: 'trk-1', title: 'x'.repeat(300), registryId: 'ABCDEFGH2611', catalogTrackId: 'trk-1', youtube: { title: 'no id' } });
    expect(c!.title).toHaveLength(200);
    expect(c!.youtube).toBeNull();
    expect(c!.registryId).toBe('ABCDEFGH2611');
  });
});
