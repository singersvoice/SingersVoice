/**
 * Session state: who is signed in, which storage provider is active (Drive or this device),
 * and the Google token lifecycle. Signals keep every screen in sync.
 */
import { computed, signal } from '@preact/signals';
import { asPlanId, type AccessStatus, type Entitlement, type MediaPermission, type PlanId, type UserRecord, type UserRole, type UserSubscription } from '@singersvoice/protocol';
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
    // The sign-in is done; the folders are a step of their own (tried a few times inside). Should they still not come,
    // the set-up screen says so with a Retry — never a sign-in reported as failed when it has succeeded.
    try {
      await drive.ready();
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      console.warn('Drive folders not ready after the sign-in', e);
    }
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
  setAccess(null);
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

/** Admin flag from the SVT DB (Publishing without a plan, the right to grant plans) — refreshed by refreshAccount(). */
export const privileged = signal<boolean>(localStorage.getItem('sv.privileged') === '1');
/** The plan in force (plans.ts) and whether Publishing mode is open to this account (a super admin, or the Club owner plan). */
export const plan = signal<PlanId>(asPlanId(localStorage.getItem('sv.plan')));
export const planUntil = signal<string | null>(localStorage.getItem('sv.planUntil') || null);
export const canPublish = signal<boolean>(localStorage.getItem('sv.canPublish') === '1');
export function setPlan(p: PlanId, until: string | null, publish: boolean): void {
  plan.value = p;
  planUntil.value = until;
  canPublish.value = publish;
  try {
    localStorage.setItem('sv.plan', p);
    localStorage.setItem('sv.planUntil', until ?? '');
    localStorage.setItem('sv.canPublish', publish ? '1' : '0');
  } catch {
    /* ignore */
  }
}
/**
 * The account's role (roles.ts), its subscription and where it stands (plans.ts: the plan in force, a picture in live
 * meets and the hours left this month), from /me. `media` is what this device may send of its singer in a live meet
 * right now — the service's verdict (an audio-only role, a free plan or hours used up: the voice alone); the Studio's
 * own camera goes by the role alone (`role !== 'audio'`): a solo take with a picture is everyone's.
 */
export const role = signal<UserRole>(asRole(localStorage.getItem('sv.role')));
export const media = signal<MediaPermission>(localStorage.getItem('sv.media') === 'dual' ? 'dual' : 'audio');
export const entitlement = signal<Entitlement | null>(readJson<Entitlement>('sv.entitlement'));
export const subscription = signal<UserSubscription | null>(readJson<UserSubscription>('sv.subscription'));
export const publishingNote = signal<string>(localStorage.getItem('sv.publishingNote') ?? '');
export const isSuperAdmin = computed(() => role.value === 'super_admin');
/**
 * The coupon gate (coupons.ts), as the service last said: when the gate is on and this account is not in, every page
 * shows the Coupon screen instead (app.tsx Guard) until the code the admin gave is entered. A 403 coupon_required from
 * any request lands here too, so a coupon changed or withdrawn by the admin shows the gate at once.
 */
export const access = signal<AccessStatus | null>(readJson<AccessStatus>('sv.access'));
export const couponNeeded = computed(() => Boolean(access.value && access.value.required && !access.value.ok));
export function setAccess(a: AccessStatus | null): void {
  access.value = a;
  try {
    localStorage.setItem('sv.access', a ? JSON.stringify(a) : '');
  } catch {
    /* ignore */
  }
}
/** A club owner with a plan of their own that has seats: the My club page is theirs. */
export const ownsClub = computed(() => (entitlement.value?.via === 'own' && entitlement.value.seats > 0) || isSuperAdmin.value);
export function setRole(r: UserRole, sub: UserSubscription | null, note: string, m: MediaPermission = r === 'audio' ? 'audio' : 'dual', ent: Entitlement | null = null): void {
  role.value = r;
  subscription.value = sub;
  publishingNote.value = note;
  media.value = m;
  entitlement.value = ent;
  try {
    localStorage.setItem('sv.role', r);
    localStorage.setItem('sv.subscription', sub ? JSON.stringify(sub) : '');
    localStorage.setItem('sv.publishingNote', note);
    localStorage.setItem('sv.media', m);
    localStorage.setItem('sv.entitlement', ent ? JSON.stringify(ent) : '');
  } catch {
    /* ignore */
  }
}
function asRole(v: string | null): UserRole {
  return v === 'audio' || v === 'dual' || v === 'club_owner' || v === 'super_admin' ? v : 'dual';
}
function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** My account as the service last gave it (/me): the SingersVoice number, the phone, blocked or not — beside the signals above. */
export const account = signal<UserRecord | null>(readJson<UserRecord>('sv.account'));
export function setAccount(u: UserRecord | null): void {
  account.value = u;
  try {
    localStorage.setItem('sv.account', u ? JSON.stringify(u) : '');
  } catch {
    /* ignore */
  }
}
/** Blocked for good by a super admin (a 403 `blocked` from any request lands here): every page shows the notice instead. */
export const blockedAccount = computed(() => Boolean(account.value?.blocked) && role.value !== 'super_admin');

/** My account id in the SVT DB (`g-<google sub>` / `dev-<id>`), from /me — what meets and catalog entries carry as owner. */
export const accountUserId = signal<string>(localStorage.getItem('sv.accountUserId') ?? '');
export function setAccountUserId(id: string): void {
  accountUserId.value = id;
  try {
    localStorage.setItem('sv.accountUserId', id);
  } catch {
    /* ignore */
  }
}

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
