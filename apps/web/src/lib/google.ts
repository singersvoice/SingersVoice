/**
 * Google Identity Services (browser-only, no client secret).
 *  - OAuth token client with `drive.file` + openid/email/profile → short-lived access token.
 *  - A second, separate token for YouTube (`youtube` alone): Google refuses `drive.file` and
 *    `youtube` in one authorization ("scopes that cannot be requested together"), so the publisher's
 *    YouTube permission is asked for on its own and kept on its own (`requestYoutubeToken`), and no
 *    request lets Google merge the scopes it granted before into it (`include_granted_scopes: false`
 *    — the library's default would add `youtube` to the next Drive sign-in, or `drive.file` to the
 *    YouTube one, and Google would refuse both).
 *  - userinfo for the profile card.
 *  - Google Picker (optional, needs an API key) to pull in tracks other singers shared with you.
 *
 * The consent screen must list exactly these scopes and be published ("In production")
 * so any Google account can sign in. See docs/GOOGLE_OAUTH.md.
 */
import { DRIVE_SCOPES, YOUTUBE_SCOPE } from '@singersvoice/protocol';

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
export const GOOGLE_API_KEY = (import.meta.env.VITE_GOOGLE_API_KEY ?? '').trim();
export const googleConfigured = GOOGLE_CLIENT_ID.length > 0;

export interface GoogleToken {
  accessToken: string;
  /** ms since epoch */
  expiresAt: number;
  scope: string;
  /** When Google handed it out (ms since epoch): a refusal in its first minute is tried again before it counts. */
  issuedAt?: number;
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

/** The Drive box on Google's screen: what the person has to tick for SingersVoice to keep their takes in their Drive. */
export const DRIVE_TICK = 'See, edit, create and delete only the specific Google Drive files you use with this app';

/**
 * Google's screen lists each permission with a box to tick, none ticked beforehand. A sign-in that came
 * back without the Drive one is not an error on anyone's part — one more tap, with the box ticked,
 * and it is done. The sign-in screen shows this as a step, not as a failure.
 */
export class DriveScopeMissingError extends Error {
  constructor() {
    super(`One more tick: on Google’s screen, tick “${DRIVE_TICK}” — that is where your takes and tracks are kept — then Continue.`);
    this.name = 'DriveScopeMissingError';
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
        /** Whether Google adds the scopes this account granted the app before (its default: true — never here, see the header). */
        include_granted_scopes?: boolean;
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
/** The YouTube token, kept apart from the Drive one (the two permissions cannot share an authorization). */
export const YOUTUBE_TOKEN_KEY = 'sv.youtube.token';

function loadToken(key: string): GoogleToken | null {
  try {
    const raw = sessionStorage.getItem(key) ?? localStorage.getItem(key);
    if (!raw) return null;
    const t = JSON.parse(raw) as GoogleToken;
    if (!t.accessToken || t.expiresAt < Date.now() + 30_000) return null;
    return t;
  } catch {
    return null;
  }
}

function keepToken(key: string, t: GoogleToken | null): void {
  try {
    if (!t) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    } else {
      const raw = JSON.stringify(t);
      sessionStorage.setItem(key, raw);
      localStorage.setItem(key, raw); // survives the iOS "installed PWA" cold start
    }
  } catch {
    /* storage may be unavailable in private mode */
  }
}

export const loadStoredToken = (): GoogleToken | null => loadToken(TOKEN_KEY);
export const storeToken = (t: GoogleToken | null): void => keepToken(TOKEN_KEY, t);
export const loadStoredYoutubeToken = (): GoogleToken | null => loadToken(YOUTUBE_TOKEN_KEY);
export const storeYoutubeToken = (t: GoogleToken | null): void => keepToken(YOUTUBE_TOKEN_KEY, t);

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

/** The YouTube permission's box on Google's screen. */
export const YOUTUBE_TICK = 'Manage your YouTube account';

/**
 * One token request to Google, for one set of scopes, with nothing merged in from earlier grants. The
 * sign-in window must open from the tap itself: a browser allows a popup only within the user's
 * gesture, and a script download in between is longer than that. The library is loaded when the
 * sign-in screen appears (loadGis there), so here it is normally already in hand; when it is not, it
 * is loaded now and one more tap asked for rather than a window opened that the browser will block.
 */
async function askGoogle(scopes: string[], opts: { prompt: '' | 'consent' | 'select_account'; hint?: string }, must: { scope: string; missing: () => Error } | null): Promise<GoogleToken> {
  if (!googleConfigured) throw new Error('Google sign-in is not configured (VITE_GOOGLE_CLIENT_ID)');
  const ready = window.google?.accounts?.oauth2 ? window.google : null;
  if (!ready) {
    await loadGis();
    throw new Error('Google sign-in is ready now — tap Continue with Google once more');
  }
  const gis = ready;
  return new Promise<GoogleToken>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: scopes.join(' '),
      include_granted_scopes: false,
      callback: (r) => {
        if (!r.access_token) return reject(new Error(signInError(r.error, r.error_description)));
        // What was ticked (Google names the scopes it granted; a response without the list is taken at its word).
        const granted = r.scope ? r.scope.split(' ') : null;
        if (granted && must && !granted.includes(must.scope)) return reject(must.missing());
        resolve({ accessToken: r.access_token, expiresAt: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000, scope: r.scope ?? '', issuedAt: Date.now() });
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

/**
 * Request the sign-in's access token (Drive + the profile). `prompt: 'consent'` on first link (shows the
 * Drive consent), `''` afterwards (silent re-issue while the Google session is alive; still needs a user
 * gesture on iOS). Never the YouTube scope: that is `requestYoutubeToken`, its own authorization.
 */
export async function requestToken(opts: { prompt: '' | 'consent' | 'select_account'; hint?: string }): Promise<GoogleToken> {
  const token = await askGoogle(DRIVE_SCOPES, opts, { scope: 'https://www.googleapis.com/auth/drive.file', missing: () => new DriveScopeMissingError() });
  storeToken(token);
  return token;
}

/**
 * Request the YouTube token — the `youtube` scope alone, kept apart from the Drive token (Google refuses
 * the two in one authorization). `prompt: 'consent'` from Connect YouTube (the box to tick), `''` for a
 * silent re-issue while the Google session is alive; `hint` keeps it on the signed-in account.
 */
export async function requestYoutubeToken(opts: { prompt: '' | 'consent'; hint?: string }): Promise<GoogleToken> {
  const token = await askGoogle([YOUTUBE_SCOPE], opts, { scope: YOUTUBE_SCOPE, missing: () => new Error(`YouTube access was not granted — tick "${YOUTUBE_TICK}" on the Google screen`) });
  storeYoutubeToken(token);
  return token;
}

/** A token Google handed out within the last minute and a half: its first refusals are tried again before they count. */
export const freshToken = (t: GoogleToken | null | undefined): boolean => Boolean(t && typeof t.issuedAt === 'number' && Date.now() - t.issuedAt < 90_000);

export async function fetchProfile(token: GoogleToken): Promise<GoogleProfile> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (r.status === 401) throw new AuthExpiredError();
    // A token minted a moment ago can be refused once while Google's own services catch up with it: again, a few times.
    if (!r.ok && attempt < 3 && (r.status === 403 || r.status === 429 || r.status >= 500)) {
      await new Promise((f) => setTimeout(f, 700 * 2 ** attempt));
      continue;
    }
    if (!r.ok) throw new Error(`userinfo failed (${r.status})`);
    const j = (await r.json()) as Partial<GoogleProfile>;
    return { sub: j.sub ?? '', name: j.name ?? j.email ?? 'Singer', email: j.email ?? '', picture: j.picture ?? '' };
  }
}

export async function revokeToken(token: GoogleToken | null): Promise<void> {
  storeToken(null);
  storeYoutubeToken(null); // signed out: the YouTube permission's token goes with the account
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
