import { describe, expect, it } from 'vitest';
import { hrefFor, relPathFor } from '../src/lib/nav.ts';

// The GitHub Pages base (/SingersVoice/) must be stripped for active-nav detection and added for links.
describe('base-path routing', () => {
  it('strips and adds the base path', () => {
    expect(relPathFor('/SingersVoice/home', '/SingersVoice/')).toBe('/home');
    expect(relPathFor('/SingersVoice/', '/SingersVoice/')).toBe('/');
    expect(relPathFor('/home', '/')).toBe('/home');
    expect(hrefFor('/sing/abc', '/SingersVoice/')).toBe('/SingersVoice/sing/abc');
    expect(hrefFor('/sing/abc', '/')).toBe('/sing/abc');
    expect(hrefFor('brand/x.png', '/SingersVoice')).toBe('/SingersVoice/brand/x.png');
  });
});
