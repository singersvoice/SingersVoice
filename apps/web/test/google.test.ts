/**
 * The sign-in's answer from Google (lib/google.ts, requestToken): the token kept with the moment it was minted; Google's
 * screen come back without the Drive box ticked is the DriveScopeMissingError — one more tap, a step the sign-in screen
 * shows, never an error; a response that names no scopes is taken at its word.
 */
import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'client-test');
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;
(globalThis as { sessionStorage?: unknown }).sessionStorage = fakeStorage;
(globalThis as { window?: unknown }).window = globalThis;

type TokenResponse = { access_token?: string; expires_in?: number; scope?: string; error?: string };
/** A Google Identity Services stand-in: whatever `answer` says, handed to the app's callback on request. */
function fakeGis(answer: TokenResponse) {
  (globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { callback: (r: TokenResponse) => void }) => ({ requestAccessToken: () => cfg.callback(answer) }),
        revoke: (_t: string, done?: () => void) => done?.(),
      },
    },
  };
}
const { DriveScopeMissingError, freshToken, requestToken } = await import('../src/lib/google.ts');
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

describe('the token Google hands back', () => {
  it('with the Drive box ticked: kept, with the moment it was minted (fresh for a minute and a half)', async () => {
    fakeGis({ access_token: 'ya29.x', expires_in: 3599, scope: `openid email profile ${DRIVE}` });
    const t = await requestToken({ prompt: 'consent' });
    expect(t.accessToken).toBe('ya29.x');
    expect(t.issuedAt).toBeGreaterThan(Date.now() - 2000);
    expect(freshToken(t)).toBe(true);
    expect(freshToken({ ...t, issuedAt: Date.now() - 120_000 })).toBe(false);
    expect(freshToken({ ...t, issuedAt: undefined })).toBe(false);
    expect(JSON.parse(store.get('sv.google.token')!).accessToken).toBe('ya29.x'); // kept for the next start
  });

  it('without the Drive box ticked: the one-more-tick outcome, nothing kept', async () => {
    store.clear();
    fakeGis({ access_token: 'ya29.y', expires_in: 3599, scope: 'openid email profile' });
    const refused = await requestToken({ prompt: 'consent' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(DriveScopeMissingError);
    expect((refused as Error).message).toMatch(/One more tick/);
    expect((refused as Error).message).toMatch(/See, edit, create and delete only the specific Google Drive files/);
    expect(store.has('sv.google.token')).toBe(false);
  });

  it('a response that names no scopes is taken at its word; a refusal is Google\'s own words', async () => {
    fakeGis({ access_token: 'ya29.z', expires_in: 3599 });
    expect((await requestToken({ prompt: '' })).accessToken).toBe('ya29.z');
    fakeGis({ error: 'access_denied' });
    await expect(requestToken({ prompt: 'consent' })).rejects.toThrow(/Google blocked the sign-in/);
  });
});
