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
  type RegisterRecordingRequest,
  type SignalRequest,
  type SlotRequest,
  type StartMeetRequest,
  type UserRecord,
} from '@singersvoice/protocol';
import type { Authenticator } from './auth.ts';
import type { SecretBox } from './crypto.ts';
import { claimSlot, ensurePlayback, isHost, newMeet, pause, reconcile, reportClock, resume, setReady, start, stop, tick, touch } from './meets.ts';
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
}

type Vars = { deps: AppDeps; user: UserRecord };
type Env = { Bindings: Record<string, unknown>; Variables: Vars };

const DEFAULT_ORIGINS = ['https://singersvoice.github.io', 'http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];

function err(c: Context<Env>, status: 400 | 401 | 403 | 404 | 409 | 410, code: string, message: string) {
  return c.json({ error: message, code }, status);
}

const userTouch = new Map<string, number>();

export function createApp(getDeps: (env: Record<string, unknown>) => Promise<AppDeps> | AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const deps = await getDeps(c.env ?? {});
    c.set('deps', deps);
    await deps.store.migrate();
    await next();
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

  // ---------- auth ----------

  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/health' || path === '/time' || path.startsWith('/watch/') || c.req.method === 'OPTIONS') return next();
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
    ensurePlayback(meet);
    let changed = tick(meet);
    const stored = await store.listParticipants(meetId);
    const rec = reconcile(meet, stored);
    changed = changed || rec.changed;
    if (changed) await store.saveMeet(meet);
    const participants: Participant[] = (rec.active as StoredParticipant[]).map(({ resumeToken: _t, meetId: _m, ...p }) => p);
    const chat = chatSince !== undefined ? await store.chatSince(meetId, chatSince) : await store.chatTail(meetId, 50);
    const recordings = await store.listRecordings(meetId);
    const youPublic: Participant | undefined = you ? (({ resumeToken: _t, meetId: _m, ...p }: StoredParticipant) => p)(you) : undefined;
    return { meet, participants, chat, recordings, serverEpochMs: Date.now(), ...(youPublic ? { you: youPublic } : {}) };
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
    let p = (body.resumeToken ? await store.getParticipantByToken(meet.meetId, body.resumeToken) : null) ?? (await store.getParticipantByUser(meet.meetId, user.userId));
    if (p && p.userId !== user.userId) p = null;
    if (!p) {
      p = {
        meetId: meet.meetId,
        participantId: newId('p-'),
        userId: user.userId,
        displayName: user.name,
        picture: user.picture,
        role: user.userId === meet.hostUserId ? 'host' : 'audience',
        slot: null,
        joinedAt: now,
        lastSeenAt: now,
        resumeToken: newId('rt-'),
      };
    }
    p.lastSeenAt = now;
    if (body.role === 'performer' && p.slot === null) {
      const free = meet.stage.find((s) => !s.participantId);
      if (free) claimSlot(meet, p, free.slot);
    }
    touch(meet);
    await store.saveParticipant(p);
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
    if (!r.ok) return err(c, 409, r.reason ?? 'slot', r.reason === 'slot_taken' ? 'That stage slot is taken' : r.reason === 'already_live' ? 'The song already started' : 'Cannot take that slot');
    p.lastSeenAt = new Date().toISOString();
    touch(meet);
    await store.saveParticipant(p);
    await store.saveMeet(meet);
    return c.json((await snapshot(c, meet.meetId, p))!);
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
    if (!r.ok) return err(c, 409, r.reason ?? 'start', r.reason === 'no_performers' ? 'Nobody is on stage yet' : 'The meet is not in the lobby');
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

  /** Host transport controls — pause freezes the shared position; resume/restart cue a new kickstart. */
  for (const action of ['pause', 'resume', 'restart'] as const) {
    app.post(`/meets/:id/${action}`, async (c) => {
      const { store } = c.get('deps');
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { resumeToken?: string; leadMs?: number; fromMs?: number };
      const meet = await store.getMeet(c.req.param('id'));
      if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
      const p = await participantFromBody(c, meet.meetId, body.resumeToken);
      if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
      if (!isHost(meet, p)) return err(c, 403, 'not_host', 'Only the host controls playback');
      ensurePlayback(meet);
      tick(meet);
      const r =
        action === 'pause'
          ? pause(meet, Date.now(), Number(body.leadMs ?? 3000))
          : action === 'resume'
            ? resume(meet, Number(body.leadMs ?? 4000))
            : resume(meet, Number(body.leadMs ?? 5000), Date.now(), Math.max(0, Number(body.fromMs ?? 0)));
      if (!r.ok) return err(c, 409, r.reason ?? action, r.reason === 'not_started' ? 'Start the song first' : r.reason === 'already_playing' ? 'The song is already playing' : 'The song is not playing');
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
    const to = String(body.to ?? '');
    const type = body.type;
    const data = typeof body.data === 'string' ? body.data : JSON.stringify(body.data ?? null);
    if (!to || !type || !['offer', 'answer', 'ice', 'bye'].includes(type)) return err(c, 400, 'bad_signal', 'to, type and data are required');
    if (data.length > 64_000) return err(c, 400, 'bad_signal', 'Signal too large');
    if (!(await store.getParticipant(meet.meetId, to))) return err(c, 404, 'no_peer', 'That performer is not in the meet');
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

  app.post('/meets/:id/recordings', async (c) => {
    const { store } = c.get('deps');
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<RegisterRecordingRequest>;
    const meet = await store.getMeet(c.req.param('id'));
    if (!meet) return err(c, 404, 'no_meet', 'Meet not found');
    const p = await participantFromBody(c, meet.meetId, body.resumeToken);
    if (!p) return err(c, 403, 'not_participant', 'Join the meet first');
    if (!body.performanceId) return err(c, 400, 'bad_request', 'performanceId is required');
    const recording = {
      meetId: meet.meetId,
      participantId: p.participantId,
      userId: p.userId,
      displayName: p.displayName,
      slot: p.slot,
      performanceId: String(body.performanceId),
      driveFolderLink: body.driveFolderLink ?? null,
      durationMs: Math.max(0, Number(body.durationMs) || 0),
      createdAt: new Date().toISOString(),
    };
    await store.addRecording(recording);
    return c.json({ recording }, 201);
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
    if (meet.hostUserId !== user.userId) return err(c, 403, 'not_host', 'Only the meet host can publish it');
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
      events: [{ at: now, state: 'requested', note: 'Queued — a session container picks this up when the meet goes live' }],
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
      job.events.push({ at: now, state: 'stopped', note: 'Stopped by the host' });
      await store.saveJob(job);
    }
    return c.json({ job });
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
    ensurePlayback(m);
    if (tick(m)) {
      await store.saveMeet(m);
      if (!meetIsOpen(m)) await store.clearSignals(m.meetId).catch(() => undefined);
      n++;
    }
  }
  return n;
}
