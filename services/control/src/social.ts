/**
 * Social — the networks a singer posts clips to, as the service talks to them (protocol/social.ts).
 *
 * Two developer apps the operator registers (docs/SOCIAL.md) — one with X, one with Meta (Facebook
 * Pages and Instagram professional accounts) — and their ids and secrets as service secrets. The
 * singer connects a network by the network's own sign-in page (OAuth: the service holds the client
 * secret, makes the state and — for X — the PKCE pair, and takes the code back on its callback route);
 * the tokens that come back live sealed in the SVT DB (SecretBox) and are opened only to make a post.
 * Posting: the clip the browser made goes to the service, which pushes it to the network — X by its
 * chunked media upload then a post; a Facebook Page by one video upload; Instagram by a resumable
 * upload into a media container that Instagram processes, then publishes. Nothing here needs an SDK:
 * plain fetch, so it runs on Node and on the Cloudflare Worker alike. Snapchat and personal Instagram
 * accounts have no API a web app may post through: the phone's share sheet takes the clip there.
 */
import type { SocialPage } from '@singersvoice/protocol';

export interface SocialConfig {
  xClientId?: string;
  xClientSecret?: string;
  metaAppId?: string;
  metaAppSecret?: string;
  /** The service's own public address (SERVICE_URL), for the networks' redirect back; else the request's origin. */
  serviceUrl?: string;
  fetchImpl?: typeof fetch;
  /** How long to wait between looks at a video a network is still processing (ms; tests shorten it). */
  pollMs?: number;
  /** The networks' endpoints (tests point them at fakes). */
  xApi?: string;
  xAuthorize?: string;
  metaGraph?: string;
  metaVideo?: string;
  metaUpload?: string;
  metaAuthorize?: string;
}

export const X_API = 'https://api.x.com';
export const X_AUTHORIZE = 'https://x.com/i/oauth2/authorize';
export const META_VERSION = 'v21.0';
export const META_GRAPH = `https://graph.facebook.com/${META_VERSION}`;
export const META_VIDEO = `https://graph-video.facebook.com/${META_VERSION}`;
export const META_UPLOAD = `https://rupload.facebook.com/ig-api-upload/${META_VERSION}`;
export const META_AUTHORIZE = `https://www.facebook.com/${META_VERSION}/dialog/oauth`;

/** What X asks of a post with a video, and the refresh token so the sign-in holds. */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
/** Pages to list and post to, and the Instagram account linked to a Page to publish on. */
export const META_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'];

/** X's chunks: 4 MB each (the limit is 5). */
const X_CHUNK = 4 * 1024 * 1024;

export const xConfigured = (s: SocialConfig | undefined): boolean => Boolean(s?.xClientId && s.xClientSecret);
export const metaConfigured = (s: SocialConfig | undefined): boolean => Boolean(s?.metaAppId && s.metaAppSecret);

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A state (and, for X, the PKCE pair): random, URL-safe. */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

async function call<T>(cfg: SocialConfig, url: string, init: RequestInit & { what: string }): Promise<T> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const r = await fetchImpl(url, init);
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!r.ok) {
    const j = (json ?? {}) as { error?: { message?: string } | string; error_description?: string; detail?: string; title?: string; errors?: { message?: string }[] };
    const msg = (typeof j.error === 'object' && j.error?.message) || j.error_description || j.detail || j.errors?.[0]?.message || (typeof j.error === 'string' ? j.error : null) || j.title || text.slice(0, 200) || `${r.status}`;
    throw new Error(`${init.what}: ${msg}`);
  }
  return json as T;
}

// ---------- X ----------

export interface XTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO. */
  expiresAt: string | null;
}

export function xAuthorizeUrl(cfg: SocialConfig, i: { redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.xClientId ?? '', redirect_uri: i.redirectUri, scope: X_SCOPES.join(' '), state: i.state, code_challenge: i.challenge, code_challenge_method: 'S256' });
  return `${cfg.xAuthorize ?? X_AUTHORIZE}?${q}`;
}

const xBasic = (cfg: SocialConfig) => `Basic ${btoa(`${cfg.xClientId ?? ''}:${cfg.xClientSecret ?? ''}`)}`;
const tokensOf = (t: { access_token?: string; refresh_token?: string; expires_in?: number }, what: string): XTokens => {
  if (!t.access_token) throw new Error(`${what}: no token came back`);
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null };
};

export async function xExchange(cfg: SocialConfig, i: { code: string; redirectUri: string; verifier: string }): Promise<XTokens> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: i.code, redirect_uri: i.redirectUri, code_verifier: i.verifier, client_id: cfg.xClientId ?? '' });
  const t = await call<{ access_token?: string; refresh_token?: string; expires_in?: number }>(cfg, `${cfg.xApi ?? X_API}/2/oauth2/token`, { method: 'POST', headers: { Authorization: xBasic(cfg), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), what: 'X sign-in' });
  return tokensOf(t, 'X sign-in');
}

export async function xRefresh(cfg: SocialConfig, refreshToken: string): Promise<XTokens> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.xClientId ?? '' });
  const t = await call<{ access_token?: string; refresh_token?: string; expires_in?: number }>(cfg, `${cfg.xApi ?? X_API}/2/oauth2/token`, { method: 'POST', headers: { Authorization: xBasic(cfg), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), what: 'X sign-in renewal' });
  const out = tokensOf(t, 'X sign-in renewal');
  return { ...out, refreshToken: out.refreshToken ?? refreshToken };
}

export async function xMe(cfg: SocialConfig, accessToken: string): Promise<{ id: string; username: string; name: string }> {
  const r = await call<{ data?: { id?: string; username?: string; name?: string } }>(cfg, `${cfg.xApi ?? X_API}/2/users/me`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, what: 'X account' });
  if (!r.data?.id || !r.data.username) throw new Error('X account: no account came back');
  return { id: r.data.id, username: r.data.username, name: r.data.name ?? r.data.username };
}

export async function xRevoke(cfg: SocialConfig, token: string): Promise<void> {
  const body = new URLSearchParams({ token, client_id: cfg.xClientId ?? '', token_type_hint: 'access_token' });
  await call(cfg, `${cfg.xApi ?? X_API}/2/oauth2/revoke`, { method: 'POST', headers: { Authorization: xBasic(cfg), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), what: 'X sign-out' }).catch(() => undefined);
}

/** The video to X in chunks, then finalized and — if X processes it — waited for; the media id for the post. */
export async function xUploadVideo(cfg: SocialConfig, accessToken: string, bytes: Uint8Array, mime: string, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const base = `${cfg.xApi ?? X_API}/2/media/upload`;
  const auth = { Authorization: `Bearer ${accessToken}` };
  const init = await call<{ data?: { id?: string } }>(cfg, `${base}/initialize`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ media_type: mime || 'video/mp4', total_bytes: bytes.byteLength, media_category: 'tweet_video' }), what: 'X media upload' });
  const id = init.data?.id;
  if (!id) throw new Error('X media upload: no media id came back');
  for (let i = 0, seg = 0; i < bytes.byteLength; i += X_CHUNK, seg++) {
    const form = new FormData();
    form.set('segment_index', String(seg));
    form.set('media', new Blob([bytes.subarray(i, Math.min(bytes.byteLength, i + X_CHUNK)) as BlobPart], { type: mime || 'video/mp4' }), 'clip');
    await call(cfg, `${base}/${encodeURIComponent(id)}/append`, { method: 'POST', headers: auth, body: form, what: `X media upload (part ${seg + 1})` });
  }
  const fin = await call<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(cfg, `${base}/${encodeURIComponent(id)}/finalize`, { method: 'POST', headers: auth, what: 'X media upload (finalize)' });
  let info = fin.data?.processing_info ?? null;
  let waited = 0;
  while (info && info.state !== 'succeeded') {
    if (info.state === 'failed') throw new Error('X could not process the video');
    if (waited > 120_000) throw new Error('X is still processing the video — try again in a minute');
    const ms = Math.min(10_000, Math.max(1000, (info.check_after_secs ?? 2) * 1000));
    await wait(ms);
    waited += ms;
    const st = await call<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(cfg, `${base}?command=STATUS&media_id=${encodeURIComponent(id)}`, { method: 'GET', headers: auth, what: 'X media upload (status)' });
    info = st.data?.processing_info ?? null;
  }
  return id;
}

export async function xCreatePost(cfg: SocialConfig, accessToken: string, text: string, mediaId: string): Promise<{ id: string }> {
  const r = await call<{ data?: { id?: string } }>(cfg, `${cfg.xApi ?? X_API}/2/tweets`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, media: { media_ids: [mediaId] } }), what: 'X post' });
  if (!r.data?.id) throw new Error('X post: no post id came back');
  return { id: r.data.id };
}

export const xPostUrl = (username: string, id: string): string => `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(id)}`;

// ---------- Meta: Facebook Pages and Instagram professional accounts ----------

export function metaAuthorizeUrl(cfg: SocialConfig, i: { redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ client_id: cfg.metaAppId ?? '', redirect_uri: i.redirectUri, state: i.state, scope: META_SCOPES.join(','), response_type: 'code' });
  return `${cfg.metaAuthorize ?? META_AUTHORIZE}?${q}`;
}

/** The code for a user token, then the long-lived one (60 days): the Page tokens listed with it do not expire. */
export async function metaExchange(cfg: SocialConfig, i: { code: string; redirectUri: string }): Promise<{ accessToken: string; expiresAt: string | null }> {
  const graph = cfg.metaGraph ?? META_GRAPH;
  const q1 = new URLSearchParams({ client_id: cfg.metaAppId ?? '', client_secret: cfg.metaAppSecret ?? '', redirect_uri: i.redirectUri, code: i.code });
  const short = await call<{ access_token?: string }>(cfg, `${graph}/oauth/access_token?${q1}`, { method: 'GET', what: 'Meta sign-in' });
  if (!short.access_token) throw new Error('Meta sign-in: no token came back');
  const q2 = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: cfg.metaAppId ?? '', client_secret: cfg.metaAppSecret ?? '', fb_exchange_token: short.access_token });
  const long = await call<{ access_token?: string; expires_in?: number }>(cfg, `${graph}/oauth/access_token?${q2}`, { method: 'GET', what: 'Meta sign-in' }).catch(() => ({ access_token: short.access_token, expires_in: 3600 }));
  const token = long.access_token ?? short.access_token;
  return { accessToken: token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null };
}

export interface MetaPage extends SocialPage {
  /** The Page's own token (posts to the Page and to its Instagram account go with it). */
  accessToken: string;
}

export async function metaPages(cfg: SocialConfig, userToken: string): Promise<MetaPage[]> {
  const q = new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50', access_token: userToken });
  const r = await call<{ data?: { id: string; name: string; access_token?: string; instagram_business_account?: { id: string; username?: string } }[] }>(cfg, `${cfg.metaGraph ?? META_GRAPH}/me/accounts?${q}`, { method: 'GET', what: 'Facebook Pages' });
  return (r.data ?? [])
    .filter((p) => p.id && p.access_token)
    .map((p) => ({ pageId: p.id, name: p.name ?? p.id, accessToken: p.access_token!, instagram: p.instagram_business_account?.id ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? p.instagram_business_account.id } : null }));
}

/** A video post on the Page: one upload (files up to 1 GB), the video's id back. */
export async function fbPostVideo(cfg: SocialConfig, pageToken: string, pageId: string, bytes: Uint8Array, mime: string, description: string): Promise<{ id: string }> {
  const form = new FormData();
  form.set('description', description);
  form.set('access_token', pageToken);
  form.set('source', new Blob([bytes as BlobPart], { type: mime || 'video/mp4' }), mime.includes('webm') ? 'clip.webm' : 'clip.mp4');
  const r = await call<{ id?: string }>(cfg, `${cfg.metaVideo ?? META_VIDEO}/${encodeURIComponent(pageId)}/videos`, { method: 'POST', body: form, what: 'Facebook post' });
  if (!r.id) throw new Error('Facebook post: no video id came back');
  return { id: r.id };
}

export const fbVideoUrl = (videoId: string): string => `https://www.facebook.com/watch/?v=${encodeURIComponent(videoId)}`;

/** A Reel's container with the video uploaded into it (resumable upload); Instagram then processes it. */
export async function igCreateReel(cfg: SocialConfig, pageToken: string, igUserId: string, bytes: Uint8Array, caption: string): Promise<{ containerId: string }> {
  const body = new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable', caption, access_token: pageToken });
  const r = await call<{ id?: string }>(cfg, `${cfg.metaGraph ?? META_GRAPH}/${encodeURIComponent(igUserId)}/media`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), what: 'Instagram post' });
  if (!r.id) throw new Error('Instagram post: no media container came back');
  const up = await call<{ success?: boolean }>(cfg, `${cfg.metaUpload ?? META_UPLOAD}/${encodeURIComponent(r.id)}`, { method: 'POST', headers: { Authorization: `OAuth ${pageToken}`, offset: '0', file_size: String(bytes.byteLength), 'Content-Type': 'application/octet-stream' }, body: bytes as unknown as BodyInit, what: 'Instagram upload' });
  if (up.success === false) throw new Error('Instagram upload: the video was not taken');
  return { containerId: r.id };
}

export type IgStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

export async function igContainerStatus(cfg: SocialConfig, pageToken: string, containerId: string): Promise<{ status: IgStatus; note: string }> {
  const q = new URLSearchParams({ fields: 'status_code,status', access_token: pageToken });
  const r = await call<{ status_code?: string; status?: string }>(cfg, `${cfg.metaGraph ?? META_GRAPH}/${encodeURIComponent(containerId)}?${q}`, { method: 'GET', what: 'Instagram processing' });
  const s = (r.status_code ?? 'IN_PROGRESS') as IgStatus;
  return { status: ['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(s) ? s : 'IN_PROGRESS', note: r.status ?? '' };
}

export async function igPublish(cfg: SocialConfig, pageToken: string, igUserId: string, containerId: string): Promise<{ id: string; url: string | null }> {
  const body = new URLSearchParams({ creation_id: containerId, access_token: pageToken });
  const r = await call<{ id?: string }>(cfg, `${cfg.metaGraph ?? META_GRAPH}/${encodeURIComponent(igUserId)}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), what: 'Instagram publish' });
  if (!r.id) throw new Error('Instagram publish: no media id came back');
  const q = new URLSearchParams({ fields: 'permalink', access_token: pageToken });
  const link = await call<{ permalink?: string }>(cfg, `${cfg.metaGraph ?? META_GRAPH}/${encodeURIComponent(r.id)}?${q}`, { method: 'GET', what: 'Instagram link' }).catch(() => ({ permalink: undefined }));
  return { id: r.id, url: link.permalink ?? null };
}
