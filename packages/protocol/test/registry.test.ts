/** The master track database's ids, song keys and the reading of karaoke titles (registry.ts). */
import { describe, expect, it } from 'vitest';
import { isDriveUrl, isRegistryId, newRegistryId, parseSongTitle, registryIdDate, registrySourceKey, songKey, trackRecordLine } from '../src/registry.ts';
import { youtubeSearchQuery } from '../src/ytTracks.ts';

describe('track ids', () => {
  it('are 12 characters: 8 random from an alphabet without 0/O/1/I, then the month minted (YYMM), the same way everywhere', () => {
    const at = new Date('2026-11-17T15:00:00Z');
    expect(registryIdDate(at)).toBe('2611');
    const id = newRegistryId(at, (n) => new Uint8Array(n).map((_, i) => i * 37));
    expect(id).toHaveLength(12);
    expect(id.endsWith('2611')).toBe(true);
    expect(id).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}2611$/);
    expect(newRegistryId(at, (n) => new Uint8Array(n).map((_, i) => i * 37))).toBe(id); // the same bytes, the same id
    expect(new Set(Array.from({ length: 50 }, () => newRegistryId(at))).size).toBe(50); // crypto-random otherwise
    expect(registryIdDate(new Date('2027-01-03T23:59:59Z'))).toBe('2701');
    expect(isRegistryId(id)).toBe(true);
    expect(isRegistryId('ABCDEFGH2611x')).toBe(false);
    expect(isRegistryId('ABCDEFG02611')).toBe(false); // a zero is never minted
    expect(isRegistryId('trk-abc')).toBe(false);
  });

  it('one record per source: the YouTube video, the catalog entry, else the Drive folder', () => {
    expect(registrySourceKey({ source: 'youtube', youtubeId: 'dQw4w9WgXcQ', refs: { folderId: 'f1' } })).toBe('yt:dQw4w9WgXcQ');
    expect(registrySourceKey({ source: 'catalog', catalogTrackId: 'trk-9', refs: { folderId: 'f1' } })).toBe('catalog:trk-9');
    expect(registrySourceKey({ source: 'drive', refs: { folderId: 'f1' } })).toBe('drive:f1');
    expect(registrySourceKey({ source: 'youtube', youtubeId: null, refs: { folderId: 'f1' } })).toBe('drive:f1');
  });
});

describe('song keys', () => {
  it('group the same song whatever the karaoke file calls itself', () => {
    expect(songKey('Ammo Ammaayena (Karaoke Version) [HD]')).toBe('ammo ammaayena');
    expect(songKey('AMMO AMMAAYENA karaoke with lyrics')).toBe('ammo ammaayena');
    expect(songKey('  Hey Jude — Instrumental ')).toBe('hey jude');
    expect(songKey('అమ్మో అమ్మాయేనా')).toBe('అమ్మో అమ్మాయేనా');
    expect(songKey('')).toBe('');
  });
});

describe('reading a karaoke title', () => {
  it('film songs named with pipes: the song, the movie, the singers, the year, the language', () => {
    expect(parseSongTitle('Ammo Ammaayena | Ammo | Sid Sriram | 2019 | Telugu Karaoke')).toEqual({ song: 'Ammo Ammaayena', movie: 'Ammo', artists: 'Sid Sriram', year: 2019, language: 'Telugu' });
  });
  it('"Song - Artist (Karaoke Version)", a channel as the artist when it is not a karaoke house, "(From "Movie")"', () => {
    expect(parseSongTitle('Never Gonna Give You Up - Rick Astley (Karaoke Version)')).toMatchObject({ song: 'Never Gonna Give You Up', artists: 'Rick Astley', movie: '', year: null, language: '' });
    expect(parseSongTitle('Never Gonna Give You Up (Karaoke Version)', 'Sing King')).toMatchObject({ song: 'Never Gonna Give You Up', artists: '' });
    expect(parseSongTitle('Someone Like You (Karaoke)', 'Adele')).toMatchObject({ song: 'Someone Like You', artists: 'Adele' });
    expect(parseSongTitle('Tum Hi Ho (From "Aashiqui 2") Karaoke with Lyrics 2013 Hindi')).toMatchObject({ song: 'Tum Hi Ho', movie: 'Aashiqui 2', year: 2013, language: 'Hindi' });
  });
  it('what it cannot tell stays empty — never invented', () => {
    expect(parseSongTitle('Amma Karaoke with Lyrics')).toEqual({ song: 'Amma', artists: '', movie: '', year: null, language: '' });
    expect(parseSongTitle('')).toEqual({ song: '', artists: '', movie: '', year: null, language: '' });
  });
});

describe('what YouTube is asked', () => {
  it('always a karaoke track: the words added when missing, the misspelling set right, a link left alone', () => {
    expect(youtubeSearchQuery('tu hi meri shab')).toBe('tu hi meri shab karaoke track');
    expect(youtubeSearchQuery('tu hi meri shab karoake track')).toBe('tu hi meri shab karaoke track');
    expect(youtubeSearchQuery('  Tu Hi Meri Shab   Karaoke ')).toBe('Tu Hi Meri Shab Karaoke track');
    expect(youtubeSearchQuery('ammo ammaayena karaoke track')).toBe('ammo ammaayena karaoke track');
    expect(youtubeSearchQuery('backing tracks hey jude')).toBe('backing tracks hey jude karaoke');
    expect(youtubeSearchQuery('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(youtubeSearchQuery('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeSearchQuery('')).toBe('');
  });
});

describe('the rest', () => {
  it('keeps only Drive links as shareable URLs, and lines a record up for a list', () => {
    expect(isDriveUrl('https://drive.google.com/drive/folders/abc')).toBe(true);
    expect(isDriveUrl('https://docs.google.com/file/d/abc/view')).toBe(true);
    expect(isDriveUrl('https://evil.example/drive.google.com')).toBe(false);
    expect(isDriveUrl('http://drive.google.com/x')).toBe(false);
    expect(trackRecordLine({ artists: 'Sid Sriram', movie: 'Ammo', year: 2019, language: 'Telugu' })).toBe('Sid Sriram · Ammo · 2019 · Telugu');
    expect(trackRecordLine({ artists: '', movie: '', year: null, language: 'English' })).toBe('English');
  });
});
