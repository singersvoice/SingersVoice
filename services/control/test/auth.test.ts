/** The authenticator (auth.ts): a Google token is a sign-in only when it was issued to this app; dev headers only when asked for. */
import { describe, expect, it } from 'vitest';
import { createAuthenticator } from '../src/auth.ts';

const google = (tokens: Record<string, { sub: string; aud: string; email?: string }>) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const t = new URL(url).searchParams.get('access_token') ?? '';
      const hit = tokens[t];
      return hit ? Response.json({ ...hit, expires_in: '3600' }) : Response.json({ error: 'invalid_token' }, { status: 400 });
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      const t = String(new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '');
      return tokens[t] ? Response.json({ sub: tokens[t]!.sub, name: `Singer ${tokens[t]!.sub}`, picture: 'https://p/x.png' }) : Response.json({}, { status: 401 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
const req = (headers: Record<string, string>) => new Request('https://svc.test/me', { headers });

describe('the authenticator', () => {
  const tokens = { 'tok-ours': { sub: '123', aud: 'our-client', email: 'ann@example.com' }, 'tok-theirs': { sub: '123', aud: 'somebody-elses-app', email: 'ann@example.com' } };
  it('takes a token issued to this app, caches it, and names the account', async () => {
    const auth = createAuthenticator({ googleClientId: 'our-client', fetchImpl: google(tokens) });
    const id = await auth(req({ Authorization: 'Bearer tok-ours' }));
    expect(id).toEqual({ userId: 'g-123', email: 'ann@example.com', name: 'Singer 123', picture: 'https://p/x.png' });
    expect(await auth(req({ Authorization: 'Bearer tok-ours' }))).toEqual(id);
  });
  it("refuses a token issued to another app, a token Google does not know, and no token", async () => {
    const auth = createAuthenticator({ googleClientId: 'our-client', fetchImpl: google(tokens) });
    expect(await auth(req({ Authorization: 'Bearer tok-theirs' }))).toBeNull();
    expect(await auth(req({ Authorization: 'Bearer tok-unknown' }))).toBeNull();
    expect(await auth(req({}))).toBeNull();
    expect(await auth(req({ Authorization: `Bearer ${'x'.repeat(5000)}` }))).toBeNull();
  });
  it('refuses every Google token when no client id is configured (nothing to check the audience against)', async () => {
    let asked = 0;
    const f = ((input: RequestInfo | URL, init?: RequestInit) => (asked++, google(tokens)(input, init))) as typeof fetch;
    const auth = createAuthenticator({ fetchImpl: f });
    expect(await auth(req({ Authorization: 'Bearer tok-ours' }))).toBeNull();
    expect(asked).toBe(0);
  });
  it('honours dev headers only when asked for (Node tests and local runs; never the Worker)', async () => {
    expect(await createAuthenticator({ devAuth: true, fetchImpl: google(tokens) })(req({ 'X-Dev-User': 'bob', 'X-Dev-Name': 'Bob' }))).toEqual({ userId: 'dev-bob', email: 'bob@dev.local', name: 'Bob', picture: '' });
    expect(await createAuthenticator({ googleClientId: 'our-client', fetchImpl: google(tokens) })(req({ 'X-Dev-User': 'bob' }))).toBeNull();
  });
});
