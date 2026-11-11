/**
 * Session state: who is signed in, which storage provider is active (Drive or this device),
 * and the Google token lifecycle. Signals keep every screen in sync.
 */
import { computed, signal } from '@preact/signals';
import {
  AuthExpiredError,
  fetchProfile,
  googleConfigured,
  loadStoredToken,
  requestToken,
  revokeToken,
  storeToken,
  type GoogleProfile,
  type GoogleToken,
} from '../lib/google.ts';
import { DriveProvider } from '../lib/storage/drive.ts';
import { LocalProvider } from '../lib/storage/local.ts';
import type { ProviderKind, StorageProvider } from '../lib/storage/types.ts';
import { toast } from '../lib/toast.ts';

const PROFILE_KEY = 'sv.profile';
const MODE_KEY = 'sv.mode';

export interface Profile extends GoogleProfile {
  mode: ProviderKind;
}

function readProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

export const profile = signal<Profile | null>(readProfile());
export const token = signal<GoogleToken | null>(loadStoredToken());
export const mode = signal<ProviderKind | null>((localStorage.getItem(MODE_KEY) as ProviderKind | null) ?? null);
/** True while the Drive token is missing/expired and the user must tap "Reconnect". */
export const needsReconnect = signal(false);
export const busy = signal<string | null>(null);

const local = new LocalProvider();
let drive: DriveProvider | null = null;

export const provider = computed<StorageProvider>(() => {
  if (mode.value === 'drive' && profile.value?.mode === 'drive') {
    if (!drive) drive = new DriveProvider(() => token.value, profile.value.sub);
    return drive;
  }
  return local;
});

export const driveProvider = (): DriveProvider | null => (provider.value instanceof DriveProvider ? provider.value : null);
export const isDrive = computed(() => provider.value.kind === 'drive');
/**
 * Google sign-in is mandatory. A device-only session (developer preview) only counts in builds
 * without a Google client; once VITE_GOOGLE_CLIENT_ID is set, a preview session left on this
 * device is not resumed — the Welcome screen asks for Google instead.
 */
export const previewAllowed = !googleConfigured;
export const signedIn = computed(() => profile.value !== null && mode.value !== null && (profile.value.mode === 'drive' || previewAllowed));
export const staleDeviceSession = computed(() => !previewAllowed && profile.value?.mode === 'local');

export const localProvider = local;

/** Link Google + Drive (first time shows the consent screen). */
export async function signInWithGoogle(): Promise<void> {
  if (!googleConfigured) throw new Error('Google sign-in is not configured for this build. Set VITE_GOOGLE_CLIENT_ID (see docs/GOOGLE_OAUTH.md) or continue on this device.');
  busy.value = 'Connecting to Google…';
  try {
    const t = await requestToken({ prompt: token.value ? '' : 'consent' });
    token.value = t;
    const p = await fetchProfile(t);
    const prof: Profile = { ...p, mode: 'drive' };
    profile.value = prof;
    mode.value = 'drive';
    localStorage.setItem(PROFILE_KEY, JSON.stringify(prof));
    localStorage.setItem(MODE_KEY, 'drive');
    drive = new DriveProvider(() => token.value, prof.sub);
    busy.value = 'Preparing your SingersVoice folder in Drive…';
    await drive.ready();
    needsReconnect.value = false;
  } finally {
    busy.value = null;
  }
}

/** Silent re-issue of the access token (needs a user gesture on iOS Safari). */
export async function reconnect(): Promise<void> {
  const prof = profile.value;
  if (!prof || prof.mode !== 'drive') return;
  busy.value = 'Reconnecting Google Drive…';
  try {
    const t = await requestToken({ prompt: '', hint: prof.email });
    token.value = t;
    needsReconnect.value = false;
    toast('Google Drive reconnected', 'ok');
  } finally {
    busy.value = null;
  }
}

export function continueOnDevice(): void {
  const prof: Profile = { sub: 'local', name: 'Local singer', email: '', picture: '', mode: 'local' };
  profile.value = prof;
  mode.value = 'local';
  localStorage.setItem(PROFILE_KEY, JSON.stringify(prof));
  localStorage.setItem(MODE_KEY, 'local');
}

export async function signOut(): Promise<void> {
  const t = token.value;
  token.value = null;
  profile.value = null;
  mode.value = null;
  drive = null;
  storeToken(null);
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem(MODE_KEY);
  await revokeToken(t);
}

/**
 * Run a provider call; on an expired Google session flip `needsReconnect` and surface a toast
 * with a Reconnect action instead of failing silently.
 */
export async function withProvider<T>(fn: (p: StorageProvider) => Promise<T>): Promise<T> {
  try {
    return await fn(provider.value);
  } catch (e) {
    if (e instanceof AuthExpiredError) {
      needsReconnect.value = true;
      toast('Google Drive session expired', 'warn', 8000, { label: 'Reconnect', onClick: () => void reconnect().catch((err) => toast(String(err), 'error')) });
    }
    throw e;
  }
}

/** Privileged (Publishing mode) flag from the SVT DB — refreshed by refreshAccount(). */
export const privileged = signal<boolean>(localStorage.getItem('sv.privileged') === '1');
export function setPrivileged(v: boolean): void {
  privileged.value = v;
  try {
    localStorage.setItem('sv.privileged', v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Expiry watchdog: flag reconnect ~1 minute before the token dies. */
setInterval(() => {
  const t = token.value;
  if (mode.value === 'drive' && t && t.expiresAt - Date.now() < 60_000) needsReconnect.value = true;
  if (mode.value === 'drive' && !t) needsReconnect.value = true;
}, 20_000);
