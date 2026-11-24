/**
 * Every feature of SingersVoice as the Home search knows it (components/FeatureSearch.tsx): what it is called,
 * the words people reach for, and where it lives — a screen, a tab of one (`/tracks#youtube`, `/publishing?tab=…`)
 * or a section of one (`/settings#tv`). Typing a few letters on Home lists the matches; a tap (or Enter) goes
 * there. Features an account cannot use are left out of its list (`when`).
 */
import { canPublish, isSuperAdmin, ownsClub } from '../state/session.ts';

export interface Feature {
  /** The name as the screen names it. */
  title: string;
  /** Where it is: "Settings → TV", "Tracks → YouTube". */
  where: string;
  /** Other words for it (what people type). */
  keywords: string[];
  /** The app path with its tab or section: '/settings#tv', '/tracks#youtube', '/publishing?tab=destinations'. */
  path: string;
  /** Shown only when this holds (a plan, a role). */
  when?: () => boolean;
}

export const FEATURES: Feature[] = [
  // ---- the portals ----
  { title: 'Tracks', where: 'Tracks', keywords: ['songs', 'library', 'search songs', 'my drive', 'all tracks', 'database', 'svt db'], path: '/tracks' },
  { title: 'Recommended songs', where: 'Tracks → Recommended', keywords: ['recommendations', 'languages', 'what others sang', 'popular'], path: '/tracks#recommended' },
  { title: 'Bookmarks', where: 'Tracks → Bookmarks', keywords: ['star', 'starred songs', 'favourites', 'favorites', 'saved songs'], path: '/tracks#bookmarks' },
  { title: 'My Drive tracks', where: 'Tracks → My Drive', keywords: ['my songs', 'drive', 'import', 'export', 'share a track', 'publish a track'], path: '/tracks#mine' },
  { title: 'Public catalog', where: 'Tracks → Public catalog', keywords: ['catalog', 'svt db', 'published tracks', 'pull a track', 'add to my drive'], path: '/tracks#catalog' },
  { title: 'YouTube song tracks', where: 'Tracks → YouTube', keywords: ['youtube', 'backing track', 'download a song', 'video track', 'yt'], path: '/tracks#youtube' },
  { title: 'Track Maker', where: 'Studio → Track Maker', keywords: ['make a track', 'build a track', 'lyrics', 'timing', 'lrc', 'trackmaker', 'create track'], path: '/studio/trackmaker' },
  { title: 'Studio', where: 'Studio', keywords: ['sing', 'solo', 'practice', 'record', 'take', 'sing alone'], path: '/studio' },
  { title: 'Sing a song', where: 'Studio → Sing', keywords: ['sing', 'start singing', 'pick a song', 'record a take', 'backing track'], path: '/studio/sing' },
  { title: 'Performances', where: 'Studio → Performances', keywords: ['my takes', 'recordings', 'saved', 'films', 'meet performances', 'watch', 'delete a take', 'temp', 'kept', 'post a clip', 'share a performance'], path: '/studio/performances' },
  { title: 'Invite others to join a take', where: 'Studio → Performances', keywords: ['join', 'duet', 'sing with me', 'invite', 'join link', 'sing over my take'], path: '/studio/performances' },
  { title: 'Live Meets', where: 'Live Meets', keywords: ['meet', 'meets', 'live', 'room', 'stage', 'create a meet', 'join a meet', 'code', 'invite link', 'host', 'club meet'], path: '/meets' },
  { title: 'Publishing mode', where: 'Publishing', keywords: ['publish', 'go live', 'stream', 'broadcast', 'show view', 'youtube live', 'facebook live', 'twitch', 'watch page'], path: '/publishing', when: () => canPublish.value },
  { title: 'Publishing destinations', where: 'Publishing → Destinations', keywords: ['stream key', 'rtmp', 'youtube key', 'destinations', 'live link'], path: '/publishing?tab=destinations', when: () => canPublish.value },
  { title: 'Preview a meet', where: 'Publishing → Preview', keywords: ['monitor', 'preview', 'watch a meet'], path: '/publishing?tab=preview', when: () => canPublish.value },
  // ---- plans and the club ----
  { title: 'Plans', where: 'Plans', keywords: ['price', 'pricing', 'subscription', 'pay', 'upgrade', 'svv', 'svvpro', 'club owner', 'video hours', 'stripe', 'promo code', 'coupon code', 'offer', 'my plan', 'cancel', 'manage subscription'], path: '/plans', when: () => !isSuperAdmin.value },
  { title: 'My club', where: 'My club', keywords: ['club', 'members', 'add a member', 'seats', 'club hours'], path: '/club', when: () => ownsClub.value },
  // ---- Settings ----
  { title: 'Account & Google Drive', where: 'Settings → Account', keywords: ['account', 'drive', 'google', 'sign out', 'sign in', 'storage', 'quota', 'singersvoice number', 'sv number', 'my number', 'phone', 'coupon'], path: '/settings#account' },
  { title: 'Block someone', where: 'Settings → Account', keywords: ['block', 'blocked', 'unblock', 'keep out', 'ban', 'people'], path: '/settings#account' },
  { title: 'Display', where: 'Settings → Display', keywords: ['text size', 'lyrics size', 'contrast', 'count-in', 'cue', 'display'], path: '/settings#display' },
  { title: 'Audio & microphone', where: 'Settings → Audio', keywords: ['microphone', 'mic', 'input', 'echo', 'echo cancellation', 'headphones', 'instrument', 'latency', 'sync', 'check the sync', 'lag', 'delay', 'audio'], path: '/settings#audio' },
  { title: 'Check the sync (lag)', where: 'Settings → Audio', keywords: ['sync', 'lag', 'delay', 'latency', 'out of time', 'alignment', 'clicks'], path: '/settings#audio' },
  { title: 'VoxForge voice', where: 'Settings → VoxForge voice', keywords: ['voice', 'effects', 'fx', 'presets', 'autotune', 'auto-tune', 'pitch', 'reverb', 'noise gate', 'hiss', 'compressor', 'eq', 'de-esser', 'voxforge'], path: '/settings#voice' },
  { title: 'Camera & picture', where: 'Settings → Camera', keywords: ['camera', 'picture', 'cut-out', 'background', 'my camera as it is', 'framing', 'zoom', 'auto zoom', 'autozoom', 'still', 'close-up', 'video'], path: '/settings#camera' },
  { title: 'TV in the room', where: 'Settings → TV', keywords: ['tv', 'television', 'big screen', 'cast', 'project', 'qr', 'code', 'smart tv', 'second screen'], path: '/settings#tv' },
  { title: 'Social networks', where: 'Settings → Social', keywords: ['social', 'x', 'twitter', 'facebook', 'instagram', 'post', 'share', 'clip', 'connect', 'handle', 'reel'], path: '/settings#social' },
  { title: 'Stage & publishing backgrounds', where: 'Settings → Backgrounds', keywords: ['background', 'stage background', 'backdrop', 'scene'], path: '/settings#backgrounds' },
  { title: 'About & reset', where: 'Settings → About', keywords: ['version', 'build', 'reset', 'wipe', 'clear data', 'about'], path: '/settings#about' },
  { title: 'Live services (SVT DB)', where: 'Settings → Live services', keywords: ['service', 'service url', 'svt db', 'control', 'deployment'], path: '/settings#services', when: () => isSuperAdmin.value },
  // ---- Admin ----
  { title: 'Admin', where: 'Admin', keywords: ['admin', 'accounts', 'users', 'roles', 'super admin', 'grant a plan', 'revoke', 'block for good'], path: '/admin', when: () => isSuperAdmin.value },
  { title: 'Plans & payments (admin)', where: 'Admin → Plans & payments', keywords: ['prices', 'offers', 'promo codes', 'coupons', 'payments', 'refund', 'subscribers', 'stripe', 'billing'], path: '/admin#billing', when: () => isSuperAdmin.value },
  { title: 'Live now (admin)', where: 'Admin → Live now', keywords: ['live', 'meets open', 'who is in', 'links', 'storage', 'rows', 'monitor', 'health'], path: '/admin#live', when: () => isSuperAdmin.value },
  { title: 'Social posting (admin)', where: 'Admin → Social posting', keywords: ['x', 'facebook', 'instagram', 'meta', 'developer app', 'client id', 'app secret', 'switch on posting', 'register'], path: '/admin#social-apps', when: () => isSuperAdmin.value },
  { title: 'Coupons (the gate)', where: 'Admin → Coupons', keywords: ['coupon', 'gate', 'who may use', 'invite', 'access'], path: '/admin/coupons', when: () => isSuperAdmin.value },
  // ---- the rest ----
  { title: 'Home', where: 'Home', keywords: ['home', 'start', 'main'], path: '/home' },
  { title: 'Settings', where: 'Settings', keywords: ['settings', 'preferences', 'options'], path: '/settings' },
];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The features that match the words typed, best first: a title that starts with them, then a title that has them,
 * then a keyword that starts with them, then a keyword that has them; every word typed must match something.
 * Nothing typed → nothing (the list is long; the portals are on the page already).
 */
export function searchFeatures(query: string, max = 8, all: readonly Feature[] = FEATURES): Feature[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored: { f: Feature; score: number }[] = [];
  for (const f of all) {
    if (f.when && !f.when()) continue;
    const title = norm(f.title);
    const where = norm(f.where);
    const keys = f.keywords.map(norm);
    let score = 0;
    for (const w of words) {
      let best = 0;
      if (title.startsWith(w)) best = 100;
      else if (title.split(' ').some((t) => t.startsWith(w))) best = 80;
      else if (title.includes(w)) best = 60;
      else if (keys.some((k) => k === w)) best = 55;
      else if (keys.some((k) => k.split(' ').some((t) => t.startsWith(w)))) best = 40;
      else if (keys.some((k) => k.includes(w))) best = 25;
      else if (where.includes(w)) best = 10;
      if (!best) {
        score = 0;
        break;
      }
      score += best;
    }
    if (score) scored.push({ f, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.f.title.localeCompare(b.f.title))
    .slice(0, max)
    .map((x) => x.f);
}
