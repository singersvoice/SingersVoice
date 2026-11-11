/**
 * Authentication: the client sends its Google OAuth access token (the same one it uses for Drive)
 * as `Authorization: Bearer …`. We verify it with Google's tokeninfo endpoint, check the audience
 * matches our OAuth client (when configured) and cache the result until the token expires.
 *
 * Dev/CI: with DEV_AUTH=1 a request may instead carry `X-Dev-User: <id>` (+ `X-Dev-Name`).
 */
export interface AuthIdentity {
  userId: string;
  email: string;
  name: string;
  picture: string;
}

export interface AuthOptions {
  googleClientId?: string;
  devAuth?: boolean;
  fetchImpl?: typeof fetch;
}

interface TokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  expires_in?: string;
  error?: string;
}

interface UserInfo {
  sub?: string;
  name?: string;
  email?: string;
  picture?: string;
}

const cache = new Map<string, { identity: AuthIdentity; expiresAt: number }>();

export type Authenticator = (req: Request) => Promise<AuthIdentity | null>;

export function createAuthenticator(opts: AuthOptions): Authenticator {
  const f = opts.fetchImpl ?? fetch;
  return async (req) => {
    if (opts.devAuth) {
      const dev = req.headers.get('x-dev-user');
      if (dev) {
        return { userId: `dev-${dev}`, email: `${dev}@dev.local`, name: req.headers.get('x-dev-name') ?? dev, picture: '' };
      }
    }
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    const hit = cache.get(token);
    if (hit && hit.expiresAt > Date.now()) return hit.identity;

    const infoRes = await f(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    if (!infoRes.ok) return null;
    const info = (await infoRes.json()) as TokenInfo;
    if (!info.sub || info.error) return null;
    if (opts.googleClientId && info.aud && info.aud !== opts.googleClientId) return null;

    let name = '';
    let picture = '';
    try {
      const ui = await f('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
      if (ui.ok) {
        const u = (await ui.json()) as UserInfo;
        name = u.name ?? '';
        picture = u.picture ?? '';
      }
    } catch {
      /* profile is optional */
    }
    const identity: AuthIdentity = { userId: `g-${info.sub}`, email: info.email ?? '', name: name || info.email?.split('@')[0] || 'Singer', picture };
    const ttl = Math.min(3600, Math.max(30, Number(info.expires_in ?? 300)));
    cache.set(token, { identity, expiresAt: Date.now() + ttl * 1000 });
    if (cache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt < now) cache.delete(k);
    }
    return identity;
  };
}
