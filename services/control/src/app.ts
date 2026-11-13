/**
 * sv-control — the SVT DB API (Hono). Runs unchanged on Node (@hono/node-server) and on
 * Cloudflare Workers; storage and auth are injected per runtime.
 *
 * Portals it serves (each independent of the others):
 *   /catalog/*      Tracks portal — public track catalog (SVT DB) backed by owners' Drive links
 *   /meets/*        Live Meets — rooms, stage slots, GMT kickstart, chat, recordings, 5-min idle expiry
 *   /watch/*        In-house watch portal (public, no sign-in)
 *   /publishing/*   Publishing mode — destinations + publish jobs (privileged users)
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  DESTINATIONS,
  MAX_OPEN_MEETS,
  meetIsOpen,
  newId,
  type CatalogPublishRequest,
  type CatalogTrack,
  type ChatMessage,
  type ChatRequest,
  type CreateMeetRequest,
  type Destination,
  type DestinationKind,
  type DestinationUpdate,
  type HeartbeatRequest,
  type IceServer,
  type JoinMeetRequest,
  type MeetSnapshot,
  type Participant,
  type PublishJob,
  type PublishJobRequest,
  type ReadyRequest,
  type MeetPerformance,
  type MixBatch,
  type RegisterPerformanceRequest,
  type RegisterRecordingRequest,
  type SignalRequest,
  type SlotRequest,
  type DecideRequest,
  type SongPick,
  type StartMeetRequest,
  type UserRecord,
  LIVE_STALE_MS,
  YOUTUBE_HLS_INGEST,
  type LiveSegmentInfo,
  type LiveStatus,
  type PublishJobLive,
} from '@singersvoice/protocol';
import type { Authenticator } from './auth.ts';
import type { SecretBox } from './crypto.ts';
import { addSong, claimSlot, decideRequest, ensureMeet, isHost, newMeet, nextSong, pause, reconcile, reportClock, requestStage, resume, setReady, setStagePolicy, songAction, start, stop, tick, touch, withdrawRequest, seek, canTransport } from './meets.ts';
import { hlsPlaylist, SEGMENT_NAME, sendToYoutube, youtubeWindow } from './live.ts';
import type { SqlStore, StoredParticipant } from './store/sql.ts';

export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/** ICE_SERVERS env: a JSON array of RTCIceServer ({urls, username?, credential?}); invalid or empty → STUN defaults. */
export function parseIceServers(raw: string | undefined): IceServer[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || !v.length) return undefined;
    const out = v.filter((x): x is IceServer => Boolean(x && typeof x === 'object' && (x as IceServer).urls));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface AppDeps {
  /** ICE servers handed to performers (ICE_SERVERS env, JSON array); STUN only by default. */
  iceServers?: IceServer[];
  store: SqlStore;
  auth: Authenticator;
  secrets: SecretBox;
  runtime: 'node' | 'cloudflare';
  allowedOrigins: string[];
  privilegedEmails: string[];
  version: string;
  /** YouTube's HLS ingestion endpoint (YOUTUBE_HLS_BASE env; tests point it at the fake below). */
  youtubeHlsBase?: string;
  /** Node, tests and local dev only: accept YouTube-style PUTs at /fake/youtube/http_upload_hls and keep the files in this directory. */
  fakeYoutubeDir?: string;
}

type Vars = { deps: AppDeps; user: UserRecord };
type Env = { Bindings: Record<string, unknown>; Variables: Vars };

const DEFAULT_ORIGINS = ['https://singersvoice.github.io', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];

function err(c: Context<Env>, status: 400 | 401 | 403 | 404 | 409 | 410, code: string, message: string) {
  return c.json({ error: message, code }, status);
}

const userTouch = new Map<string, number>();

const requestLog = typeof process !== 'undefined' && process.env?.SV_REQUEST_LOG === '1';

export function createApp(getDeps: (env: Record<string, unknown>) => Promise<AppDeps> | AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const deps = await getDeps(c.env ?? {});
    c.set('deps', deps);
    await deps.store.migrate();
    // SV_REQUEST_LOG=1 (dev / CI diagnostics): one line per request with its duration.
    const t0 = requestLog ? Date.now() : 0;
    await next();
    if (requestLog) console.log(`${new Date().toISOString().slice(11, 23)} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - t0}ms`);
  });

  app.use(
    '*',
    cors({
      origin: (origin, c) => {
        const allowed = [...DEFAULT_ORIGINS, ...(c.get('deps')?.allowedOrigins ?? [])];
        return allowed.includes(origin) ? origin : allowed[0]!;
      },
      allowHeaders: ['Authorization', 'Content-Type', 'X-Dev-User', 'X-Dev-Name'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  // ---------- public ----------

  app.get('/health', async (c) => {
    const d = c.get('deps');
    return c.json({ ok: true as const, service: 'sv-control' as const, version: d.version, runtime: d.runtime, now: Date.now() });
  });
  app.get('/time', (c) => c.json({ serverEpochMs: Date.now() }));

  app.get('/watch/:id', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (tick(meet)) await store.saveMeet(meet);
    const chat = await store.chatTail(meet.meetId, 50);
    const { meetId, title, hostName, trackTitle, catalogTrackId, state, backgroundId, stage, audienceCount, kickstartEpochMs, streamUrl, expiresAt } = meet;
    return c.json({ meet: { meetId, title, hostName, trackTitle, catalogTrackId, state, backgroundId, stage, audienceCount, kickstartEpochMs, streamUrl, expiresAt }, chat, serverEpochMs: Date.now() });
  });
  // The stage mix, for the public watch page too (the host shares that link on purpose).
  app.get('/watch/:id/mix', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const since = Math.max(0, Number(c.req.query('since')) || 0);
    const r = await store.listMix(meet.meetId, since);
    return c.json({ ...r, serverEpochMs: Date.now() });
  });

  // The show itself, as the publisher's browser delivers it: an HLS playlist of the last few segments.
  const liveJob = async (store: SqlStore, meetId: string): Promise<PublishJob | null> => {
    const jobs = await store.liveJobsForMeet(meetId);
    return jobs.find((j) => j.state === 'live' && j.live?.lastSegmentAt && Date.now() - Date.parse(j.live.lastSegmentAt) < LIVE_STALE_MS) ?? null;
  };
  app.get('/watch/:id/live', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const job = await liveJob(store, meet.meetId);
    const status: LiveStatus = {
      live: job !== null,
      jobId: job?.jobId ?? null,
      segments: job?.live?.segments ?? 0,
      lastSegmentAt: job?.live?.lastSegmentAt ?? null,
      playlistPath: job ? `/watch/${meet.meetId}/live.m3u8` : null,
      audio: job?.live?.audio ?? false,
    };
    return c.json(status);
  });
  app.get('/watch/:id/live.m3u8', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const job = await liveJob(store, meet.meetId);
    if (!job) return err(c, 404, 'not_live', 'The show is not on');
    const segments = await store.listLiveSegments(job.jobId);
    if (!segments.length) return err(c, 404, 'not_live', 'No segment yet');
    return c.body(hlsPlaylist(segments, (name) => `live/${name}`), 200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  });
  app.get('/watch/:id/live/:name', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const name = c.req.param('name');
    if (!SEGMENT_NAME.test(name)) return err(c, 400, 'bad_name', 'Not a segment name');
    const job = await liveJob(store, meet.meetId);
    const bytes = job ? await store.getLiveSegment(job.jobId, name) : null;
    if (!bytes) return err(c, 404, 'no_segment', 'That segment is gone');
    return c.body(bytes as unknown as ArrayBuffer, 200, { 'Content-Type': 'video/MP2T', 'Cache-Control': 'max-age=60' });
  });

  // A stand-in for YouTube's ingestion endpoint (tests, local runs): keeps what it is sent in a directory.
  app.put('/fake/youtube/http_upload_hls', async (c) => {
    const { fakeYoutubeDir, runtime } = c.get('deps');
    if (!fakeYoutubeDir || runtime !== 'node') return err(c, 404, 'not_found', 'Not found');
    const file = c.req.query('file') ?? '';
    if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.includes('..')) return c.body('bad file', 400);
    if (!c.req.query('cid')) return c.body('no key', 401);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(fakeYoutubeDir, { recursive: true });
    await fs.writeFile(path.join(fakeYoutubeDir, path.basename(file)), bytes);
    return c.body('', 200);
  });

  // ---------- auth ----------

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/health' || path === '/time' || path.startsWith('/watch/') || path.startsWith('/fake/') || c.req.method === 'OPTIONS') return next();
    const deps = c.get('deps');
    const id = await deps.auth(c.req.raw);
    if (!id) return err(c, 401, 'unauthenticated', 'Sign in with Google to use SingersVoice');
    const privilegedByEnv = deps.privilegedEmails.includes(id.email.toLowerCase());
    const last = userTouch.get(id.userId) ?? 0;
    let user: UserRecord | null = null;
    if (Date.now() - last > 5 * 60 * 1000) {
      user = await deps.store.upsertUser({ userId: id.userId, email: id.email, name: id.name, picture: id.picture, ...(privilegedByEnv ? { privileged: true } : {}) });
      userTouch.set(id.userId, Date.now());
    } else {
      user = await deps.store.getUser(id.userId);
    }
    if (!user) user = await deps.store.upsertUser({ userId: id.userId, email: id.email, name: id.name, picture: id.picture });
    c.set('user', user);
    await next();
  });

  app.get('/me', (c) => c.json({ user: c.get('user') }));

  // ---------- Tracks portal: public catalog ----------

  app.get('/catalog/tracks', async (c) => {
    const { store } = c.get('deps');
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    const mine = c.req.query('mine') === '1';
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 24)));
    const offset = Math.max(0, Number(c.req.query('cursor') ?? 0));
    const { items, total } = await store.listCatalog(q, offset, limit, mine ? c.get('user').userId : undefined);
    return c.json({ items, total, nextCursor: offset + items.length < total ? String(offset + items.length) : null });
  });

  app.get('/catalog/tracks/:id', async (c) => {
    const track = await c.get('deps').store.getCatalogTrack(c.req.param('id'));
    return track ? c.json({ track }) : err(c, 404, 'no_track', 'Track is not in the catalog');
  });

  app.post('/catalog/tracks', async (c) => {
    const body = (await c.req.json().catch(() => null)) as CatalogPublishRequest | null;
    if (!body?.trackId || !body.title || !body.driveFolderId || !body.trackJsonId || !body.audioId) return err(c, 400, 'bad_request', 'trackId, title, driveFolderId, trackJsonId and audioId are required');
    const user = c.get('user');
    const existing = await c.get('deps').store.getCatalogTrack(body.trackId);
    if (existing && existing.ownerUserId !== user.userId) return err(c, 409, 'not_owner', 'Another user owns this catalog entry');
    const now = new Date().toISOString();
    const track: CatalogTrack = {
      trackId: body.trackId,
      ownerUserId: user.userId,
      ownerName: user.name,
      title: String(body.title).slice(0, 120),
      artist: String(body.artist ?? '').slice(0, 120),
      genre: String(body.genre ?? '').slice(0, 60),
      language: String(body.language ?? '').slice(0, 60),
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      singerCount: Math.max(1, Math.min(10, Number(body.singerCount) || 1)),
      lineCount: Math.max(0, Number(body.lineCount) || 0),
      driveFolderId: body.driveFolderId,
      driveFolderLink: body.driveFolderLink || `https://drive.google.com/drive/folders/${body.driveFolderId}`,
      trackJsonId: body.trackJsonId,
      audioId: body.audioId,
      audioMime: body.audioMime || 'audio/mpeg',
      publishedAt: now,
      updatedAt: now,
      pulls: 0,
    };
    return c.json({ track: await c.get('deps').store.publishTrack(track) }, existing ? 200 : 201);
  });

  app.delete('/catalog/tracks/:id', async (c) => {
    const ok = await c.get('deps').store.unpublishTrack(c.req.param('id'), c.get('user').userId);
    return ok ? c.json({ ok: true as const }) : err(c, 404, 'no_track', 'Not in the catalog (or not yours)');
  });

  app.post('/catalog/tracks/:id/pull', async (c) => {
    const { store } = c.get('deps');
    const t = await store.getCatalogTrack(c.req.param('id'));
    if (!t) return err(c, 404, 'no_track', 'Track is not in the catalog');
    return c.json({ ok: true as const, pulls: await store.countPull(t.trackId) });
  });

  // ---------- Live Meets ----------

  async function snapshot(c: Context<Env>, meetId: string, you?: StoredParticipant, chatSince?: number): Promise<MeetSnapshot | null> {
    const { store } = c.get('deps');
    const meet = await store.getMeet(meetId);
    if (!meet) return null;
    ensureMeet(meet);
    let changed = tick(meet);
    const stored = await store.listParticipants(meetId);
    const rec = reconcile(meet, stored);
    changed = changed || rec.changed;
    if (changed) await store.saveMeet(meet);
    const participants: Participant[] = (rec.active as StoredParticipant[]).map(({ resumeToken: _t, meetId: _m, ...p }) => p);
    const chat = chatSince !== undefined ? await store.chatSince(meetId, chatSince) : await store.chatTail(meetId, 50);
    const [recordings, performances] = await Promise.all([store.listRecordings(meetId), store.listPerformancesForMeet(meetId)]);
    const youPublic: Participant | undefined = you ? (({ resumeToken: _t, meetId: _m, ...p }: StoredParticipant) => p)(you) : undefined;
    return { meet, participants, chat, recordings, performances, serverEpochMs: Date.now(), ...(youPublic ? { you: youPublic } : {}) };
  }

  async function participantFromBody(c: Context<Env>, meetId: string, token: string | undefined): Promise<StoredParticipant | null> {
    if (!token) return null;
    const p = await c.get('deps').store.getParticipantByToken(meetId, token);
    return p && p.userId === c.get('user').userId ? p : null;
  }

  app.get('/meets', async (c) => {
    const { store } = c.get('deps');
    const meets = await store.listMeetsForUser(c.get('user').userId);
    for (const m of meets) if (tick(m)) await store.saveMeet(m);
    return c.json({ meets });
  });

  app.post('/meets', async (c) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<CreateMeetRequest>;
    const user = c.get('user');
    // At most MAX_OPEN_MEETS open meets per host: end one (from the meets list) to open another.
    const mine = await c.get('deps').store.listMeetsForUser(user.userId, 100);
    const open = mine.filter((m) => m.hostUserId === user.userId && meetIsOpen(m) && Date.parse(m.expiresAt) > Date.now());
    if (open.length >= MAX_OPEN_MEETS) return err(c, 409, 'too_many_meets', `You already host ${open.length} open meets — end one to create another`);
    const meet = newMeet({
      title: String(body.title ?? ''),
      hostUserId: user.userId,
      hostName: user.name,
      trackId: body.trackId ?? null,
      trackTitle: String(body.trackTitle ?? '').slice(0, 120),
      catalogTrackId: body.catalogTrackId ?? null,
      backgroundId: String(body.backgroundId ?? 'mytestbg1'),
    });
    await c.get('deps').store.createMeet(meet);
    return c.json({ meet }, 201);
  });

  /** Host maintenance by account (no participant token): end an open meet; delete a meet for good. */
  app.post('/meets/:id/end', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (meet.hostUserId !== c.get('user').userId) return err(c, 403, 'not_host', 'Only the host can end the meet');
    ensureMeet(meet);
    tick(meet);
    if (meetIsOpen(meet)) {
      stop(meet);
      await store.saveMeet(meet);
      await store.clearSignals(meet.meetId).catch(() => undefined);
    }
    return c.json({ meet });
  });

  app.delete('/meets/:id', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (meet.hostUserId !== c.get('user').userId) return err(c, 403, 'not_host', 'Only the host can delete the meet');
    await store.deleteMeet(meet.meetId);
    return c.json({ ok: true as const });
  });

  app.get('/meets/code/:code', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeetByCode(c.req.param('code'));
    if (!meet) return err(c, 404, 'no_meet', 'No meet with that code');
    if (tick(meet)) await store.saveMeet(meet);
    return c.json({ meet });
  });

  app.get('/meets/:id', async (c) => {
    const { store } = c.get('deps');
    const you = await store.getParticipantByUser(c.req.param('id'), c.get('user').userId);
    const snap = await snapshot(c, c.req.param('id'), you ?? undefined);
    return snap ? c.json(snap) : err(c, 404, 'no_meet', 'Meet not found');
  });

  app.post('/meets/:id/join', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<JoinMeetRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    tick(meet);
    if (meet.state === 'expired') return err(c, 410, 'expired', 'This meet expired after 5 minutes without activity');
    if (meet.state === 'ended') return err(c, 410, 'ended', 'This meet has ended');
    const now = new Date().toISOString();
    const publisher = body.role === 'publisher';
    if (publisher && !user.privileged) return err(c, 403, 'not_privileged', 'Publishing mode is for privileged accounts');
    // A publisher's show view is its own participant: the same account may be performing on another device.
    let p = body.resumeToken ? await store.getParticipantByToken(meet.meetId, body.resumeToken) : null;
    // A member (host / performer / audience) is one per account; every publisher view (the show view,
    // each Preview tile) is its own participant, resumed by its token only, so an admin can monitor a
    // meet and run its show view at the same time without the two fighting over one video link.
    if (!p && !publisher) p = await store.getParticipantByUser(meet.meetId, user.userId, 'member');
    if (p && (p.userId !== user.userId || (publisher ? p.role !== 'publisher' : p.role === 'publisher'))) p = null;
    if (!p) {
      p = {
        meetId: meet.meetId,
        participantId: newId('p-'),
        userId: user.userId,
        displayName: user.name,
        picture: user.picture,
        role: publisher ? 'publisher' : user.userId === meet.hostUserId ? 'host' : 'audience',
        slot: null,
        stageRequest: 'none',
        joinedAt: now,
        lastSeenAt: now,
        resumeToken: newId('rt-'),
      };
    }
    p.lastSeenAt = now;
    // The host is on stage the moment their meet starts (first arrival), and anyone asking to join as a
    // performer is seated when the rules allow it (the host, or an open stage); everyone else is audience.
    const firstArrival = p.joinedAt === now;
    if ((body.role === 'performer' || (firstArrival && user.userId === meet.hostUserId)) && p.slot === null && p.role !== 'publisher') {
      const free = meet.stage.find((s) => !s.participantId);
      if (free) claimSlot(meet, p, free.slot);
    }
    touch(meet);
    await store.saveParticipant(p);
    if (!publisher) await store.addMember(meet.meetId, user.userId); // the shows of this meet are shared with everyone who was ever in it
    await store.saveMeet(meet);
    const snap = (await snapshot(c, meet.meetId, p))!;
    const { resumeToken: _t, meetId: _m, ...you } = p;
    return c.json({ meet: snap.meet, you, resumeToken: p.resumeToken, serverEpochMs: Date.now() });
  });

  app.post('/meets/:id/heartbeat', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<HeartbeatRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    p.lastSeenAt = new Date().toISOString();
    if (body.driftMs !== undefined || body.rttMs !== undefined) reportClock(meet, p, body.driftMs ?? null, body.rttMs ?? null);
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p, body.chatSince))!);
  });

  app.post('/meets/:id/slot', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<SlotRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    tick(meet);
    const r = claimSlot(meet, p, body.slot === null || body.slot === undefined ? null : Number(body.slot));
    if (!r.ok) {
      if (r.reason === 'ask_first') return err(c, 403, 'ask_first', 'Ask the host to sing — they let you on stage');
      return err(c, 409, r.reason ?? 'slot', r.reason === 'slot_taken' ? 'That stage slot is taken' : r.reason === 'song_in_progress' ? 'A song is running — you can step on stage once it is over' : r.reason === 'meet_closed' ? 'This meet has ended' : 'Cannot take that slot');
    }
    p.lastSeenAt = new Date().toISOString();
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  // ---- audience → singer: ask, and the host decides; the host also clears slots and sets the stage policy ----
  app.post('/meets/:id/requests', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    tick(meet);
    const r = requestStage(meet, p);
    if (!r.ok) return err(c, 409, r.reason ?? 'request', r.reason === 'on_stage' ? 'You are already on stage' : r.reason === 'open_stage' ? 'The stage is open — just take a slot' : r.reason === 'meet_closed' ? 'This meet has ended' : 'Cannot ask right now');
    p.lastSeenAt = new Date().toISOString();
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/requests/withdraw', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    withdrawRequest(meet, p);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/requests/:pid/decide', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<DecideRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host decides who sings');
    const target = await store.getParticipant(meet.meetId, c.req.param('pid'));
    if (!target || target.role === 'publisher') return err(c, 404, 'no_participant', 'They are no longer in the meet');
    tick(meet);
    const r = decideRequest(meet, target, Boolean(body.allow), body.slot === undefined ? undefined : Number(body.slot));
    if (!r.ok) return err(c, 409, r.reason ?? 'decide', r.reason === 'stage_full' ? 'The stage is full (10 singers)' : r.reason === 'slot_taken' ? 'That stage slot is taken' : r.reason === 'song_in_progress' ? 'A song is running — seat them once it is over' : 'Cannot seat them right now');
    touch(meet);
    await store.saveParticipant(target);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  app.post('/meets/:id/stage/:pid/remove', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host clears the stage');
    const target = await store.getParticipant(meet.meetId, c.req.param('pid'));
    if (!target) return err(c, 404, 'no_participant', 'They are no longer in the meet');
    claimSlot(meet, target, null);
    touch(meet);
    await store.saveParticipant(target);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  // ---- the set list: a karaoke event is many songs ----
  app.post('/meets/:id/songs', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; song?: Partial<SongPick>; now?: boolean };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    tick(meet);
    const song = body.song ?? {};
    const r = addSong(meet, p, { trackId: song.trackId ? String(song.trackId) : null, catalogTrackId: song.catalogTrackId ? String(song.catalogTrackId) : null, trackTitle: String(song.trackTitle ?? ''), durationMs: Number(song.durationMs ?? 0) }, Boolean(body.now));
    if (!r.ok) {
      if (r.reason === 'not_on_stage') return err(c, 403, 'not_on_stage', 'Step on stage (or host the meet) to pick songs');
      if (r.reason === 'not_host') return err(c, 403, 'not_host', 'Only the host plays a song right away — it was not added');
      if (r.reason === 'song_in_progress') return err(c, 409, 'song_in_progress', 'A song is in progress — it is added to the set list instead');
      return err(c, 400, r.reason ?? 'bad_song', r.reason === 'meet_closed' ? 'This meet has ended' : 'Pick a track with a title');
    }
    p.lastSeenAt = new Date().toISOString();
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/songs/next', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, p)) return err(c, 403, 'not_host', 'Only the host ends the song');
    tick(meet);
    const r = nextSong(meet);
    if (!r.ok) return err(c, 409, r.reason ?? 'song', 'This meet has ended');
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/songs/:sid', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; action?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (body.action !== 'remove' && body.action !== 'up' && body.action !== 'now') return err(c, 400, 'bad_action', 'action must be remove, up or now');
    tick(meet);
    const r = songAction(meet, p, c.req.param('sid'), body.action);
    if (!r.ok) {
      if (r.reason === 'not_host') return err(c, 403, 'not_host', 'Only the host orders the set list');
      if (r.reason === 'no_song') return err(c, 404, 'no_song', 'That song is no longer on the set list');
      if (r.reason === 'song_in_progress') return err(c, 409, 'song_in_progress', 'A song is in progress');
      return err(c, 409, r.reason ?? 'song', 'This meet has ended');
    }
    touch(meet);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/policy', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; stagePolicy?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    ensureMeet(meet);
    const host = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!host) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, host)) return err(c, 403, 'not_host', 'Only the host sets who may step on stage');
    if (body.stagePolicy !== 'ask' && body.stagePolicy !== 'open') return err(c, 400, 'bad_policy', 'stagePolicy must be ask or open');
    setStagePolicy(meet, body.stagePolicy);
    touch(meet);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, host))!);
  });

  app.post('/meets/:id/ready', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<ReadyRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    setReady(meet, p, Boolean(body.ready));
    touch(meet);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/chat', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<ChatRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    const text = String(body.text ?? '').trim().slice(0, 500);
    if (!text) return err(c, 400, 'empty', 'Say something');
    const message: Omit<ChatMessage, 'seq'> = { id: newId('msg-'), meetId: meet.meetId, participantId: p.participantId, displayName: p.displayName, text, sentAt: new Date().toISOString() };
    const saved = await store.addChat(meet.meetId, message);
    touch(meet);
    await store.saveMeet(meet);
    return c.json({ message: saved }, 201);
  });

  app.post('/meets/:id/start', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<StartMeetRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, p)) return err(c, 403, 'not_host', 'Only the host can start the song');
    tick(meet);
    const r = start(meet, Number(body.leadMs ?? 5000));
    if (!r.ok) return err(c, 409, r.reason ?? 'start', r.reason === 'no_performers' ? 'Nobody is on stage yet' : r.reason === 'no_song' ? 'Pick a song first (set list)' : 'The meet is not in the lobby');
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  app.post('/meets/:id/stop', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!isHost(meet, p)) return err(c, 403, 'not_host', 'Only the host can end the meet');
    stop(meet);
    await store.saveMeet(meet);
    await store.clearSignals(meet.meetId).catch(() => undefined);
    return c.json((await snapshot(c, meet.meetId, p))!);
  });

  /**
   * Transport — pause freezes the shared position at a cued instant; resume / seek / restart cue a new
   * kickstart, so every device moves together whoever asked. The host and any singer on stage may
   * pause, resume, seek and restart (from the top) — a singer who fluffed the first line starts over for the stage.
   */
  for (const action of ['pause', 'resume', 'restart', 'seek'] as const) {
    app.post(`/meets/:id/${action}`, async (c) => {
      const { store } = c.get('deps');
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; leadMs?: number; fromMs?: number; toMs?: number };
      const meet = await store.getMeet(c.req.param('id'));
      if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
      const p = await participantFromBody(c, meet.meetId, body.resumeToken);
      if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
      if (!canTransport(meet, p)) return err(c, 403, 'not_host', 'Only the singers on stage control the song');
      ensureMeet(meet);
      tick(meet);
      const r =
        action === 'pause'
          ? pause(meet, Date.now(), Number(body.leadMs ?? 3000))
          : action === 'resume'
            ? resume(meet, Number(body.leadMs ?? 4000))
            : action === 'seek'
              ? seek(meet, Number(body.leadMs ?? 3000), Number(body.toMs ?? 0))
              : resume(meet, Number(body.leadMs ?? 3000), Date.now(), Math.max(0, Number(body.fromMs ?? 0)));
      if (!r.ok) return err(c, 409, r.reason ?? action, r.reason === 'not_started' ? 'Start the song first' : r.reason === 'already_playing' ? 'The song is already playing' : r.reason === 'pausing' ? 'A pause is on its way — seek once it landed' : 'The song is not playing');
      await store.saveMeet(meet);
      return c.json((await snapshot(c, meet.meetId, p))!);
    });
  }

  /** Relay one WebRTC signal to another performer of the same meet. */
  app.post('/meets/:id/signal', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<SignalRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!meetIsOpen(meet)) return err(c, 410, 'meet_closed', 'This meet has ended');
    // Performer video is private to the stage: only performers and a publisher's show view may signal.
    if (p.slot === null && p.role !== 'publisher') return err(c, 403, 'not_on_stage', 'Only performers and the publisher exchange video');
    const to = String(body.to ?? '');
    const type = body.type;
    const data = typeof body.data === 'string' ? body.data : JSON.stringify(body.data ?? null);
    if (!to || !type || !['offer', 'answer', 'ice', 'bye'].includes(type)) return err(c, 400, 'bad_signal', 'to, type and data are required');
    if (data.length > 64_000) return err(c, 400, 'bad_signal', 'Signal too large');
    // They left (a publisher view closed, a singer gone): nothing to deliver, nothing to shout about.
    if (!(await store.getParticipant(meet.meetId, to))) return c.json({ seq: 0, gone: true });
    const sig = await store.addSignal(meet.meetId, { meetId: meet.meetId, from: p.participantId, to, type, data, sentAt: new Date().toISOString() });
    return c.json({ seq: sig.seq });
  });

  /** Signals addressed to me since `since` (polled while on stage). */
  app.post('/meets/:id/signals', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; since?: number };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (p.slot === null && p.role !== 'publisher') return err(c, 403, 'not_on_stage', 'Only performers and the publisher exchange video');
    const signals = await store.signalsFor(meet.meetId, p.participantId, Number(body.since ?? 0));
    return c.json({ signals, serverEpochMs: Date.now() });
  });

  /** ICE servers for performer-to-performer video (STUN by default; TURN when the deployment sets ICE_SERVERS). */
  app.get('/ice', (c) => c.json({ iceServers: c.get('deps').iceServers ?? DEFAULT_ICE_SERVERS }));

  app.post('/meets/:id/leave', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string };
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return c.json({ ok: true as const });
    claimSlot(meet, p, null);
    await store.removeParticipant(meet.meetId, p.participantId);
    reconcile(meet, (await store.listParticipants(meet.meetId)).map((x) => x));
    await store.saveMeet(meet);
    return c.json({ ok: true as const });
  });

  // Takes save themselves in the background, after the song — by then the singer may have left the room
  // (or the meet may be over), so a take is registered by account: anyone who was ever in the meet.
  app.post('/meets/:id/recordings', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<RegisterRecordingRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p && !(await store.listMembers(meet.meetId)).some((m) => m.userId === user.userId)) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!body.performanceId) return err(c, 400, 'bad_request', 'performanceId is required');
    const recording = {
      meetId: meet.meetId,
      participantId: p?.participantId ?? '',
      userId: user.userId,
      displayName: p?.displayName ?? user.name,
      slot: p?.slot ?? (typeof body.slot === 'number' ? Math.max(1, Math.min(10, body.slot)) : null),
      performanceId: String(body.performanceId),
      driveFolderLink: body.driveFolderLink ?? null,
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      createdAt: new Date().toISOString(),
    };
    await store.addRecording(recording);
    return c.json({ recording }, 201);
  });

  // The saved show of a song: recorded on the host's device, kept in the host's Drive, shared with everyone in the meet.
  app.post('/meets/:id/performances', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<RegisterPerformanceRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const user = c.get('user');
    if (user.userId !== meet.hostUserId) return err(c, 403, 'not_host', 'Only the host registers the saved show'); // by account: the upload may finish after the host left the room
    if (!body.performanceId) return err(c, 400, 'bad_request', 'performanceId is required');
    const singers = Array.isArray(body.singers) ? body.singers.slice(0, 10).map((s) => ({ slot: Math.max(1, Math.min(10, Number(s?.slot) || 1)), displayName: String(s?.displayName ?? '').slice(0, 60), ...(s?.userId ? { userId: String(s.userId) } : {}) })) : [];
    const performance: MeetPerformance = {
      performanceId: String(body.performanceId),
      meetId: meet.meetId,
      meetTitle: meet.title,
      hostUserId: user.userId,
      hostName: user.name,
      songTitle: String(body.songTitle ?? meet.trackTitle ?? '').slice(0, 120),
      trackId: String(body.trackId ?? ''),
      singers,
      link: body.link ? String(body.link) : null,
      videoLink: body.videoLink ? String(body.videoLink) : null,
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      bytes: Math.max(0, Number(body.bytes) || 0),
      mimeType: String(body.mimeType ?? '').slice(0, 80),
      createdAt: new Date().toISOString(),
    };
    await store.addPerformance(performance);
    touch(meet);
    await store.saveMeet(meet);
    const members = await store.listMembers(meet.meetId);
    const shareWith = members.filter((m) => m.userId !== user.userId && m.email && !m.email.endsWith('.local')).map((m) => m.email);
    return c.json({ performance, shareWith }, 201);
  });

  // The stage mix for the audience: the host's device posts a second at a time; everyone else fetches what is new.
  app.post('/meets/:id/mix', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    if (user.userId !== meet.hostUserId) return err(c, 403, 'not_host', "Only the host's device sends the stage mix");
    const body = ((await c.req.json().catch(() => null)) ?? null) as (Partial<MixBatch> & { resumeToken?: string }) | null;
    if (!body || typeof body.seq !== 'number' || !Array.isArray(body.packets)) return err(c, 400, 'bad_request', 'A mix batch needs seq and packets');
    if (body.packets.length > 120 || JSON.stringify(body.packets).length > 200_000) return err(c, 400, 'too_big', 'A mix batch is a second of audio, not more');
    const batch: MixBatch = {
      seq: Math.max(0, Math.floor(body.seq)),
      atMs: Math.max(0, Number(body.atMs) || 0),
      codec: 'opus',
      sampleRate: Number(body.sampleRate) || 48000,
      channels: Math.max(1, Math.min(2, Number(body.channels) || 1)),
      packets: body.packets.map((p) => ({ ts: Number(p?.ts) || 0, b64: String(p?.b64 ?? '') })),
      serverEpochMs: Date.now(),
    };
    await store.addMix(meet.meetId, batch);
    return c.json({ ok: true as const, seq: batch.seq });
  });
  app.get('/meets/:id/mix', async (c) => {
    const { store } = c.get('deps');
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const since = Math.max(0, Number(c.req.query('since')) || 0);
    const r = await store.listMix(meet.meetId, since);
    return c.json({ ...r, serverEpochMs: Date.now() });
  });

  app.get('/performances', async (c) => {
    const performances = await c.get('deps').store.listPerformancesForUser(c.get('user').userId);
    return c.json({ performances });
  });

  app.delete('/performances/:id', async (c) => {
    const { store } = c.get('deps');
    const p = await store.getPerformance(c.req.param('id'));
    if (!p) return c.json({ ok: true as const });
    if (p.hostUserId !== c.get('user').userId) return err(c, 403, 'not_host', 'Only the host can remove a saved show');
    await store.deletePerformance(p.performanceId);
    return c.json({ ok: true as const });
  });

  // ---------- Publishing mode (privileged) ----------

  app.use('/publishing/*', async (c, next) => {
    if (!c.get('user').privileged) return err(c, 403, 'not_privileged', 'Publishing is available to privileged users only — ask an admin to enable it for your account');
    await next();
  });

  app.get('/publishing/destinations', async (c) => {
    const { store } = c.get('deps');
    const stored = await store.listDestinations(c.get('user').userId);
    const destinations: Destination[] = DESTINATIONS.map((d) => {
      const s = stored.find((x) => x.kind === d.kind);
      // The in-house portal needs no key and is always available; the others are off until configured.
      return s ? (({ keyEnc: _k, ...pub }) => pub)(s) : { kind: d.kind, label: d.label, enabled: !d.needsKey, ingestUrl: d.needsKey ? d.ingestHint : '', keyHint: '', updatedAt: '' };
    });
    return c.json({ destinations });
  });

  app.put('/publishing/destinations/:kind', async (c) => {
    const { store, secrets } = c.get('deps');
    const kind = c.req.param('kind') as DestinationKind;
    const def = DESTINATIONS.find((d) => d.kind === kind);
    if (!def) return err(c, 404, 'no_destination', 'Unknown destination');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<DestinationUpdate>;
    const user = c.get('user');
    const existing = await store.getDestination(user.userId, kind);
    const streamKey = typeof body.streamKey === 'string' ? body.streamKey.trim() : undefined;
    const keyEnc = streamKey ? await secrets.seal(streamKey) : (existing?.keyEnc ?? '');
    const keyHint = streamKey ? `…${streamKey.slice(-4)}` : (existing?.keyHint ?? '');
    if (body.enabled && def.needsKey && !keyEnc) return err(c, 400, 'missing_key', `${def.label} needs a stream key before it can be enabled`);
    const dest = {
      kind,
      label: String(body.label ?? existing?.label ?? def.label).slice(0, 60),
      enabled: Boolean(body.enabled),
      ingestUrl: String(body.ingestUrl ?? existing?.ingestUrl ?? (def.needsKey ? def.ingestHint : '')).slice(0, 300),
      keyHint,
      updatedAt: new Date().toISOString(),
      keyEnc,
    };
    await store.saveDestination(user.userId, dest);
    const { keyEnc: _k, ...destination } = dest;
    return c.json({ destination });
  });

  app.get('/publishing/jobs', async (c) => {
    const jobs = await c.get('deps').store.listJobs(c.get('user').userId, c.req.query('meetId') || undefined);
    return c.json({ jobs });
  });

  app.post('/publishing/jobs', async (c) => {
    const { store } = c.get('deps');
    const user = c.get('user');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<PublishJobRequest>;
    if (!body.meetId) return err(c, 400, 'bad_request', 'meetId is required');
    const meet = await store.getMeet(body.meetId);
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    // The host, or a privileged account that joined the meet (its Publishing show view), may publish it.
    if (meet.hostUserId !== user.userId && !(await store.getParticipantByUser(meet.meetId, user.userId, 'any'))) return err(c, 403, 'not_in_meet', 'Join the meet (or host it) to publish it');
    const wanted = (Array.isArray(body.destinations) ? body.destinations : []).filter((k): k is DestinationKind => DESTINATIONS.some((d) => d.kind === k));
    if (!wanted.length) return err(c, 400, 'no_destinations', 'Pick at least one destination');
    const stored = await store.listDestinations(user.userId);
    const enabled = DESTINATIONS.filter((d) => {
      const s = stored.find((x) => x.kind === d.kind);
      return s ? s.enabled : !d.needsKey;
    }).map((d) => d.kind);
    const missing = wanted.filter((k) => !enabled.includes(k));
    if (missing.length) return err(c, 400, 'destination_disabled', `Enable first: ${missing.join(', ')}`);
    if ((await store.liveJobsForMeet(meet.meetId)).length) return err(c, 409, 'already_publishing', 'A publish job is already running for this meet');
    const now = new Date().toISOString();
    const browserFed = wanted.filter((k) => DESTINATIONS.find((d) => d.kind === k)?.browserLive);
    const job: PublishJob = {
      jobId: newId('pub-'),
      meetId: meet.meetId,
      meetTitle: meet.title,
      ownerUserId: user.userId,
      destinations: wanted,
      title: String(body.title ?? meet.title).slice(0, 120),
      description: String(body.description ?? '').slice(0, 2000),
      state: 'requested',
      watchUrl: wanted.includes('inhouse') ? `/watch/${meet.meetId}` : null,
      error: null,
      createdAt: now,
      updatedAt: now,
      events: [{ at: now, state: 'requested', note: browserFed.length ? `Waiting for the show view to send the first segment (${browserFed.join(', ')})` : 'Queued — a session container picks this up when the meet goes live' }],
      live: { segments: 0, bytes: 0, lastSegmentAt: null, youtube: wanted.includes('youtube') ? 'waiting' : 'off', youtubeNote: '' },
    };
    await store.saveJob(job);
    return c.json({ job }, 201);
  });

  app.post('/publishing/jobs/:id/stop', async (c) => {
    const { store } = c.get('deps');
    const job = await store.getJob(c.req.param('id'));
    if (!job || job.ownerUserId !== c.get('user').userId) return err(c, 404, 'no_job', 'Job not found');
    const now = new Date().toISOString();
    if (job.state !== 'stopped' && job.state !== 'failed') {
      job.state = 'stopped';
      job.updatedAt = now;
      job.events.push({ at: now, state: 'stopped', note: 'Stopped by the publisher' });
      await store.saveJob(job);
    }
    await store.clearLiveSegments(job.jobId);
    return c.json({ job });
  });

  // One segment of the show from the publisher's browser: kept for the portal, forwarded to YouTube.
  app.put('/publishing/jobs/:id/live/:name', async (c) => {
    const { store, secrets, youtubeHlsBase } = c.get('deps');
    const job = await store.getJob(c.req.param('id'));
    if (!job || job.ownerUserId !== c.get('user').userId) return err(c, 404, 'no_job', 'Job not found');
    if (job.state === 'stopped' || job.state === 'failed' || job.state === 'stopping') return err(c, 409, 'not_live', `This broadcast is ${job.state}`);
    const name = c.req.param('name');
    if (!SEGMENT_NAME.test(name)) return err(c, 400, 'bad_name', 'Segment names are letters, digits, - and _, ending in .ts');
    const seq = Math.floor(Number(c.req.query('seq')));
    const durationMs = Math.round(Number(c.req.query('dur')));
    if (!Number.isFinite(seq) || seq < 0 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10_000) return err(c, 400, 'bad_request', 'seq and dur (ms, up to 10000) are required');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > 6_000_000) return err(c, 400, 'too_big', 'A segment is a couple of seconds of video (up to 6 MB)');
    if (bytes[0] !== 0x47) return err(c, 400, 'not_ts', 'Not an MPEG-TS segment');
    const now = new Date().toISOString();
    const info: LiveSegmentInfo = { seq, name, durationMs, createdAt: now };
    await store.addLiveSegment(job.jobId, info, bytes);
    const live: PublishJobLive = job.live ?? { segments: 0, bytes: 0, lastSegmentAt: null, youtube: job.destinations.includes('youtube') ? 'waiting' : 'off', youtubeNote: '' };
    live.segments += 1;
    live.bytes += bytes.length;
    live.lastSegmentAt = now;
    live.audio = c.req.query('audio') !== '0';
    let youtube: { status: number } | null = null;
    if (job.destinations.includes('youtube')) {
      const dest = await store.getDestination(job.ownerUserId, 'youtube');
      const key = dest?.keyEnc ? await secrets.open(dest.keyEnc).catch(() => '') : '';
      if (!key) {
        live.youtube = 'rejected';
        live.youtubeNote = 'No YouTube stream key is saved';
      } else {
        const window = youtubeWindow(await store.listLiveSegments(job.jobId));
        const playlist = hlsPlaylist(window, (n) => n);
        const r = await sendToYoutube(youtubeHlsBase || YOUTUBE_HLS_INGEST, key, { name, bytes }, playlist);
        youtube = { status: r.status };
        live.youtube = r.status === 200 || r.status === 202 ? (r.playlistStatus === 200 || r.playlistStatus === 202 ? 'ok' : 'error') : r.status === 401 || r.status === 400 ? 'rejected' : 'error';
        live.youtubeNote = r.note;
        if (r.status === 401) {
          job.error = r.note;
        } else if (live.youtube === 'ok') job.error = null;
      }
    }
    job.live = live;
    if (job.state !== 'live') {
      job.state = 'live';
      job.events.push({ at: now, state: 'live', note: `On air — the show view is sending${job.destinations.includes('youtube') ? ` (YouTube: ${live.youtubeNote})` : ''}` });
    }
    job.updatedAt = now;
    await store.saveJob(job);
    return c.json({ job, youtube });
  });

  app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));
  app.onError((e, c) => {
    console.error('sv-control error', e);
    return c.json({ error: e.message || 'Internal error', code: 'internal' }, 500);
  });

  return app;
}

/** Periodic sweep: expire idle meets even when nobody is polling them. */
export async function sweepMeets(store: SqlStore): Promise<number> {
  let n = 0;
  for (const m of await store.listOpenMeets()) {
    ensureMeet(m);
    if (tick(m)) {
      await store.saveMeet(m);
      if (!meetIsOpen(m)) await store.clearSignals(m.meetId).catch(() => undefined);
      n++;
    }
  }
  return n;
}
