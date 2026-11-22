/**
 * /ice: STUN alone by default; with Cloudflare's TURN keys, short-lived TURN credentials minted on the service
 * (the API token never leaves it) and handed to every performer — kept for hours, minted again before they end,
 * and never a reason to refuse a link: a mint that fails leaves STUN (or the last set) and says nothing to the browser.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { IceServer } from '@singersvoice/protocol';
import { createApp, type AppDeps } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { SecretBox } from '../src/crypto.ts';
import { nodeSqliteDriver } from '../src/store/driver.ts';
import { openNodeSqlite } from '../src/store/node-sqlite.ts';
import { SqlStore } from '../src/store/sql.ts';

const as = (user: string) => ({ 'X-Dev-User': user, 'X-Dev-Name': user, 'Content-Type': 'application/json' });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

async function make(turn: AppDeps['turn'], fetchImpl?: typeof fetch): Promise<{ app: ReturnType<typeof createApp>; deps: AppDeps }> {
  const db = await openNodeSqlite(':memory:');
  const deps: AppDeps = {
    store: Object.assign(new SqlStore(nodeSqliteDriver(db)), { couponsRequiredDefault: false }),
    auth: createAuthenticator({ devAuth: true }),
    secrets: new SecretBox(''),
    runtime: 'node',
    allowedOrigins: [],
    privilegedEmails: [],
    version: 'test',
    turn,
    fetchImpl,
    background: (p) => void p.catch(() => undefined),
  };
  return { app: createApp(() => deps), deps };
}

describe('/ice', () => {
  let minted: { url: string; auth: string; body: string }[];
  let answer: () => Response;
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    minted.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') ?? '', body: String(init?.body ?? '') });
    return answer();
  }) as typeof fetch;
  beforeAll(() => {
    minted = [];
  });

  it('STUN alone without TURN keys', async () => {
    const { app } = await make(undefined);
    const r = await json<{ iceServers: IceServer[]; turn?: boolean }>(await app.request('/ice', { headers: as('alice') }));
    expect(r.turn).toBeUndefined();
    expect(r.iceServers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
  });

  it('with the keys: TURN credentials minted once with the token, kept for the next asks, the port-53 forms left out', async () => {
    answer = () =>
      new Response(JSON.stringify({ iceServers: { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u1', credential: 'c1' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    const { app } = await make({ keyId: 'key1', apiToken: 'tok-secret', endpoint: 'http://turn.test' }, fake);
    const r = await json<{ iceServers: IceServer[]; turn?: boolean; expiresAt?: string }>(await app.request('/ice', { headers: as('alice') }));
    expect(r.turn).toBe(true);
    expect(Date.parse(r.expiresAt ?? '')).toBeGreaterThan(Date.now() + 5 * 3600_000);
    const turn = r.iceServers.find((s) => s.username === 'u1');
    expect(turn).toBeDefined();
    expect(turn!.urls).toEqual(['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp']);
    expect(turn!.credential).toBe('c1');
    expect(r.iceServers.some((s) => String(s.urls).includes('stun.l.google.com'))).toBe(true); // the defaults stay beside it
    expect(minted).toHaveLength(1);
    expect(minted[0]!.url).toBe('http://turn.test/v1/turn/keys/key1/credentials/generate-ice-servers');
    expect(minted[0]!.auth).toBe('Bearer tok-secret');
    expect(JSON.parse(minted[0]!.body)).toEqual({ ttl: 6 * 3600 });
    expect(JSON.stringify(r)).not.toContain('tok-secret'); // the token never goes to the browser
    await app.request('/ice', { headers: as('bob') });
    expect(minted).toHaveLength(1); // kept: not minted again for every singer
  });

  it('a mint that fails is no reason to refuse a link: STUN alone, no error', async () => {
    answer = () => new Response('nope', { status: 500 });
    const { app } = await make({ keyId: 'key1', apiToken: 'tok', endpoint: 'http://turn.test' }, fake);
    const r = await app.request('/ice', { headers: as('alice') });
    expect(r.status).toBe(200);
    const body = await json<{ iceServers: IceServer[]; turn?: boolean }>(r);
    expect(body.turn).toBeUndefined();
    expect(body.iceServers.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
  });
});
