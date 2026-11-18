/**
 * Which service the app talks to (lib/api.ts): the build's own address. A build without one (dev, CI) takes
 * `?control=https://…` from the link; a build with its own address ignores that query — every request carries
 * the singer's Google token, so a crafted link must never point a singer at another host — while the super
 * admin's Settings override (setControlUrl) still holds on their own device, and clearing it goes back to
 * the build's address.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
// setControlUrl pings the new address (/health); nothing leaves this test.
vi.stubGlobal('fetch', () => Promise.reject(new Error('offline in tests')));

const load = async (search: string, builtIn: string) => {
  vi.resetModules();
  vi.stubEnv('VITE_CONTROL_URL', builtIn);
  (globalThis as { location?: unknown }).location = { search };
  return import('../src/lib/api.ts');
};

afterEach(() => {
  vi.unstubAllEnvs();
  store.clear();
  delete (globalThis as { location?: unknown }).location;
});

describe('the service address', () => {
  it('a build without its own address takes the link (dev, CI) and keeps it on the device', async () => {
    const api = await load('?control=https://svc.test/', '');
    expect(api.controlUrl.value).toBe('https://svc.test');
    expect(store.get('sv.controlUrl')).toBe('https://svc.test/');
  });

  it("a build with its own address ignores a link's ?control= — a singer's token goes to the SingersVoice service alone", async () => {
    const api = await load('?control=https://evil.test', 'https://real.test');
    expect(api.controlUrl.value).toBe('https://real.test');
    expect(store.has('sv.controlUrl')).toBe(false);
  });

  it("the super admin's override on the device holds over the build's address, and clearing it goes back", async () => {
    store.set('sv.controlUrl', 'https://staging.test');
    const api = await load('', 'https://real.test');
    expect(api.controlUrl.value).toBe('https://staging.test');
    api.setControlUrl('https://other.test/');
    expect(api.controlUrl.value).toBe('https://other.test');
    expect(store.get('sv.controlUrl')).toBe('https://other.test');
    api.setControlUrl('');
    expect(api.controlUrl.value).toBe('https://real.test');
    expect(store.has('sv.controlUrl')).toBe(false);
  });
});
