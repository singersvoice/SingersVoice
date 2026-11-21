/**
 * sv-control (SVT DB) client: typed fetch with the Google token, NTP-style clock sync, status.
 * The URL is the build's own (VITE_CONTROL_URL, baked in by Deploy web). A build without one — dev, CI —
 * takes it from a link, `?control=https://…`; a build with its own address ignores that query, because
 * every request carries the singer's Google token and a crafted link must never send it to another
 * host. The super admin's Settings field (setControlUrl) overrides on their own device alone, kept in
 * localStorage `sv.controlUrl`.
 */
import { computed, signal } from '@preact/signals';
import { bestClockOffset, clockOffsetMs, type Routes } from '@singersvoice/protocol';
import { access, account, needsReconnect, profile, reconnect, setAccess, setAccount, setAccountUserId, setPlan, setPrivileged, setRole, token } from '../state/session.ts';
import { toast } from './toast.ts';

const OVERRIDE_KEY = 'sv.controlUrl';
/** The service address this build was made with; empty in dev and CI builds. */
const builtInUrl = (import.meta.env.VITE_CONTROL_URL ?? '').trim().replace(/\/$/, '');

function readOverride(): string {
  try {
    const q = builtInUrl ? '' : new URLSearchParams(location.search).get('control');
    if (q) {
      localStorage.setItem(OVERRIDE_KEY, q);
      return q;
    }
    return localStorage.getItem(OVERRIDE_KEY) ?? '';
  } catch {
    return '';
  }
}

export const controlUrl = signal((readOverride() || builtInUrl).trim().replace(/\/$/, ''));
export const controlConfigured = computed(() => controlUrl.value.length > 0);
export type ControlStatus = 'unconfigured' | 'checking' | 'online' | 'offline';
export const controlStatus = signal<ControlStatus>(controlUrl.value ? 'checking' : 'unconfigured');
export const controlVersion = signal('');
export const clock = signal<{ offsetMs: number; rttMs: number; syncedAt: number }>({ offsetMs: 0, rttMs: 0, syncedAt: 0 });

export function setControlUrl(url: string): void {
  const v = url.trim().replace(/\/$/, '');
  try {
    if (v) localStorage.setItem(OVERRIDE_KEY, v);
    else localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* ignore */
  }
  controlUrl.value = v || builtInUrl;
  controlStatus.value = controlUrl.value ? 'checking' : 'unconfigured';
  void checkControl();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function authHeaders(): Record<string, string> {
  const t = token.value;
  if (t) return { Authorization: `Bearer ${t.accessToken}` };
  // Device mode talks to a DEV_AUTH server (local dev / CI) with a dev identity.
  const p = profile.value;
  if (p?.mode === 'local') return { 'X-Dev-User': p.sub === 'local' ? 'local-singer' : p.sub, 'X-Dev-Name': p.name };
  return {};
}

/** A request body sent as it is (a media segment), with its own content type. */
export interface RawBody {
  bytes: Uint8Array;
  contentType: string;
}

async function request<T>(method: string, path: string, body?: unknown, raw?: RawBody, form?: FormData): Promise<T> {
  const base = controlUrl.value;
  if (!base) throw new ApiError(0, 'unconfigured', 'Live services are not configured for this build (VITE_CONTROL_URL)');
  let r: Response;
  try {
    // A form (a file with its fields) goes as multipart; the browser writes the boundary into the Content-Type itself.
    r = await fetch(`${base}${path}`, {
      method,
      headers: { ...authHeaders(), ...(form ? {} : raw ? { 'Content-Type': raw.contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: form ?? (raw ? (raw.bytes as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    controlStatus.value = 'offline';
    throw new ApiError(0, 'offline', 'Cannot reach the SingersVoice service — check your connection');
  }
  if (controlStatus.value !== 'online') controlStatus.value = 'online';
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!r.ok) {
    const e = (json ?? {}) as { error?: string; code?: string };
    if (r.status === 401 && profile.value?.mode === 'drive') {
      // Google access tokens live one hour: offer the one-tap reconnect instead of a dead end.
      needsReconnect.value = true;
      offerReconnect();
      throw new ApiError(401, 'reconnect', 'Your Google session expired — tap Reconnect and try again');
    }
    if (r.status === 403 && e.code === 'blocked') {
      // Blocked for good by a super admin: every page shows the notice from now (app.tsx Guard).
      const cur = account.value;
      if (cur && !cur.blocked) setAccount({ ...cur, blocked: true });
    }
    if (r.status === 403 && e.code === 'coupon_required') {
      // The coupon gate closed (a coupon changed, expired or withdrawn by the admin): every page shows the Coupon screen now.
      const cur = access.value;
      setAccess({ required: true, ok: false, standing: cur?.standing === 'ok' || !cur ? 'wrong' : cur.standing, expiresAt: cur?.expiresAt ?? null, entered: cur?.entered ?? '', note: e.error ?? 'A coupon is needed to use SingersVoice' });
    }
    throw new ApiError(r.status, e.code ?? `http_${r.status}`, e.error ?? `Request failed (${r.status})`);
  }
  return json as T;
}

let reconnectToastAt = 0;
function offerReconnect(): void {
  if (Date.now() - reconnectToastAt < 8000) return;
  reconnectToastAt = Date.now();
  toast('Google session expired', 'warn', 8000, {
    label: 'Reconnect',
    onClick: () => void reconnect().catch((err) => toast(String(err), 'error')),
  });
}

type Res<K extends keyof Routes> = Routes[K]['res'];
type Req<K extends keyof Routes> = Routes[K] extends { req: infer R } ? R : never;

/** GET a file (bytes) from the service, with the same sign-in and error handling as the JSON calls. */
async function requestBlob(path: string): Promise<Blob> {
  const base = controlUrl.value;
  if (!base) throw new ApiError(0, 'unconfigured', 'Live services are not configured for this build (VITE_CONTROL_URL)');
  let r: Response;
  try {
    r = await fetch(`${base}${path}`, { headers: authHeaders() });
  } catch {
    controlStatus.value = 'offline';
    throw new ApiError(0, 'offline', 'Cannot reach the SingersVoice service — check your connection');
  }
  if (controlStatus.value !== 'online') controlStatus.value = 'online';
  if (!r.ok) {
    let e: { error?: string; code?: string } = {};
    try {
      e = JSON.parse(await r.text()) as { error?: string; code?: string };
    } catch {
      /* not JSON */
    }
    if (r.status === 401 && profile.value?.mode === 'drive') {
      needsReconnect.value = true;
      offerReconnect();
      throw new ApiError(401, 'reconnect', 'Your Google session expired — tap Reconnect and try again');
    }
    throw new ApiError(r.status, e.code ?? `http_${r.status}`, e.error ?? `Request failed (${r.status})`);
  }
  return r.blob();
}

export const api = {
  get: <K extends keyof Routes>(_key: K, path: string) => request<Res<K>>('GET', path),
  /** GET bytes (a published track's file). */
  getBlob: <K extends keyof Routes>(_key: K, path: string) => requestBlob(path),
  post: <K extends keyof Routes>(_key: K, path: string, body?: Req<K>) => request<Res<K>>('POST', path, body ?? {}),
  put: <K extends keyof Routes>(_key: K, path: string, body: Req<K>) => request<Res<K>>('PUT', path, body),
  patch: <K extends keyof Routes>(_key: K, path: string, body: Req<K>) => request<Res<K>>('PATCH', path, body),
  /** PUT raw bytes (a media segment) and read the JSON answer. */
  putBytes: <K extends keyof Routes>(_key: K, path: string, raw: RawBody) => request<Res<K>>('PUT', path, undefined, raw),
  del: <K extends keyof Routes>(_key: K, path: string) => request<Res<K>>('DELETE', path),
  /** POST a form (a file and its fields, multipart) and read the JSON answer. */
  postForm: <K extends keyof Routes>(_key: K, path: string, form: FormData) => request<Res<K>>('POST', path, undefined, undefined, form),
};

/** An absolute URL on the service for things the browser fetches itself (an HLS playlist). */
export const serviceUrl = (path: string): string => `${controlUrl.value}${path}`;

export async function checkControl(): Promise<ControlStatus> {
  if (!controlUrl.value) return (controlStatus.value = 'unconfigured');
  try {
    const r = await fetch(`${controlUrl.value}/health`);
    if (!r.ok) throw new Error('bad status');
    const j = (await r.json()) as { version?: string };
    controlVersion.value = j.version ?? '';
    controlStatus.value = 'online';
  } catch {
    controlStatus.value = 'offline';
  }
  return controlStatus.value;
}

/** Five round-trips to /time → median offset of the fastest ones (server − local), in ms. */
export async function syncClock(samples = 5): Promise<{ offsetMs: number; rttMs: number }> {
  const out: { offsetMs: number; rttMs: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const sentAt = Date.now();
    try {
      const r = await fetch(`${controlUrl.value}/time`, { cache: 'no-store' });
      const j = (await r.json()) as { serverEpochMs: number };
      out.push(clockOffsetMs(sentAt, j.serverEpochMs, Date.now()));
    } catch {
      /* skip sample */
    }
  }
  const best = bestClockOffset(out);
  clock.value = { ...best, syncedAt: Date.now() };
  return best;
}

/** Server wall-clock now (ms since epoch) according to the last sync. */
export function serverNow(): number {
  return Date.now() + clock.value.offsetMs;
}

/** Pull my account record from the SVT DB (role, subscription, whether Publishing is open). Silent when the service is not configured. */
export async function refreshAccount(): Promise<void> {
  if (!controlUrl.value) return;
  try {
    const { user } = await api.get('GET /me', '/me');
    setPrivileged(user.privileged);
    setPlan(user.entitlement?.plan ?? user.plan ?? 'free', user.planUntil ?? null, user.canPublish ?? user.privileged);
    setRole(user.role ?? (user.privileged ? 'super_admin' : 'dual'), user.subscription ?? null, user.publishingNote ?? '', user.media ?? (user.role === 'audio' ? 'audio' : 'dual'), user.entitlement ?? null);
    setAccess(user.access ?? null);
    setAccountUserId(user.userId);
    setAccount(user);
  } catch {
    /* offline or not signed in */
  }
}
