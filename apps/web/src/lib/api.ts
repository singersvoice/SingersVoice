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
/**
 * The link to the service as the last request found it: 'offline' is no answer at all (the network, a service
 * down); a service that answered with a failure is still 'online' — what it said is in `serviceNotice`.
 */
export type ControlStatus = 'unconfigured' | 'checking' | 'online' | 'offline';
export const controlStatus = signal<ControlStatus>(controlUrl.value ? 'checking' : 'unconfigured');
export const controlVersion = signal('');
/**
 * What the service itself said is wrong, when it did: its storage allowance spent for the day (nothing can be
 * saved until 00:00 UTC — every screen says so once, with the time), or a failure it answered with. Cleared by
 * the next request that goes through.
 */
export const serviceNotice = signal<{ kind: 'storage_limit' | 'failing'; message: string; until: number | null } | null>(null);
export const clock = signal<{ offsetMs: number; rttMs: number; syncedAt: number }>({ offsetMs: 0, rttMs: 0, syncedAt: 0 });

/** How long a request may take: a JSON call, and an upload (a segment, a clip) that carries a body of size. */
const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** The words for no answer: the network, or a service that is down — never "check your connection" alone, which was wrong half the time. */
export const NO_ANSWER = 'No answer from the SingersVoice service — your connection, or the service, is down right now';

/** A fetch with a deadline (AbortSignal.timeout where the browser has it; a controller otherwise). */
export function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  return fetch(input, { ...init, ...(ctl ? { signal: ctl.signal } : {}) }).finally(() => clearTimeout(t));
}

/** A failure the service answered with (a 5xx): told apart from no answer, and said as the service said it. */
function serviceFailed(status: number, code: string | undefined, message: string | undefined, retryAfterS?: number): ApiError {
  if (status === 503 && code === 'storage_limit') {
    const until = retryAfterS ? Date.now() + retryAfterS * 1000 : null;
    serviceNotice.value = { kind: 'storage_limit', message: message ?? 'The SingersVoice service cannot save anything more today', until };
    return new ApiError(503, 'storage_limit', message ?? 'The SingersVoice service cannot save anything more today');
  }
  serviceNotice.value = { kind: 'failing', message: message ?? `The SingersVoice service failed (${status})`, until: null };
  return new ApiError(status, code ?? 'server_error', message ?? `The SingersVoice service failed (${status})`);
}

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
    r = await fetchWithTimeout(
      `${base}${path}`,
      {
        method,
        headers: { ...authHeaders(), ...(form ? {} : raw ? { 'Content-Type': raw.contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: form ?? (raw ? (raw.bytes as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined),
      },
      raw || form ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS,
    );
  } catch (e) {
    // No answer: the network, the service down, or a deadline passed — not a failure the service answered with.
    controlStatus.value = 'offline';
    throw new ApiError(0, 'offline', e instanceof Error && e.name === 'AbortError' ? 'The SingersVoice service did not answer in time — trying again' : NO_ANSWER);
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
    const e = (json ?? {}) as { error?: string; code?: string; retryAfterS?: number };
    if (r.status >= 500) throw serviceFailed(r.status, e.code, e.error, e.retryAfterS);
    if (serviceNotice.value) serviceNotice.value = null; // the service answers as itself again
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
  if (serviceNotice.value) serviceNotice.value = null;
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
    r = await fetchWithTimeout(`${base}${path}`, { headers: authHeaders() }, UPLOAD_TIMEOUT_MS);
  } catch {
    controlStatus.value = 'offline';
    throw new ApiError(0, 'offline', NO_ANSWER);
  }
  if (controlStatus.value !== 'online') controlStatus.value = 'online';
  if (!r.ok) {
    let e: { error?: string; code?: string; retryAfterS?: number } = {};
    try {
      e = JSON.parse(await r.text()) as { error?: string; code?: string; retryAfterS?: number };
    } catch {
      /* not JSON */
    }
    if (r.status >= 500) throw serviceFailed(r.status, e.code, e.error, e.retryAfterS);
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

/**
 * A word on the way out (the tab closing, the page reloading): a POST the browser keeps alive after the page is gone,
 * with the sign-in on it, never waited for. Nothing is said when the service is not configured or the browser cannot.
 */
export function beacon<K extends keyof Routes>(_key: K, path: string): void {
  const base = controlUrl.value;
  if (!base) return;
  const url = `${base}${path}`;
  try {
    // sendBeacon is the browser's own way out (no headers, no preflight, finished after the page is gone); a keepalive POST where there is none.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url)) return;
    if (typeof fetch === 'function') void fetch(url, { method: 'POST', keepalive: true }).catch(() => undefined);
  } catch {
    /* a browser without either: the service's own timeout takes it from here */
  }
}

export async function checkControl(): Promise<ControlStatus> {
  if (!controlUrl.value) return (controlStatus.value = 'unconfigured');
  try {
    const r = await fetchWithTimeout(`${controlUrl.value}/health`, {}, 10_000);
    if (!r.ok) throw new Error('bad status');
    const j = (await r.json()) as { version?: string; storage?: { writes?: string; note?: string } };
    controlVersion.value = j.version ?? '';
    controlStatus.value = 'online';
    // The service is up but cannot save (its storage allowance spent): said once, on every screen, with the time it comes back.
    if (j.storage?.writes === 'failing' && /rows written|rows read/i.test(j.storage.note ?? '')) {
      const d = new Date();
      const until = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      serviceNotice.value = { kind: 'storage_limit', message: `The SingersVoice service cannot save anything more today — its daily storage allowance is spent. It starts over at 00:00 UTC (${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} your time). Nothing already saved is lost.`, until };
    } else if (serviceNotice.value?.kind === 'storage_limit') serviceNotice.value = null;
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
      const r = await fetchWithTimeout(`${controlUrl.value}/time`, { cache: 'no-store' }, 8000);
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
