/**
 * Social — a clip of a saved performance posted to the singer's networks.
 *
 * The singer picks a section of a performance (from–to), the app makes a clip of it (the show picture
 * with its sound, MP4 where the device can), and then:
 *   - the networks connected in Settings → Social post it straight from here, on the singer's own
 *     handle: X (a post with the video on the timeline), a Facebook Page (a video post on the Page) and
 *     the Instagram professional account linked to that Page (a Reel on the profile). Connecting needs
 *     the SingersVoice service to hold a developer app for the network (X_CLIENT_ID / X_CLIENT_SECRET,
 *     META_APP_ID / META_APP_SECRET — docs/SOCIAL.md); the singer's tokens live sealed on the service and
 *     never reach the browser; the clip goes browser → service → network. A personal Facebook profile
 *     and a personal Instagram account cannot be posted to by any app (the networks' rule), and Snapchat
 *     has no API a web app may post through — so none of those is offered;
 *   - beside that, on a phone the system share sheet takes the clip to any app installed, and on a
 *     computer the clip downloads.
 */

export type SocialNetwork = 'x' | 'facebook' | 'instagram';
export const SOCIAL_NETWORKS: SocialNetwork[] = ['x', 'facebook', 'instagram'];
/** Who the sign-in is with: X is X; Facebook and Instagram are one Meta sign-in. */
export type SocialProvider = 'x' | 'meta';

export const socialTitle: Record<SocialNetwork, string> = { x: 'X', facebook: 'Facebook Page', instagram: 'Instagram' };

/** A network the account connected: where posts go. */
export interface SocialConnection {
  network: SocialNetwork;
  /** The handle shown: @name on X, the Page's name, the Instagram username. */
  handle: string;
  /** The network's id of the target (the X user, the Page, the Instagram account). */
  targetId: string;
  connectedAt: string;
  /** When the network's token runs out (null = it is renewed by itself or does not expire). */
  expiresAt: string | null;
}

/** A Facebook Page the singer manages, offered when the Meta sign-in finds more than one. */
export interface SocialPage {
  pageId: string;
  name: string;
  /** The Instagram professional account linked to the Page, if any. */
  instagram: { id: string; username: string } | null;
}

/** `GET /social`: what the service can connect, and what this account has connected. */
export interface SocialStatus {
  /** The service holds a developer app for the provider: Connect is possible. */
  configured: Record<SocialProvider, boolean>;
  connections: SocialConnection[];
  /** After a Meta sign-in that found several Pages: pick one (`POST /social/meta/page`). */
  pagesToPick: SocialPage[];
  /** The account's recent posts, newest first. */
  posts: SocialPost[];
}

export type SocialPostStatus = 'uploading' | 'processing' | 'posted' | 'failed';

/** A post made from here, as the service keeps it. */
export interface SocialPost {
  postId: string;
  userId: string;
  network: SocialNetwork;
  status: SocialPostStatus;
  /** The network's id of the post (or the media container while processing). */
  externalId: string | null;
  /** Where to see it, once posted. */
  url: string | null;
  text: string;
  /** What the clip was of. */
  performanceId: string | null;
  title: string;
  clipMs: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** The limits the networks put on a clip, so the picker keeps within them (seconds, bytes). */
export const CLIP_LIMITS: Record<SocialNetwork, { maxSeconds: number; maxBytes: number }> = {
  x: { maxSeconds: 140, maxBytes: 512 * 1024 * 1024 },
  facebook: { maxSeconds: 360, maxBytes: 95 * 1024 * 1024 },
  instagram: { maxSeconds: 180, maxBytes: 95 * 1024 * 1024 },
};
/** A clip is at most this long whatever the network (a whole song for a Page; the service takes 95 MB). */
export const CLIP_MAX_SECONDS = 360;
export const CLIP_MIN_SECONDS = 3;
/** The caption's size (X's limit is 280 characters; the others take more). */
export const CAPTION_MAX: Record<SocialNetwork, number> = { x: 280, facebook: 2000, instagram: 2200 };

/** The default caption for a clip: the song, who sang, where it was sung. */
export function clipCaption(i: { title: string; singers?: string[]; link?: string | null }): string {
  const who = i.singers?.length ? ` — ${i.singers.join(', ')}` : '';
  return `${i.title}${who} · sung on SingersVoice${i.link ? `\n${i.link}` : ''}`;
}

/** The network's own composer, for a computer that cannot share a file: the text and the link go in, the clip is attached by hand. */
export function composerUrl(network: SocialNetwork, text: string, url: string | null): string | null {
  if (network === 'x') return `https://x.com/intent/post?text=${encodeURIComponent(text)}${url ? `&url=${encodeURIComponent(url)}` : ''}`;
  if (network === 'facebook') return url ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` : null;
  return null; // Instagram has no web composer that takes a video
}

/** A clip's span kept within its bounds: whole milliseconds, at least CLIP_MIN_SECONDS, at most `max` seconds, inside the performance. */
export function clampClip(fromMs: number, toMs: number, durationMs: number, maxSeconds = CLIP_MAX_SECONDS): { fromMs: number; toMs: number } {
  const d = Math.max(0, Math.round(durationMs));
  let a = Math.min(d, Math.max(0, Math.round(fromMs)));
  let b = Math.min(d, Math.max(0, Math.round(toMs)));
  if (b < a) [a, b] = [b, a];
  const minMs = Math.min(d, CLIP_MIN_SECONDS * 1000);
  if (b - a < minMs) b = Math.min(d, a + minMs);
  if (b - a < minMs) a = Math.max(0, b - minMs);
  const maxMs = maxSeconds * 1000;
  if (b - a > maxMs) b = a + maxMs;
  return { fromMs: a, toMs: b };
}

/** `GET /admin/social`: how SingersVoice is registered with the networks (the super admin's page); secrets are never answered, only whether one is set. */
export interface AdminSocialStatus {
  x: { clientId: string; secretSet: boolean; fromEnv: boolean };
  meta: { appId: string; secretSet: boolean; fromEnv: boolean };
  /** The addresses to paste into the networks' developer pages as the way back. */
  callbacks: { x: string; meta: string };
  updatedAt: string | null;
}

/** `PUT /admin/social`: an id and its secret for a provider (both given); an empty id takes the provider's pair away. */
export interface AdminSocialUpdate {
  xClientId?: string;
  xClientSecret?: string;
  metaAppId?: string;
  metaAppSecret?: string;
}
