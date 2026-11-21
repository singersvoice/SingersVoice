/** The Home search (lib/features.ts): what a few letters find, best first; what an account cannot use stays out. */
import { describe, expect, it } from 'vitest';
import type { Feature } from '../src/lib/features.ts';

const store = new Map<string, string>();
const fakeStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
const { setRole } = await import('../src/state/session.ts');
const { FEATURES, searchFeatures } = await import('../src/lib/features.ts');

const titles = (q: string, all?: readonly Feature[]) => searchFeatures(q, 8, all).map((f) => f.title);

describe('the feature search', () => {
  it('finds a feature by its name, best first, and by the words people use for it', () => {
    expect(titles('tv')[0]).toBe('TV in the room');
    expect(titles('television')[0]).toBe('TV in the room');
    expect(titles('block')[0]).toBe('Block someone');
    expect(titles('promo')[0]).toBe('Plans');
    expect(titles('hiss')[0]).toBe('VoxForge voice');
    expect(titles('lag')).toContain('Check the sync (lag)');
    expect(titles('you tube')[0]).toBe('YouTube song tracks');
    expect(titles('post a clip')).toContain('Performances');
    expect(titles('backgrounds')[0]).toBe('Stage & publishing backgrounds');
  });
  it('needs every word to match, returns at most eight, and nothing for nothing typed', () => {
    expect(titles('')).toEqual([]);
    expect(titles('   ')).toEqual([]);
    expect(titles('zzzz')).toEqual([]);
    expect(titles('camera zzzz')).toEqual([]);
    expect(searchFeatures('s', 8).length).toBeLessThanOrEqual(8);
  });
  it('leaves out what the account cannot use: the Admin page for a singer, the Plans page for a super admin', () => {
    const all: Feature[] = [
      { title: 'Admin', where: 'Admin', keywords: ['admin'], path: '/admin', when: () => false },
      { title: 'Administer my club', where: 'Club', keywords: ['admin'], path: '/club' },
    ];
    expect(titles('admin', all)).toEqual(['Administer my club']);
    setRole('dual', null, '');
    expect(titles('admin')).not.toContain('Admin');
    expect(titles('plans')).toContain('Plans');
    setRole('super_admin', null, '');
    expect(titles('admin')).toContain('Admin');
    expect(titles('plans')).not.toContain('Plans');
    setRole('dual', null, '');
  });
  it('every feature has a path into the app, a place, and words', () => {
    for (const f of FEATURES) {
      expect(f.path).toMatch(/^\/[a-z/-]*(#[a-z]+|\?tab=[a-z]+)?$/);
      expect(f.where.length).toBeGreaterThan(0);
      expect(f.keywords.length).toBeGreaterThan(0);
      expect(JSON.stringify(f).toLowerCase()).not.toContain('karaoke');
    }
  });
});
