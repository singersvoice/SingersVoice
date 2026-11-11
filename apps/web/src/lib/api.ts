/**
 * sv-control (SVT DB) client: typed fetch with the Google token, NTP-style clock sync, status.
 * The URL comes from VITE_CONTROL_URL at build time; `?control=https://…` or localStorage
 * `sv.controlUrl` override it for testing another deployment.
 */
import { computed, signal } from '@preact/signals';
import { bestClockOffset, clockOffsetMs, type Routes } from '@singersvoice/protocol';
import { needsReconnect, profile, setPrivileged, token } from '../state/session.ts';

const OVERRIDE_KEY = 'sv.controlUrl';

function readOverride(): string {
  try {
    const q = new URLSearchParams(location.search).get('control');
    if (q) {
      localStorage.setItem(OVERRIDE_KEY, q);
      return q;
    }
    return localStorage.getItem(OVERRIDE_KEY) ?? '';
  } catch {
    return '';
  }
}

export const controlUrl = signal((readOverride() || (import.meta.env.VITE_CONTROL_URL ?? '')).trim().replace(/\/$/, ''));
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
  controlUrl.value = v || (import.meta.env.VITE_CONTROL_URL ?? '').trim().replace(/\/$/, '');
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = controlUrl.value;
  if (!base) throw new ApiError(0, 'unconfigured', 'Live services are not configured for this build (VITE_CONTROL_URL)');
  let r: Response;
  try {
    r = await fetch(`${base}${path}`, {
      method,
      headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
    if (r.status === 401 && token.value) needsReconnect.value = true;
    throw new ApiError(r.status, e.code ?? `http_${r.status}`, e.error ?? `Request failed (${r.status})`);
  }
  return json as T;
}

type Res<K extends keyof Routes> = Routes[K]['res'];
type Req<K extends keyof Routes> = Routes[K] extends { req: infer R } ? R : never;

export const api = {
  get: <K extends keyof Routes>(_key: K, path: string) => request<Res<K>>('GET', path),
  post: <K extends keyof Routes>(_key: K, path: string, body?: Req<K>) => request<Res<K>>('POST', path, body ?? {}),
  put: <K extends keyof Routes>(_key: K, path: string, body: Req<K>) => request<Res<K>>('PUT', path, body),
  del: <K extends keyof Routes>(_key: K, path: string) => request<Res<K>>('DELETE', path),
};

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

/** Pull my account record from the SVT DB (privileged flag). Silent when the service is not configured. */
export async function refreshAccount(): Promise<void> {
  if (!controlUrl.value) return;
  try {
    const { user } = await api.get('GET /me', '/me');
    setPrivileged(user.privileged);
  } catch {
    /* offline or not signed in */
  }
}
