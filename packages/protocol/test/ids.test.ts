/** Ids and tokens (ids.ts): ids sort by time; tokens are long and random; a link given by a client is https or nothing. */
import { describe, expect, it } from 'vitest';
import { httpsLink, newId, newToken, safeName } from '../src/ids.ts';

describe('ids and tokens', () => {
  it('ids carry the clock and six random characters', () => {
    const a = newId('m-');
    expect(a).toMatch(/^m-[0-9a-z]+-[a-z0-9]{6}$/);
    expect(newId()).not.toBe(newId());
  });
  it('tokens are 192 random bits as URL-safe base64, never two the same, nothing of the clock', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const many = new Set(Array.from({ length: 2000 }, () => newToken()));
    expect(many.size).toBe(2000);
    expect(newToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newToken(1)).toMatch(/^[A-Za-z0-9_-]{2}$/);
    expect(newToken(2)).toMatch(/^[A-Za-z0-9_-]{3}$/);
  });
  it('keeps an https link as given and refuses anything else (a javascript: link above all)', () => {
    expect(httpsLink('https://drive.google.com/file/d/abc/view?usp=sharing')).toBe('https://drive.google.com/file/d/abc/view?usp=sharing');
    expect(httpsLink('https://x.test:8443/p#h')).toBe('https://x.test:8443/p#h');
    expect(httpsLink('http://drive.google.com/x')).toBeNull();
    expect(httpsLink('javascript:alert(1)')).toBeNull();
    expect(httpsLink('JAVASCRIPT:alert(1)')).toBeNull();
    expect(httpsLink('https://x.test/a b')).toBeNull();
    expect(httpsLink('https://x.test/\u0001')).toBeNull();
    expect(httpsLink('https://')).toBeNull();
    expect(httpsLink('')).toBeNull();
    expect(httpsLink(null)).toBeNull();
    expect(httpsLink(42)).toBeNull();
    expect(httpsLink(`https://x.test/${'a'.repeat(600)}`)).toBeNull();
    expect(httpsLink(`https://x.test/${'a'.repeat(100)}`, 50)).toBeNull();
  });
  it('safe names keep letters of any script and drop path characters', () => {
    expect(safeName('  Hello: world/ok?  ')).toBe('Hello world ok');
    expect(safeName('नमस्ते दुनिया')).toBe('नमस्ते दुनिया');
    expect(safeName('///')).toBe('untitled');
  });
});
