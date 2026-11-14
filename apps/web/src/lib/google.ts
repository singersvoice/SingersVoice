/**
 * Google Identity Services (browser-only, no client secret).
 *  - OAuth token client with `drive.file` + openid/email/profile → short-lived access token.
 *  - userinfo for the profile card.
 *  - Google Picker (optional, needs an API key) to pull in tracks other singers shared with you.
 *
 * The consent screen must list exactly these scopes and be published ("In production")
 * so any Google account can sign in. See docs/GOOGLE_OAUTH.md.
 */
import { DRIVE_SCOPES } from '@singersvoice/protocol';

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
export const GOOGLE_API_KEY = (import.meta.env.VITE_GOOGLE_API_KEY ?? '').trim();
export const googleConfigured = GOOGLE_CLIENT_ID.length > 0;

export interface GoogleToken {
  accessToken: string;
  /** ms since epoch */
  expiresAt: number;
  scope: string;
}

export interface GoogleProfile {
  sub: string;
  name: string;
  email: string;
  picture: string;
}

export class AuthExpiredError extends Error {
  constructor() {
    super('Google session expired — reconnect to continue');
    this.name = 'AuthExpiredError';
  }
}

// --- minimal GIS typings ---
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: '' | 'consent' | 'select_account'; hint?: string }): void;
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string;
        scope: string;
        prompt?: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type: string; message?: string }) => void;
      }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
}
declare global {
  interface Window {
    google?: Gis & { picker?: unknown };
    gapi?: { load(name: string, cb: () => void): void };
  }
}

let gisPromise: Promise<Gis> | null = null;
export function loadGis(): Promise<Gis> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google);
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google) : reject(new Error('GIS failed to initialise')));
    s.onerror = () => reject(new Error('Could not load Google sign-in (offline or blocked)'));
    document.head.appendChild(s);
  });
  return gisPromise;
}

const TOKEN_KEY = 'sv.google.token';

export function loadStoredToken(): GoogleToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as GoogleToken;
    if (!t.accessToken || t.expiresAt < Date.now() + 30_000) return null;
    return t;
  } catch {
    return null;
  }
}

export function storeToken(t: GoogleToken | null): void {
  try {
    if (!t) {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } else {
      const raw = JSON.stringify(t);
      sessionStorage.setItem(TOKEN_KEY, raw);
      localStorage.setItem(TOKEN_KEY, raw); // survives the iOS "installed PWA" cold start
    }
  } catch {
    /* storage may be unavailable in private mode */
  }
}

/**
 * What a refused sign-in means, in words the person (or the app's owner) can act on. Google's own
 * page said it in the popup; by the time it closes, the app sees only a code.
 */
export function signInError(error?: string, description?: string): string {
  if (error === 'access_denied') {
    return 'Google blocked the sign-in: this app\u2019s Google setup is still in "Testing" mode, which only lets listed test accounts in. The app\u2019s owner publishes it once (Google Cloud Console \u2192 Google Auth Platform \u2192 Audience \u2192 Publish app) and every Google account can sign in. If you just said No on the consent screen, try again and allow Drive access.';
  }
  if (error === 'interaction_required' || error === 'login_required') return 'Please sign in to Google again';
  return description ?? error ?? 'No token returned';
}

/**
 * Request an access token. `prompt: 'consent'` on first link (shows the Drive consent),
 * `''` afterwards (silent re-issue while the Google session is alive; still needs a user gesture on iOS).
 */
export async function requestToken(opts: { prompt: '' | 'consent' | 'select_account'; hint?: string }): Promise<GoogleToken> {
  if (!googleConfigured) throw new Error('Google sign-in is not configured (VITE_GOOGLE_CLIENT_ID)');
  // The sign-in window must open from the tap itself: a browser allows a popup only within the
  // user's gesture, and a script download in between is longer than that. The library is loaded
  // when the sign-in screen appears (loadGis there), so here it is normally already in hand; when it
  // is not, load it now and ask for one more tap rather than open a window the browser will block.
  const ready = window.google?.accounts?.oauth2 ? window.google : null;
  if (!ready) {
    await loadGis();
    throw new Error('Google sign-in is ready now — tap Continue with Google once more');
  }
  const gis = ready;
  return new Promise<GoogleToken>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPES.join(' '),
      callback: (r) => {
        if (!r.access_token) return reject(new Error(signInError(r.error, r.error_description)));
        const granted = (r.scope ?? '').split(' ');
        if (!granted.includes('https://www.googleapis.com/auth/drive.file')) {
          return reject(new Error('Drive access was not granted — tick "See, edit, create and delete only the specific Google Drive files you use with this app"'));
        }
        const token = { accessToken: r.access_token, expiresAt: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000, scope: r.scope ?? '' };
        storeToken(token);
        resolve(token);
      },
      error_callback: (e) =>
        reject(
          new Error(
            e.type === 'popup_closed'
              ? 'Sign-in window was closed'
              : e.type === 'popup_failed_to_open'
                ? 'The browser blocked the sign-in window. Tap Continue with Google again — or, if you opened this link inside another app, open SingersVoice in Safari or Chrome.'
                : (e.message ?? e.type),
          ),
        ),
    });
    client.requestAccessToken({ prompt: opts.prompt, hint: opts.hint });
  });
}

export async function fetchProfile(token: GoogleToken): Promise<GoogleProfile> {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (r.status === 401) throw new AuthExpiredError();
  if (!r.ok) throw new Error(`userinfo failed (${r.status})`);
  const j = (await r.json()) as Partial<GoogleProfile>;
  return { sub: j.sub ?? '', name: j.name ?? j.email ?? 'Singer', email: j.email ?? '', picture: j.picture ?? '' };
}

export async function revokeToken(token: GoogleToken | null): Promise<void> {
  storeToken(null);
  if (!token) return;
  try {
    const gis = await loadGis();
    await new Promise<void>((resolve) => gis.accounts.oauth2.revoke(token.accessToken, resolve));
  } catch {
    /* best effort */
  }
}

// --- Google Picker (optional) ---
interface PickerDoc {
  id: string;
  name: string;
  mimeType: string;
}
let pickerPromise: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  if (pickerPromise) return pickerPromise;
  pickerPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.async = true;
    s.onload = () => window.gapi?.load('picker', resolve);
    s.onerror = () => reject(new Error('Could not load Google Picker'));
    document.head.appendChild(s);
  });
  return pickerPromise;
}

/** Let the singer pick a shared SingersVoice track folder (or file) from their Drive. Needs VITE_GOOGLE_API_KEY. */
export async function pickFromDrive(token: GoogleToken): Promise<PickerDoc[]> {
  if (!GOOGLE_API_KEY) throw new Error('Google Picker needs VITE_GOOGLE_API_KEY');
  await loadPicker();
  const picker = (window.google as unknown as { picker: Record<string, any> }).picker;
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true).setOwnedByMe(false);
    const p = new picker.PickerBuilder()
      .setOAuthToken(token.accessToken)
      .setDeveloperKey(GOOGLE_API_KEY)
      .addView(view)
      .setTitle('Pick a SingersVoice track shared with you')
      .setCallback((data: { action: string; docs?: PickerDoc[] }) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs ?? []);
        else if (data.action === picker.Action.CANCEL) resolve([]);
      })
      .build();
    p.setVisible(true);
  });
}
