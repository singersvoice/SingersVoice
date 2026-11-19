/**
 * The sign-in's answer from Google (lib/google.ts, requestToken): the token kept with the moment it was minted; Google's
 * screen come back without the Drive box ticked is the DriveScopeMissingError — one more tap, a step the sign-in screen
 * shows, never an error; a response that names no scopes is taken at its word. The YouTube permission is its own
 * authorization: the `youtube` scope alone, its own token, and no request lets Google merge earlier grants into it
 * (Google refuses `drive.file` and `youtube` together).
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
type ClientConfig = { scope: string; include_granted_scopes?: boolean; callback: (r: TokenResponse) => void };
/** A Google Identity Services stand-in: whatever `answer` says, handed to the app's callback on request; the request's configuration kept. */
const asked: ClientConfig[] = [];
function fakeGis(answer: TokenResponse) {
  (globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: ClientConfig) => {
          asked.push(cfg);
          return { requestAccessToken: () => cfg.callback(answer) };
        },
        revoke: (_t: string, done?: () => void) => done?.(),
      },
    },
  };
}
const { DriveScopeMissingError, freshToken, requestToken, requestYoutubeToken, revokeToken } = await import('../src/lib/google.ts');
const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const YOUTUBE = 'https://www.googleapis.com/auth/youtube';

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

  it('the YouTube permission is its own authorization: the youtube scope alone, its own token, nothing merged in — and the sign-in never asks for YouTube', async () => {
    store.clear();
    asked.length = 0;
    fakeGis({ access_token: 'ya29.yt', expires_in: 3599, scope: YOUTUBE });
    const yt = await requestYoutubeToken({ prompt: 'consent', hint: 'singer@example.com' });
    expect(yt.accessToken).toBe('ya29.yt');
    expect(asked[0]!.scope).toBe(YOUTUBE); // never with drive.file: Google refuses the two together
    expect(asked[0]!.include_granted_scopes).toBe(false); // nor with the Drive grant merged in by the library
    expect(JSON.parse(store.get('sv.youtube.token')!).accessToken).toBe('ya29.yt');
    expect(store.has('sv.google.token')).toBe(false); // the Drive token is another thing
    // The box not ticked: said so, nothing kept.
    store.clear();
    fakeGis({ access_token: 'ya29.no', expires_in: 3599, scope: 'openid' });
    await expect(requestYoutubeToken({ prompt: 'consent' })).rejects.toThrow(/Manage your YouTube account/);
    expect(store.has('sv.youtube.token')).toBe(false);
    // The sign-in, with YouTube granted before: Drive and the profile alone, nothing merged in.
    fakeGis({ access_token: 'ya29.d', expires_in: 3599, scope: `openid email profile ${DRIVE}` });
    await requestToken({ prompt: '' });
    const signIn = asked[asked.length - 1]!;
    expect(signIn.scope.split(' ')).not.toContain(YOUTUBE);
    expect(signIn.scope.split(' ')).toContain(DRIVE);
    expect(signIn.include_granted_scopes).toBe(false);
    // Signing out drops both tokens.
    store.set('sv.youtube.token', JSON.stringify({ accessToken: 'x', expiresAt: Date.now() + 1e6, scope: YOUTUBE }));
    await revokeToken({ accessToken: 'ya29.d', expiresAt: Date.now() + 1e6, scope: DRIVE });
    expect(store.has('sv.google.token') || store.has('sv.youtube.token')).toBe(false);
  });
});
