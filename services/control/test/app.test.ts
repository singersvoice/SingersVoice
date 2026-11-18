import { beforeAll, describe, expect, it } from 'vitest';
import type { CatalogListResponse, ClubOwnerOverview, ClubOwnerSettings, ClubOwnerStatus, JoinMeetResponse, Meet, MeetSnapshot } from '@singersvoice/protocol';
import { LIVE_KEEP } from '@singersvoice/protocol';
import { createApp, type AppDeps } from '../src/app.ts';
import { edgeCacheControl, edgeCacheTtl } from '../src/worker.ts';
import { resetPriceCache, signStripePayload } from '../src/billing.ts';
import { createAuthenticator } from '../src/auth.ts';
import { SecretBox } from '../src/crypto.ts';
import { nodeSqliteDriver } from '../src/store/driver.ts';
import { openNodeSqlite } from '../src/store/node-sqlite.ts';
import { SqlStore } from '../src/store/sql.ts';

let app: ReturnType<typeof createApp>;
let deps: AppDeps;
/** Work the service finishes after an answer (YouTube's PUTs): collected here, awaited by the tests that care. */
let pending: Promise<unknown>[] = [];
const drain = async () => {
  const work = pending;
  pending = [];
  await Promise.all(work);
};

beforeAll(async () => {
  const db = await openNodeSqlite(':memory:');
  deps = {
    store: new SqlStore(nodeSqliteDriver(db)),
    auth: createAuthenticator({ devAuth: true }),
    secrets: new SecretBox(''),
    runtime: 'node',
    allowedOrigins: [],
    privilegedEmails: [],
    version: 'test',
    background: (p) => void pending.push(p),
  };
  app = createApp(() => deps);
});

const as = (user: string) => ({ 'X-Dev-User': user, 'X-Dev-Name': user, 'Content-Type': 'application/json' });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe('sv-control API', () => {
  it("the public watch portal answers every origin and is what the edge caches; everything signed-in is not", async () => {
    const r = await app.request('/watch/nope/live', { headers: { Origin: 'https://some.viewer.example' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const me = await app.request('/me', { headers: { ...as('alice'), Origin: 'https://some.viewer.example' } });
    expect(me.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(edgeCacheTtl('GET', '/watch/m1/live/svabc-12.ts')).toBe(120); // a segment never changes
    expect(edgeCacheTtl('GET', '/watch/m1/live.m3u8')).toBe(1);
    expect(edgeCacheTtl('GET', '/watch/m1/live')).toBe(2);
    expect(edgeCacheTtl('GET', '/watch/m1/mix')).toBe(1);
    expect(edgeCacheTtl('GET', '/watch/m1')).toBe(2);
    expect(edgeCacheTtl('GET', '/meets/m1')).toBe(0); // signed-in, per user
    expect(edgeCacheTtl('PUT', '/watch/m1/live/sv-1.ts')).toBe(0);
    expect(edgeCacheTtl('GET', '/time')).toBe(0); // the clock is never stale
    expect(edgeCacheControl('/watch/m1/live/svabc-12.ts', 120)).toBe('public, max-age=120, s-maxage=120'); // the browser may keep a segment
    expect(edgeCacheControl('/watch/m1/mix', 1)).toBe('public, max-age=0, s-maxage=1'); // a poll always reaches the edge
  });

  it("the app's browser may PATCH (the Admin page changes a role or a subscription that way): the preflight allows it", async () => {
    const pre = await app.request('/admin/users/u1', { method: 'OPTIONS', headers: { Origin: 'https://singersvoice.github.io', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type,x-dev-user' } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get('access-control-allow-methods') ?? '').toMatch(/PATCH/);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://singersvoice.github.io');
  });

  it('health and time are public; everything else needs sign-in', async () => {
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/me')).status).toBe(401);
    const me = await json<{ user: { privileged: boolean; name: string } }>(await app.request('/me', { headers: as('alice') }));
    expect(me.user.name).toBe('alice');
    expect(me.user.privileged).toBe(true); // first account bootstraps as privileged
    const bob = await json<{ user: { privileged: boolean } }>(await app.request('/me', { headers: as('bob') }));
    expect(bob.user.privileged).toBe(false);
  });

  it('catalog: publish, list/search, pull count, only the owner can unpublish', async () => {
    const body = { trackId: 'trk-1', title: 'Amma', artist: 'SV', genre: 'Telugu', language: 'Telugu', durationMs: 283000, singerCount: 5, lineCount: 67, driveFolderId: 'f1', driveFolderLink: '', trackJsonId: 'j1', audioId: 'a1', audioMime: 'audio/mpeg' };
    const r = await app.request('/catalog/tracks', { method: 'POST', headers: as('alice'), body: JSON.stringify(body) });
    expect(r.status).toBe(201);
    const list = await json<CatalogListResponse>(await app.request('/catalog/tracks?q=amma', { headers: as('bob') }));
    expect(list.total).toBe(1);
    expect(list.items[0]!.driveFolderLink).toContain('f1');
    const pull = await json<{ pulls: number }>(await app.request('/catalog/tracks/trk-1/pull', { method: 'POST', headers: as('bob') }));
    expect(pull.pulls).toBe(1);
    expect((await app.request('/catalog/tracks/trk-1', { method: 'DELETE', headers: as('bob') })).status).toBe(404);
    expect((await app.request('/catalog/tracks/trk-1', { method: 'DELETE', headers: as('alice') })).status).toBe(200);
  });

  it("catalog: the service fetches a published track's files from the owner's Drive for another account (no key, no CORS)", async () => {
    const body = { trackId: 'trk-2', title: 'Ammo', artist: 'SV', genre: 'Telugu', language: 'Telugu', durationMs: 283000, singerCount: 5, lineCount: 67, driveFolderId: 'f2', driveFolderLink: '', trackJsonId: 'json0000000002', audioId: 'audio000000002', audioMime: 'audio/mpeg' };
    expect((await app.request('/catalog/tracks', { method: 'POST', headers: as('alice'), body: JSON.stringify(body) })).status).toBe(201);
    // Drive as seen anonymously: the first endpoint answers with its HTML "cannot download" page, the next with the file.
    const asked: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.includes('drive.usercontent.google.com') && url.includes('json0000000002')) return new Response('<html>virus scan</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (url.includes('json0000000002')) return new Response(JSON.stringify({ trackId: 'trk-2', title: 'Ammo' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('audio000000002')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '3' } });
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    deps.fetchImpl = fetchImpl;
    const j = await app.request('/catalog/tracks/trk-2/file/json', { headers: as('bob') });
    expect(j.status).toBe(200);
    expect(j.headers.get('content-type')).toBe('application/json');
    expect((await j.json()).title).toBe('Ammo');
    expect(asked.filter((u) => u.includes('json0000000002'))).toHaveLength(2); // the HTML answer was not taken for the file
    const a = await app.request('/catalog/tracks/trk-2/file/audio', { headers: as('bob') });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await app.request('/catalog/tracks/trk-2/file/video', { headers: as('bob') })).status).toBe(404); // this track has no video
    expect((await app.request('/catalog/tracks/trk-2/file/other', { headers: as('bob') })).status).toBe(400);
    expect((await app.request('/catalog/tracks/trk-none/file/json', { headers: as('bob') })).status).toBe(404);
    // A YouTube song track publishes its video too; another account's device gets it the same way.
    const withVideo = { ...body, trackId: 'trk-3', title: 'Karaoke one', videoId: 'video000000003', videoMime: 'video/mp4' };
    expect((await app.request('/catalog/tracks', { method: 'POST', headers: as('alice'), body: JSON.stringify(withVideo) })).status).toBe(201);
    const listed = await json<{ track: { videoId?: string; videoMime?: string } }>(await app.request('/catalog/tracks/trk-3', { headers: as('bob') }));
    expect(listed.track.videoId).toBe('video000000003');
    expect(listed.track.videoMime).toBe('video/mp4');
    deps.fetchImpl = (async (input: RequestInfo | URL) => (String(input).includes('video000000003') ? new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '2' } }) : new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }))) as typeof fetch;
    const v = await app.request('/catalog/tracks/trk-3/file/video', { headers: as('bob') });
    expect(v.status).toBe(200);
    expect(v.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await v.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    expect((await app.request('/catalog/tracks/trk-3', { method: 'DELETE', headers: as('alice') })).status).toBe(200);
    deps.fetchImpl = fetchImpl;
    // With an API key the service asks the Drive API first.
    deps.googleApiKey = 'k';
    asked.length = 0;
    await app.request('/catalog/tracks/trk-2/file/audio', { headers: as('bob') });
    expect(asked[0]).toContain('www.googleapis.com/drive/v3/files/audio000000002?alt=media&key=k');
    deps.googleApiKey = undefined;
    deps.fetchImpl = undefined;
  });

  it('meets: create → join by code → slots → chat → kickstart → recordings → stop', async () => {
    const created = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Sunday meet' }) }));
    const meet = created.meet;
    expect(meet.joinCode).toHaveLength(6);
    const byCode = await json<{ meet: Meet }>(await app.request(`/meets/code/${meet.joinCode.toLowerCase()}`, { headers: as('bob') }));
    expect(byCode.meet.meetId).toBe(meet.meetId);

    // The host is on stage the moment the meet starts (plain join, no slot asked for); guests arrive as audience.
    const host = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'audience' }) }));
    expect(host.you.role).toBe('performer');
    expect(host.you.slot).toBe(1);
    const bob = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ role: 'audience' }) }));
    expect(bob.you.slot).toBeNull();
    // A host who steps off stays off when they come back (only the first arrival seats them).
    const off = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, slot: null }) }));
    expect(off.you?.slot).toBeNull();
    const back = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'audience', resumeToken: host.resumeToken }) }));
    expect(back.you.slot).toBeNull();
    const seated = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, slot: 1 }) }));
    expect(seated.you?.slot).toBe(1);

    // A new meet's stage is open: bob could take a slot straight away. The host would rather decide: now bob asks, the host lets him on.
    expect(meet.stagePolicy).toBe('open');
    const closed = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/policy`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, stagePolicy: 'ask' }) }));
    expect(closed.meet.stagePolicy).toBe('ask');
    const askFirst = await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, slot: 2 }) });
    expect(askFirst.status).toBe(403);
    expect((await json<{ code: string }>(askFirst)).code).toBe('ask_first');
    expect((await app.request(`/meets/${meet.meetId}/requests/${bob.you.participantId}/decide`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, allow: true }) })).status).toBe(403); // not the host
    const asked = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/requests`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken }) }));
    expect(asked.you?.stageRequest).toBe('pending');
    expect(asked.meet.requests.map((r) => r.participantId)).toEqual([bob.you.participantId]);
    const declined = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/requests/${bob.you.participantId}/decide`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, allow: false }) }));
    expect(declined.meet.requests).toHaveLength(0);
    const bobView = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/heartbeat`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, chatSince: 0, driftMs: 0, rttMs: 0 }) }));
    expect(bobView.you?.stageRequest).toBe('declined');
    await app.request(`/meets/${meet.meetId}/requests`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken }) });
    const taken = await app.request(`/meets/${meet.meetId}/requests/${bob.you.participantId}/decide`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, allow: true, slot: 1 }) });
    expect(taken.status).toBe(409); // alice sits in slot 1
    const ok = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/requests/${bob.you.participantId}/decide`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, allow: true, slot: 2 }) }));
    expect(ok.meet.performerCount).toBe(2);
    expect(ok.meet.stage[1]!.participantId).toBe(bob.you.participantId);
    expect(ok.meet.requests).toHaveLength(0);
    // The host clears a slot and reseats him by opening the stage.
    const cleared = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/stage/${bob.you.participantId}/remove`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken }) }));
    expect(cleared.meet.performerCount).toBe(1);
    expect((await app.request(`/meets/${meet.meetId}/policy`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, stagePolicy: 'open' }) })).status).toBe(403);
    const opened = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/policy`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, stagePolicy: 'open' }) }));
    expect(opened.meet.stagePolicy).toBe('open');
    const reseated = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, slot: 2 }) }));
    expect(reseated.meet.performerCount).toBe(2);

    // The stage background is the stage's: bob, on stage, switches it for everyone; a listener cannot; a name that is not a background is refused.
    const bg = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/background`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, backgroundId: 'neon-arena' }) }));
    expect(bg.meet.backgroundId).toBe('neon-arena');
    const fanInRoom = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('erin'), body: JSON.stringify({ role: 'audience' }) }));
    expect((await app.request(`/meets/${meet.meetId}/background`, { method: 'POST', headers: as('erin'), body: JSON.stringify({ resumeToken: fanInRoom.resumeToken, backgroundId: 'mytestbg1' }) })).status).toBe(403);
    expect((await app.request(`/meets/${meet.meetId}/background`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, backgroundId: '../etc' }) })).status).toBe(400);
    expect((await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/heartbeat`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken }) }))).meet.backgroundId).toBe('neon-arena'); // the host's device sees it at its next poll
    await app.request(`/meets/${meet.meetId}/leave`, { method: 'POST', headers: as('erin'), body: JSON.stringify({ resumeToken: fanInRoom.resumeToken }) });

    await app.request(`/meets/${meet.meetId}/chat`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, text: 'ready!' }) });
    const hb = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/heartbeat`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, chatSince: 0, driftMs: 12, rttMs: 80 }) }));
    expect(hb.chat.map((m) => m.text)).toEqual(['ready!']);
    expect(hb.meet.stage[0]!.driftMs).toBe(12);

    // The song belongs to the stage: a singer on stage may start it (nothing to sing yet, though); the audience may not.
    const listener = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('listener'), body: JSON.stringify({ role: 'audience' }) }));
    expect((await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('listener'), body: JSON.stringify({ resumeToken: listener.resumeToken, leadMs: 5000 }) })).status).toBe(403);
    await app.request(`/meets/${meet.meetId}/leave`, { method: 'POST', headers: as('listener'), body: JSON.stringify({ resumeToken: listener.resumeToken }) });
    const noSong = await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, leadMs: 5000 }) });
    expect((await json<{ code: string }>(noSong)).code).toBe('no_song');
    // The set list: the meet was created with a title only; bob (on stage) picks the first song, alice queues another.
    const picked = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, song: { trackId: 'trk-1', catalogTrackId: 'trk-1', trackTitle: 'Amma', durationMs: 283000 } }) }));
    expect(picked.meet).toMatchObject({ trackTitle: 'Amma', catalogTrackId: 'trk-1', currentDurationMs: 283000 });
    // A tap that lands twice (or the same song picked again from the other device) adds nothing.
    const twice = await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, song: { trackId: 'own-copy', catalogTrackId: 'trk-1', trackTitle: 'Amma', durationMs: 283000 } }) });
    expect(twice.status).toBe(200);
    expect(twice.headers.get('X-Song-Duplicate')).toBe('current');
    expect((await json<MeetSnapshot>(twice)).meet.setList).toHaveLength(0);
    const queued = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, song: { trackId: 'trk-2', catalogTrackId: null, trackTitle: 'Next one' } }) }));
    // Two songs picked: the second is put forward and the stage must choose; picking it again adds nothing either.
    expect(queued.meet.setList.map((e) => e.trackTitle)).toEqual(['Next one']);
    expect(queued.meet.trackTitle).toBe('Amma');
    const repick = await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, song: { trackId: 'trk-2', catalogTrackId: null, trackTitle: 'Next one' } }) });
    expect(repick.headers.get('X-Song-Duplicate')).toBe('proposed');
    expect((await json<MeetSnapshot>(repick)).meet.setList.map((e) => e.trackTitle)).toEqual(['Next one']);
    expect((await app.request(`/meets/${meet.meetId}/songs/${queued.meet.setList[0]!.id}`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, action: 'up' }) })).status).toBe(400); // no ordering: the stage chooses
    expect((await app.request(`/meets/${meet.meetId}/songs/nope`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, action: 'remove' }) })).status).toBe(404);
    expect((await app.request(`/meets/${meet.meetId}/songs/nope`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, action: 'choose' }) })).status).toBe(404);
    // Nothing starts while the stage has not settled on one song; one tap by any singer settles it and the other song is gone.
    expect((await json<{ code: string }>(await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 5000 }) }))).code).toBe('choice_pending');
    const chosen = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs/current`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, action: 'choose' }) }));
    expect(chosen.meet.trackTitle).toBe('Amma');
    expect(chosen.meet.setList).toHaveLength(0);
    const started = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 5000 }) }));
    expect(started.meet.state).toBe('countdown');
    expect(started.meet.kickstartEpochMs! - Date.now()).toBeGreaterThan(4000);

    // transport: the host and any singer on stage pause / resume / seek / restart (the song belongs to the stage); the audience cannot
    const erin = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('erin'), body: JSON.stringify({ role: 'audience' }) }));
    expect((await app.request(`/meets/${meet.meetId}/restart`, { method: 'POST', headers: as('erin'), body: JSON.stringify({ resumeToken: erin.resumeToken, fromMs: 0 }) })).status).toBe(403);
    await app.request(`/meets/${meet.meetId}/leave`, { method: 'POST', headers: as('erin'), body: JSON.stringify({ resumeToken: erin.resumeToken }) });
    const paused = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/pause`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, leadMs: 0 }) }));
    // Pausing during the countdown is cued at the kickstart itself: everyone stops at position 0.
    expect(paused.meet.playback).toMatchObject({ state: 'playing', pauseAtEpochMs: started.meet.kickstartEpochMs, pausedAtMs: 0 });
    expect(paused.meet.state).toBe('live');
    const resumed = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/resume`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 2000 }) }));
    expect(resumed.meet.playback).toMatchObject({ state: 'playing', epoch: 2 });
    expect(resumed.meet.kickstartEpochMs! - Date.now()).toBeGreaterThan(1000);
    // A singer on stage restarts from the top for everyone (not only the host).
    const restarted = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/restart`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, leadMs: 2000, fromMs: 0 }) }));
    expect(restarted.meet.playback).toMatchObject({ state: 'playing', offsetMs: 0, epoch: 3 });
    // A seek while playing is cued like a kickstart (everyone jumps at the same instant); by a singer on stage too.
    const sought = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/seek`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, leadMs: 2000, toMs: 45000 }) }));
    expect(sought.meet.playback).toMatchObject({ state: 'playing', offsetMs: 45000, pausedAtMs: 45000, epoch: 4 });
    expect(sought.meet.kickstartEpochMs! - Date.now()).toBeGreaterThan(1000);
    // A seek while paused moves the paused position for everyone and bumps the epoch (devices re-seek), no kickstart.
    await app.request(`/meets/${meet.meetId}/pause`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 0 }) });
    const pausedSeekRes = await app.request(`/meets/${meet.meetId}/seek`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, toMs: 30000 }) });
    // (the pause is still cued at the coming kickstart here, so the seek waits: 409 'pausing'; once paused it moves the position)
    expect([200, 409]).toContain(pausedSeekRes.status);
    if (pausedSeekRes.status === 200) expect((await json<MeetSnapshot>(pausedSeekRes)).meet.playback.pausedAtMs).toBe(30000);
    else expect((await json<{ code: string }>(pausedSeekRes)).code).toBe('pausing');
    // The stage mix for the audience: the host's device posts a second at a time; anyone in the meet fetches what is new.
    const batch = { seq: 1, atMs: 12000, codec: 'opus', sampleRate: 48000, channels: 1, packets: [{ ts: 0, b64: 'AAEC' }, { ts: 20000, b64: 'AwQF' }] };
    expect((await app.request(`/meets/${meet.meetId}/mix`, { method: 'POST', headers: as('bob'), body: JSON.stringify(batch) })).status).toBe(403); // not the host
    expect((await app.request(`/meets/${meet.meetId}/mix`, { method: 'POST', headers: as('alice'), body: JSON.stringify(batch) })).status).toBe(200);
    expect((await app.request(`/meets/${meet.meetId}/mix`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...batch, seq: 2, atMs: 13000 }) })).status).toBe(200);
    const mix = await json<{ batches: { seq: number; atMs: number; packets: unknown[] }[]; latest: number }>(await app.request(`/meets/${meet.meetId}/mix?since=1`, { headers: as('bob') }));
    expect(mix.latest).toBe(2);
    expect(mix.batches.map((b) => b.seq)).toEqual([2]);
    expect(mix.batches[0]!.atMs).toBe(13000);
    expect(mix.batches[0]!.packets).toHaveLength(2);
    const publicMix = await json<{ batches: { seq: number }[] }>(await app.request(`/watch/${meet.meetId}/mix?since=0`));
    expect(publicMix.batches.map((b) => b.seq)).toEqual([1, 2]); // the public watch page hears it too
    // The service numbers the batches: the host's device starts its own count again when it rebuilds its mix (the next
    // song, a reload) — a listener who has heard batch 2 keeps hearing, never waits for the new count to pass 2.
    const renumbered = await json<{ seq: number }>(await app.request(`/meets/${meet.meetId}/mix`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...batch, seq: 1, atMs: 0 }) }));
    expect(renumbered.seq).toBe(3);
    const after = await json<{ batches: { seq: number; atMs: number }[]; latest: number }>(await app.request(`/meets/${meet.meetId}/mix?since=2`, { headers: as('bob') }));
    expect(after.latest).toBe(3);
    expect(after.batches.map((b) => [b.seq, b.atMs])).toEqual([[3, 0]]);

    // Song over — any singer on stage ends it (the audience cannot): back to the lobby with the next song up; the stage stays as it was.
    const fan = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('fan'), body: JSON.stringify({ role: 'audience' }) }));
    expect((await app.request(`/meets/${meet.meetId}/songs/next`, { method: 'POST', headers: as('fan'), body: JSON.stringify({ resumeToken: fan.resumeToken }) })).status).toBe(403);
    await app.request(`/meets/${meet.meetId}/leave`, { method: 'POST', headers: as('fan'), body: JSON.stringify({ resumeToken: fan.resumeToken }) });
    // A song picked during the song waits for its end — alone, it is up by itself when the song is over.
    const during = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, song: { trackId: 'trk-2', catalogTrackId: null, trackTitle: 'Next one' } }) }));
    expect(during.meet).toMatchObject({ trackTitle: 'Amma', state: 'live' });
    expect(during.meet.setList.map((e) => e.trackTitle)).toEqual(['Next one']);
    const over = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs/next`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken }) }));
    expect(over.meet).toMatchObject({ state: 'lobby', trackTitle: 'Next one', songCount: 1, performerCount: 2 });
    expect(over.meet.setList).toHaveLength(0);
    expect(over.meet.stage[0]!.ready).toBe(false);
    const again = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 3000 }) }));
    expect(again.meet.state).toBe('countdown');

    // WebRTC signalling relay between the two performers
    const sent = await app.request(`/meets/${meet.meetId}/signal`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, to: bob.you.participantId, type: 'offer', data: JSON.stringify({ sdp: 'v=0' }) }) });
    expect(sent.status).toBe(200);
    expect(await json<{ gone?: boolean }>(await app.request(`/meets/${meet.meetId}/signal`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, to: 'nobody', type: 'offer', data: '{}' }) }))).toEqual({ seq: 0, gone: true });
    const inbox = await json<{ signals: { from: string; type: string; data: string; seq: number }[] }>(await app.request(`/meets/${meet.meetId}/signals`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, since: 0 }) }));
    expect(inbox.signals).toHaveLength(1);
    expect(inbox.signals[0]).toMatchObject({ from: host.you.participantId, type: 'offer' });
    const nothingNew = await json<{ signals: unknown[] }>(await app.request(`/meets/${meet.meetId}/signals`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, since: inbox.signals[0]!.seq }) }));
    expect(nothingNew.signals).toHaveLength(0);
    const aliceInbox = await json<{ signals: unknown[] }>(await app.request(`/meets/${meet.meetId}/signals`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, since: 0 }) }));
    expect(aliceInbox.signals).toHaveLength(0); // not addressed to her
    // Audience may not pull performer video; a privileged publisher gets its own participant and may.
    const carol = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ role: 'audience' }) }));
    expect((await app.request(`/meets/${meet.meetId}/signals`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ resumeToken: carol.resumeToken, since: 0 }) })).status).toBe(403);
    expect((await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ role: 'publisher' }) })).status).toBe(403); // not privileged
    const pub = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'publisher' }) }));
    expect(pub.you.role).toBe('publisher');
    expect(pub.you.participantId).not.toBe(host.you.participantId); // alice still performs on her other device
    expect(pub.you.slot).toBeNull();
    expect((await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: pub.resumeToken, slot: 3 }) })).status).toBe(409);
    expect((await app.request(`/meets/${meet.meetId}/signal`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: pub.resumeToken, to: bob.you.participantId, type: 'offer', data: '{}' }) })).status).toBe(200);
    const bobInbox = await json<{ signals: { from: string; seq: number }[] }>(await app.request(`/meets/${meet.meetId}/signals`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, since: inbox.signals[0]!.seq }) }));
    expect(bobInbox.signals.map((x) => x.from)).toEqual([pub.you.participantId]);
    // A burst at the same instant (a publisher fanning offers + ICE out to the whole stage) never loses a signal to a seq collision.
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => app.request(`/meets/${meet.meetId}/signal`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, to: bob.you.participantId, type: 'ice', data: JSON.stringify({ i }) }) })));
    expect(burst.map((r) => r.status)).toEqual(Array<number>(12).fill(200));
    const lastSeq = Math.max(...bobInbox.signals.map((x) => x.seq));
    const bobBurst = await json<{ signals: { seq: number; data: string }[] }>(await app.request(`/meets/${meet.meetId}/signals`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, since: lastSeq }) }));
    expect(bobBurst.signals).toHaveLength(12);
    expect(new Set(bobBurst.signals.map((x) => x.seq)).size).toBe(12);
    expect(new Set(bobBurst.signals.map((x) => x.data)).size).toBe(12);
    const hostAgain = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'performer', resumeToken: host.resumeToken }) }));
    expect(hostAgain.you.participantId).toBe(host.you.participantId); // the performer participant is untouched
    expect(hostAgain.meet.audienceCount).toBe(1); // carol; the publisher is not audience
    // A publisher view resumes only by its own token (a second view — a Preview tile — is its own participant);
    // a member join without a token still resumes the account's member record, never the publisher one.
    const pubByToken = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'publisher', resumeToken: pub.resumeToken }) }));
    expect(pubByToken.you.participantId).toBe(pub.you.participantId);
    const pubView2 = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'publisher' }) }));
    expect(pubView2.you.role).toBe('publisher');
    expect(pubView2.you.participantId).not.toBe(pub.you.participantId);
    const roomAgain = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'audience' }) }));
    expect(roomAgain.you.participantId).toBe(host.you.participantId);
    expect(roomAgain.you.slot).toBe(1);
    expect(roomAgain.meet.audienceCount).toBe(1); // still only carol: publisher views never count as audience
    expect((await app.request(`/meets/${meet.meetId}/leave`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: pubView2.resumeToken }) })).status).toBe(200);
    const ice = await json<{ iceServers: { urls: string | string[] }[] }>(await app.request('/ice', { headers: as('bob') }));
    expect(ice.iceServers[0]!.urls).toContain('stun:stun.l.google.com:19302');

    const rec = await app.request(`/meets/${meet.meetId}/recordings`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, performanceId: 'perf-1', driveFolderLink: 'https://drive/x', durationMs: 1000 }) });
    expect(rec.status).toBe(201);
    const stopped = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/stop`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken }) }));
    expect(stopped.meet.state).toBe('ended');
    expect(stopped.recordings).toHaveLength(1);

    const watch = await json<{ meet: { state: string }; chat: unknown[] }>(await app.request(`/watch/${meet.meetId}`));
    expect(watch.meet.state).toBe('ended');
    expect(watch.chat).toHaveLength(1);
    expect((await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('carol'), body: '{}' })).status).toBe(410);
  });

  it('meets: a crowd of forty costs a poll a dozen names and a count', async () => {
    const created = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('carol'), body: JSON.stringify({ title: 'Big night' }) }));
    const host = await json<JoinMeetResponse>(await app.request(`/meets/${created.meet.meetId}/join`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ role: 'audience' }) }));
    for (let i = 0; i < 40; i++) expect((await app.request(`/meets/${created.meet.meetId}/join`, { method: 'POST', headers: as(`fan${i}`), body: JSON.stringify({ role: 'audience' }) })).status).toBe(200);
    const fan0 = await json<JoinMeetResponse>(await app.request(`/meets/${created.meet.meetId}/join`, { method: 'POST', headers: as('fan0'), body: JSON.stringify({ role: 'audience' }) }));
    const snap = await json<MeetSnapshot>(await app.request(`/meets/${created.meet.meetId}/heartbeat`, { method: 'POST', headers: as('fan0'), body: JSON.stringify({ resumeToken: fan0.resumeToken, chatSince: 0 }) }));
    expect(snap.meet.audienceCount).toBe(40); // the host is on stage; fan0 joining again is the same account
    expect(snap.participants.filter((p) => p.slot === null && p.role !== 'host')).toHaveLength(12);
    expect(snap.participants.some((p) => p.participantId === host.you.participantId)).toBe(true);
    expect(JSON.stringify(snap).length).toBeLessThan(12_000);
    // The host sees everyone — they decide who stays — and removes one for good.
    const hostView = await json<MeetSnapshot>(await app.request(`/meets/${created.meet.meetId}/heartbeat`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ resumeToken: host.resumeToken, chatSince: 0 }) }));
    expect(hostView.participants.filter((p) => p.role === 'audience')).toHaveLength(40);
    const fan7 = hostView.participants.find((p) => p.displayName === 'fan7')!;
    expect((await app.request(`/meets/${created.meet.meetId}/participants/${fan7.participantId}/kick`, { method: 'POST', headers: as('fan0'), body: JSON.stringify({ resumeToken: fan0.resumeToken }) })).status).toBe(403);
    const after = await json<MeetSnapshot>(await app.request(`/meets/${created.meet.meetId}/participants/${fan7.participantId}/kick`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ resumeToken: host.resumeToken }) }));
    expect(after.meet.audienceCount).toBe(39);
    expect(after.meet.bannedUserIds).toContain(fan7.userId);
    const back = await app.request(`/meets/${created.meet.meetId}/join`, { method: 'POST', headers: as('fan7'), body: JSON.stringify({ role: 'audience' }) });
    expect(back.status).toBe(403);
    expect((await json<{ code: string }>(back)).code).toBe('removed');
  });

  it('meets list maintenance: at most 3 open meets per host, end from the list, delete for good', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('dave'), body: JSON.stringify({ title: `Dave ${i}` }) }))).meet.meetId);
    const fourth = await app.request('/meets', { method: 'POST', headers: as('dave'), body: JSON.stringify({ title: 'Dave 3' }) });
    expect(fourth.status).toBe(409);
    expect((await json<{ code: string }>(fourth)).code).toBe('too_many_meets');
    expect((await app.request(`/meets/${ids[0]}/end`, { method: 'POST', headers: as('bob') })).status).toBe(403);
    const ended = await json<{ meet: Meet }>(await app.request(`/meets/${ids[0]}/end`, { method: 'POST', headers: as('dave') }));
    expect(ended.meet.state).toBe('ended');
    expect((await app.request('/meets', { method: 'POST', headers: as('dave'), body: JSON.stringify({ title: 'Dave 3' }) })).status).toBe(201); // room again
    expect((await app.request(`/meets/${ids[1]}`, { method: 'DELETE', headers: as('bob') })).status).toBe(403);
    expect((await app.request(`/meets/${ids[1]}`, { method: 'DELETE', headers: as('dave') })).status).toBe(200);
    expect((await app.request(`/meets/${ids[1]}`, { headers: as('dave') })).status).toBe(404);
    const list = await json<{ meets: Meet[] }>(await app.request('/meets', { headers: as('dave') }));
    expect(list.meets.map((m) => m.title).sort()).toEqual(['Dave 0', 'Dave 2', 'Dave 3']);
  });

  it('the master track database: one record per source with a 12-character id, metadata filled in and never blanked, catalog entries mirrored', async () => {
    const refs = { folderId: 'folder00000001', jsonId: 'json0000000011', audioId: 'audio000000011', audioMime: 'audio/mp4', videoId: 'video000000011', videoMime: 'video/mp4' };
    const reg = { source: 'youtube', song: 'Ammo Ammaayena', artists: '', movie: '', year: null, language: 'Telugu', driveUrl: 'https://drive.google.com/drive/folders/folder00000001', refs, durationMs: 283000, singerCount: 1, youtubeId: 'dQw4w9WgXcQ', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg', copyTrackId: 'trk-alice-yt' };
    const r1 = await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify(reg) });
    expect(r1.status).toBe(201);
    const first = (await r1.json()) as { track: { trackId: string; sourceKey: string; song: string; language: string; lastAccessedAt: string | null; copies: number; singers: number; mine: { copyTrackId: string } | null; hasVideo: boolean }; created: boolean };
    expect(first.created).toBe(true);
    // 8 random characters from an alphabet without 0/O/1/I, then the month it was minted (YYMM).
    const ym = `${String(new Date().getUTCFullYear() % 100).padStart(2, '0')}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    expect(first.track.trackId).toMatch(new RegExp(`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}${ym}$`));
    expect(first.track).toMatchObject({ sourceKey: 'yt:dQw4w9WgXcQ', song: 'Ammo Ammaayena', language: 'Telugu', lastAccessedAt: null, copies: 1, singers: 0, hasVideo: true, mine: { copyTrackId: 'trk-alice-yt', count: 0 } });
    // The same video again, by another singer, with more metadata: the same record, the blanks filled, nothing blanked, the owner's files kept.
    const r2 = await app.request('/tracks/register', { method: 'POST', headers: as('bob'), body: JSON.stringify({ ...reg, song: '', artists: 'Sid Sriram', movie: 'Ammo', year: 2019, language: '', refs: { ...refs, jsonId: 'json0000000012', audioId: 'audio000000012' }, driveUrl: 'https://drive.google.com/drive/folders/folderbob0001', copyTrackId: 'trk-bob-yt' }) });
    expect(r2.status).toBe(200);
    const again = (await r2.json()) as { track: { trackId: string; song: string; artists: string; movie: string; year: number | null; language: string; refs: { jsonId: string }; driveUrl: string; copies: number; ownerUserId: string }; created: boolean };
    expect(again.created).toBe(false);
    expect(again.track).toMatchObject({ trackId: first.track.trackId, song: 'Ammo Ammaayena', artists: 'Sid Sriram', movie: 'Ammo', year: 2019, language: 'Telugu', refs: { jsonId: 'json0000000011' }, driveUrl: 'https://drive.google.com/drive/folders/folder00000001', copies: 2 });
    expect(again.track.ownerUserId).not.toBe('');
    // What the service refuses: a source it does not know, no song, file ids that are not Drive's, a URL that is not Drive's, a YouTube track without its video.
    expect((await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...reg, source: 'spotify' }) })).status).toBe(400);
    expect((await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...reg, song: '  ', youtubeId: 'zzzzzzzzzzz' }) })).status).toBe(400); // a new source needs a name
    expect((await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...reg, song: '  ' }) })).status).toBe(200); // a known one has its name already
    expect((await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...reg, refs: { ...refs, jsonId: 'no' } }) })).status).toBe(400);
    expect((await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...reg, driveUrl: 'https://evil.example/x' }) })).status).toBe(400);
    expect((await app.request('/tracks/register', { method: 'POST', headers: as('alice'), body: JSON.stringify({ ...reg, youtubeId: '' }) })).status).toBe(400);
    expect((await app.request('/tracks/register', { method: 'POST', body: JSON.stringify(reg) })).status).toBe(401);
    // A published catalog entry is a record too, and the entry learns its registry id.
    const pub = { trackId: 'trk-cat-9', title: 'Ammo Ammaayena', artist: 'SV TrackMaker', genre: 'Telugu film', language: 'Telugu', durationMs: 283000, singerCount: 2, lineCount: 67, driveFolderId: 'foldercat00009', driveFolderLink: 'https://drive.google.com/drive/folders/foldercat00009', trackJsonId: 'json0000000009', audioId: 'audio000000009', audioMime: 'audio/mpeg' };
    const pr = (await (await app.request('/catalog/tracks', { method: 'POST', headers: as('carol'), body: JSON.stringify(pub) })).json()) as { track: { registryId?: string } };
    expect(pr.track.registryId).toMatch(/^[A-Z2-9]{8}\d{4}$/);
    const cat = (await (await app.request(`/tracks/${pr.track.registryId}`, { headers: as('bob') })).json()) as { track: { source: string; sourceKey: string; catalogTrackId: string; song: string } };
    expect(cat.track).toMatchObject({ source: 'catalog', sourceKey: 'catalog:trk-cat-9', catalogTrackId: 'trk-cat-9', song: 'Ammo Ammaayena' });
    expect((await app.request('/tracks/NOTANID', { headers: as('bob') })).status).toBe(404);
  });

  it('the master track database: an access moves the global and my own last-accessed instants (UTC); searches and copies do not; the song groups sort by the latest access; history is mine', async () => {
    const mk = (song: string, key: string, extra: Record<string, unknown> = {}) => ({ source: 'drive', song, driveUrl: `https://drive.google.com/drive/folders/${key}`, refs: { folderId: key, jsonId: `json${key.slice(-10)}`, audioId: `audi${key.slice(-10)}`, audioMime: 'audio/mpeg' }, durationMs: 200000, singerCount: 1, ...extra });
    const reg = async (who: string, body: unknown) => ((await (await app.request('/tracks/register', { method: 'POST', headers: as(who), body: JSON.stringify(body) })).json()) as { track: { trackId: string } }).track.trackId;
    const a1 = await reg('alice', mk('Bole Chudiyan', 'folderboleaaaa', { artists: 'Udit Narayan', movie: 'K3G', year: 2001, language: 'Hindi' }));
    const a2 = await reg('bob', mk('Bole Chudiyan', 'folderbolebbbb', { artists: 'Karaoke Hits', language: 'Hindi' })); // the same song, another file: a version of its own
    const b1 = await reg('alice', mk('Hey Jude', 'folderjudeaaaa', { artists: 'The Beatles', language: 'English' }));
    expect(new Set([a1, a2, b1]).size).toBe(3);
    const search = async (q: string, who = 'bob') => (await (await app.request(`/tracks/search?q=${encodeURIComponent(q)}`, { headers: as(who) })).json()) as { groups: { song: string; songKey: string; lastAccessedAt: string | null; versions: { trackId: string; lastAccessedAt: string | null; mine: null | { count: number } }[] }[]; total: number };
    // Searching counts for nothing: nothing has been accessed yet; both Bole Chudiyan files are one group, two versions.
    const s0 = await search('bole');
    expect(s0.total).toBe(1);
    expect(s0.groups[0]).toMatchObject({ song: 'Bole Chudiyan', songKey: 'bole chudiyan', lastAccessedAt: null });
    expect(s0.groups[0]!.versions.map((v) => v.trackId).sort()).toEqual([a1, a2].sort());
    expect((await search('chudiyan udit')).total).toBe(1); // every word must appear, in any field
    expect((await search('chudiyan beatles')).total).toBe(0);
    expect((await search('k3g')).total).toBe(1); // the movie is searched too
    expect((await search('2001')).total).toBe(1); // and the year
    // bob sings Hey Jude: the global instant and bob's own move to now, in UTC; alice's own history has nothing.
    const t0 = Date.now();
    const acc = (await (await app.request(`/tracks/${b1}/access`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ how: 'sing' }) })).json()) as { track: { lastAccessedAt: string; accessCount: number; singers: number; mine: { count: number; lastAccessedAt: string } } };
    expect(Date.parse(acc.track.lastAccessedAt)).toBeGreaterThanOrEqual(t0 - 5);
    expect(acc.track.lastAccessedAt.endsWith('Z')).toBe(true);
    expect(acc.track).toMatchObject({ accessCount: 1, singers: 1, mine: { count: 1 } });
    const asAlice = (await (await app.request(`/tracks/${b1}`, { headers: as('alice') })).json()) as { track: { mine: null | { count: number } } };
    expect(asAlice.track.mine).toBeNull();
    expect((await app.request(`/tracks/${b1}/access`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ how: 'hover' }) })).status).toBe(400);
    expect((await app.request('/tracks/AAAAAAAA2611/access', { method: 'POST', headers: as('bob'), body: JSON.stringify({ how: 'sing' }) })).status).toBe(404);
    // The groups sort by the latest access in them: Hey Jude first now, Bole Chudiyan (never sung) after; then a sing of bob's version lifts its group and puts his version first in it.
    let all = await search(''); // every group (the catalog tests' songs are here too, never sung: after these)
    expect(all.groups.map((g) => g.song).slice(0, 2)).toEqual(['Hey Jude', 'Bole Chudiyan']);
    await new Promise((r) => setTimeout(r, 5));
    await app.request(`/tracks/${a2}/access`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ how: 'play' }) });
    all = await search('');
    expect(all.groups.map((g) => g.song).slice(0, 2)).toEqual(['Bole Chudiyan', 'Hey Jude']);
    expect(all.groups[0]!.versions.map((v) => v.trackId)).toEqual([a2, a1]);
    expect(all.groups[0]!.versions[0]!.lastAccessedAt).toBe(all.groups[0]!.lastAccessedAt);
    // A copy registered by a singer is not an access: nothing moves — but it is one more place the files come from.
    const before = all.groups[1]!.lastAccessedAt;
    const cp = (await (await app.request(`/tracks/${b1}/copies`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ refs: { folderId: 'foldercarol001', jsonId: 'jsoncarol00001', audioId: 'audiocarol0001', audioMime: 'audio/mpeg' }, driveUrl: 'https://drive.google.com/drive/folders/foldercarol001', copyTrackId: 'trk-carol-jude' }) })).json()) as { track: { lastAccessedAt: string; copies: number; accessCount: number } };
    expect(cp.track).toMatchObject({ lastAccessedAt: before, copies: 1, accessCount: 1 });
    expect((await app.request(`/tracks/${b1}/copies`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ refs: { folderId: 'x' }, driveUrl: 'https://drive.google.com/x', copyTrackId: 'y' }) })).status).toBe(400);
    // History: what each singer sang, the latest first — nobody else's.
    const hist = async (who: string) => ((await (await app.request('/tracks/history', { headers: as(who) })).json()) as { items: { trackId: string }[] }).items.map((i) => i.trackId);
    expect(await hist('bob')).toEqual([b1]);
    expect(await hist('alice')).toEqual([a2]);
    expect(await hist('carol')).toEqual([]);
    // Pages of groups.
    const page = (await (await app.request('/tracks/search?q=bole&limit=1', { headers: as('bob') })).json()) as { groups: unknown[]; total: number; nextCursor: string | null };
    expect(page.groups).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeNull();
    const page2 = (await (await app.request('/tracks/search?limit=1', { headers: as('bob') })).json()) as { groups: unknown[]; total: number; nextCursor: string | null };
    expect(page2.groups).toHaveLength(1);
    expect(page2.total).toBeGreaterThanOrEqual(2);
    expect(page2.nextCursor).toBe('1');
    // Metadata: the owner (or a super admin) corrects it; another singer cannot.
    expect((await app.request(`/tracks/${a1}/`, { method: 'PATCH', headers: as('bob'), body: JSON.stringify({ movie: 'Kabhi Khushi Kabhie Gham' }) })).status).toBe(404); // the trailing slash is no route
    expect((await app.request(`/tracks/${a1}`, { method: 'PATCH', headers: as('bob'), body: JSON.stringify({ movie: 'Kabhi Khushi Kabhie Gham' }) })).status).toBe(403);
    const patched = (await (await app.request(`/tracks/${a1}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ movie: 'Kabhi Khushi Kabhie Gham', year: 2001, song: '' }) })).json()) as { track: { movie: string; song: string } };
    expect(patched.track).toMatchObject({ movie: 'Kabhi Khushi Kabhie Gham', song: 'Bole Chudiyan' }); // a blank song name is not taken
    expect((await search('kabhi khushi')).total).toBe(1);
    expect((await app.request(`/tracks/${a2}`, { method: 'PATCH', headers: as('carol'), body: JSON.stringify({ language: 'Hindi' }) })).status).toBe(403); // not carol's record
    expect((await app.request(`/tracks/${a2}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ language: 'Hindi' }) })).status).toBe(200); // alice: the first account, the super admin
  });

  it("the master track database hands a song's files over from the owner's Drive, then from any singer's shared copy when the owner's is gone — and marks it unavailable when none is left", async () => {
    const reg = async (who: string, body: unknown) => ((await (await app.request('/tracks/register', { method: 'POST', headers: as(who), body: JSON.stringify(body) })).json()) as { track: { trackId: string } }).track.trackId;
    const id = await reg('alice', { source: 'drive', song: 'Fallback song', driveUrl: 'https://drive.google.com/drive/folders/folderfallback', refs: { folderId: 'folderfallback', jsonId: 'jsonowner00001', audioId: 'audioowner0001', audioMime: 'audio/mpeg' } });
    await app.request(`/tracks/${id}/copies`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ refs: { folderId: 'folderbobcopy1', jsonId: 'jsonbobcopy001', audioId: 'audiobobcopy01', audioMime: 'audio/mpeg' }, driveUrl: 'https://drive.google.com/drive/folders/folderbobcopy1', copyTrackId: 'trk-bob-fb' }) });
    const live = new Set(['jsonowner00001', 'audioowner0001', 'jsonbobcopy001', 'audiobobcopy01']);
    const asked: string[] = [];
    deps.fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const hit = [...live].find((f) => url.includes(f));
      return hit ? new Response(hit.startsWith('json') ? JSON.stringify({ title: 'Fallback song', from: hit }) : new Uint8Array([4, 2]), { status: 200, headers: { 'content-type': hit.startsWith('json') ? 'application/json' : 'audio/mpeg' } }) : new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    // The owner's file first.
    let j = await app.request(`/tracks/${id}/file/json`, { headers: as('carol') });
    expect(j.status).toBe(200);
    expect(((await j.json()) as { from: string }).from).toBe('jsonowner00001');
    // The owner unshared (or deleted) the folder: bob's shared copy answers instead; the song stays available.
    live.delete('jsonowner00001');
    live.delete('audioowner0001');
    j = await app.request(`/tracks/${id}/file/json`, { headers: as('carol') });
    expect(j.status).toBe(200);
    expect(((await j.json()) as { from: string }).from).toBe('jsonbobcopy001');
    const a = await app.request(`/tracks/${id}/file/audio`, { headers: as('carol') });
    expect(a.status).toBe(200);
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array([4, 2]));
    expect(((await (await app.request(`/tracks/${id}`, { headers: as('carol') })).json()) as { track: { unavailable: boolean } }).track.unavailable).toBe(false);
    // Every copy gone: the service says so, the record is marked unavailable — and an access is never counted for it (the device reports only successes).
    live.clear();
    const gone = await app.request(`/tracks/${id}/file/json`, { headers: as('carol') });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe('not_shared');
    expect(((await (await app.request(`/tracks/${id}`, { headers: as('carol') })).json()) as { track: { unavailable: boolean; lastAccessedAt: string | null } }).track).toMatchObject({ unavailable: true, lastAccessedAt: null });
    expect((await app.request(`/tracks/${id}/file/video`, { headers: as('carol') })).status).toBe(404); // no video on this one
    // A fresh copy registered: available again.
    await app.request(`/tracks/${id}/copies`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ refs: { folderId: 'foldercarolcp1', jsonId: 'jsoncarolcpy01', audioId: 'audiocarolcp01', audioMime: 'audio/mpeg' }, driveUrl: 'https://drive.google.com/drive/folders/foldercarolcp1', copyTrackId: 'trk-carol-fb' }) });
    expect(((await (await app.request(`/tracks/${id}`, { headers: as('carol') })).json()) as { track: { unavailable: boolean; copies: number } }).track).toMatchObject({ unavailable: false, copies: 2 });
    deps.fetchImpl = undefined;
  });

  it('billing: Publishing is the club owner year — a Stripe webhook (signed, replay-safe) opens it, cancellation closes it, an admin can grant it', async () => {
    // Nobody but a club owner with an active year (or a super admin) can publish.
    const locked = await app.request('/publishing/destinations', { headers: as('erin') });
    expect(locked.status).toBe(403);
    expect((await json<{ code: string }>(locked)).code).toBe('publishing_closed');
    const erin = await json<{ user: { userId: string; plan: string; canPublish: boolean } }>(await app.request('/me', { headers: as('erin') }));
    expect(erin.user.plan).toBe('free');
    expect(erin.user.canPublish).toBe(false);
    // Without Stripe configured, the (older) billing route still knows the plans and that checkout is off.
    const status = await json<{ checkout: boolean; portal: boolean; plans: Record<string, { title: string }>; price: unknown }>(await app.request('/billing', { headers: as('erin') }));
    expect(status.checkout).toBe(false);
    expect(status.plans.publisher!.title).toBe('Club owner');
    expect((await app.request('/billing/checkout', { method: 'POST', headers: as('erin'), body: '{}' })).status).toBe(409);

    // Stripe arrives: checkout creates a session with our user id on it, the webhook signs its events.
    const asked: { url: string; body: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, body: String(init?.body ?? '') });
      if (url.endsWith('/checkout/sessions')) return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
      if (url.endsWith('/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.com/p/session/1' });
      if (url.includes('/prices/')) return Response.json({ unit_amount: 1499, currency: 'usd', recurring: { interval: 'month' } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    deps.billing = { secretKey: 'sk_test_x', webhookSecret: 'whsec_test_secret', pricePublisher: 'price_pub', appUrl: 'https://singersvoice.github.io/SingersVoice/', fetchImpl };
    const priced = await json<{ checkout: boolean; price: { amount: number; currency: string; interval: string } | null }>(await app.request('/billing', { headers: as('erin') }));
    expect(priced.checkout).toBe(true);
    expect(priced.price).toEqual({ amount: 1499, currency: 'usd', interval: 'month' });
    const co = await json<{ url: string }>(await app.request('/billing/checkout', { method: 'POST', headers: as('erin'), body: '{}' }));
    expect(co.url).toContain('checkout.stripe.com');
    const sent = new URLSearchParams(asked.find((a) => a.url.endsWith('/checkout/sessions'))!.body);
    expect(sent.get('client_reference_id')).toBe(erin.user.userId);
    expect(sent.get('line_items[0][price]')).toBe('price_pub');
    expect(sent.get('success_url')).toBe('https://singersvoice.github.io/SingersVoice/club-owner?billing=success');

    const webhook = async (event: Record<string, unknown>, secret = 'whsec_test_secret', t = Math.floor(Date.now() / 1000)) => {
      const body = JSON.stringify(event);
      return app.request('/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': await signStripePayload(secret, body, t) }, body });
    };
    // A forged or stale signature is refused.
    expect((await webhook({ id: 'evt_0', type: 'checkout.session.completed', data: { object: {} } }, 'whsec_wrong')).status).toBe(400);
    expect((await webhook({ id: 'evt_0', type: 'checkout.session.completed', data: { object: {} } }, 'whsec_test_secret', Math.floor(Date.now() / 1000) - 3600)).status).toBe(400);
    // Checkout done: the plan opens and the customer is tied to the account.
    expect((await webhook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: erin.user.userId, customer: 'cus_erin', subscription: 'sub_erin' } } })).status).toBe(200);
    const open = await json<{ user: { plan: string; canPublish: boolean } }>(await app.request('/me', { headers: as('erin') }));
    expect(open.user.plan).toBe('publisher');
    expect(open.user.canPublish).toBe(true);
    expect((await app.request('/publishing/destinations', { headers: as('erin') })).status).toBe(200);
    const portal = await json<{ url: string }>(await app.request('/billing/portal', { method: 'POST', headers: as('erin'), body: '{}' }));
    expect(portal.url).toContain('billing.stripe.com');
    // The subscription's period end becomes the plan's end; a retry of the same event changes nothing.
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    expect((await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_erin', customer: 'cus_erin', status: 'active', current_period_end: end } } })).status).toBe(200);
    const dated = await json<{ user: { plan: string; planUntil: string | null } }>(await app.request('/me', { headers: as('erin') }));
    expect(dated.user.planUntil).toBe(new Date(end * 1000).toISOString());
    const again = await json<{ seen?: boolean }>(await webhook({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_erin', customer: 'cus_erin', status: 'canceled' } } }));
    expect(again.seen).toBe(true);
    expect((await json<{ user: { plan: string } }>(await app.request('/me', { headers: as('erin') }))).user.plan).toBe('publisher');
    // The subscription ends: Publishing closes.
    expect((await webhook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_erin', customer: 'cus_erin', status: 'canceled' } } })).status).toBe(200);
    expect((await json<{ user: { plan: string; canPublish: boolean } }>(await app.request('/me', { headers: as('erin') }))).user.canPublish).toBe(false);
    expect((await app.request('/publishing/destinations', { headers: as('erin') })).status).toBe(403);
    // An admin grants the plan by email; a non-admin cannot.
    expect((await app.request('/admin/plan', { method: 'POST', headers: as('bob'), body: JSON.stringify({ email: 'erin@dev.local', plan: 'publisher' }) })).status).toBe(403);
    const granted = await json<{ user: { plan: string; canPublish: boolean } }>(await app.request('/admin/plan', { method: 'POST', headers: as('alice'), body: JSON.stringify({ email: 'Erin@dev.local', plan: 'publisher' }) }));
    expect(granted.user.canPublish).toBe(true);
    expect((await app.request('/publishing/destinations', { headers: as('erin') })).status).toBe(200);
    delete deps.billing;
    resetPriceCache();
  });

  it("club owners: the super admin sets the price and the rules; a singer sees the offer and pays for a year on Stripe (the admin's price inline) or is told to ask; payments and grants are on record; the overview puts the expired and the expiring first; grace days keep a late renewal open", async () => {
    // The portal is the super admin's alone; the defaults sell nothing.
    expect((await app.request('/admin/club-owners', { headers: as('bob') })).status).toBe(403);
    expect((await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('bob'), body: JSON.stringify({ priceCents: 100 }) })).status).toBe(403);
    const before = await json<ClubOwnerOverview>(await app.request('/admin/club-owners', { headers: as('alice') }));
    expect(before.settings).toMatchObject({ priceCents: 0, currency: 'usd', selfService: true, expiringSoonDays: 30, graceDays: 0 });
    expect(before.stripe).toBe(false);
    // A singer without a year: the Club owner page says Publishing is for club owners and to ask the admin — no price, no Checkout.
    const frank = await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('frank') }));
    expect(frank).toMatchObject({ role: 'dual', canPublish: false, checkout: false, portal: false, price: null, selfService: true, payments: [], daysLeft: null });
    expect(frank.publishingNote).toMatch(/Club owner page/);
    expect((await json<{ code: string }>(await app.request('/club-owner/checkout', { method: 'POST', headers: as('frank'), body: '{}' }))).code).toBe('billing_unconfigured');
    // The super admin sets a price and a note; values out of bounds are kept within them.
    const set = await json<{ settings: ClubOwnerSettings }>(await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ priceCents: 4900, currency: 'USD', note: 'A year of Publishing mode for your club.', expiringSoonDays: 45, graceDays: 1000, updatedAt: 'ignored' }) }));
    expect(set.settings).toMatchObject({ priceCents: 4900, currency: 'usd', note: 'A year of Publishing mode for your club.', expiringSoonDays: 45, graceDays: 90 });
    expect(set.settings.updatedAt).not.toBe('ignored');
    expect(Date.parse(set.settings.updatedAt!)).toBeGreaterThan(Date.now() - 10_000);
    await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ graceDays: 0 }) });
    const priced = await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('frank') }));
    expect(priced.price).toEqual({ amount: 4900, currency: 'usd', interval: 'year' });
    expect(priced.note).toBe('A year of Publishing mode for your club.');
    expect(priced.checkout).toBe(false); // a price, but no Stripe yet

    // Stripe arrives: Checkout carries the admin's price inline — no Stripe Price object needed — and sends the singer back to the Club owner page.
    const asked: { url: string; body: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, body: String(init?.body ?? '') });
      if (url.endsWith('/checkout/sessions')) return Response.json({ id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' });
      if (url.endsWith('/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.com/p/session/2' });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    deps.billing = { secretKey: 'sk_test_x', webhookSecret: 'whsec_test_secret', appUrl: 'https://singersvoice.github.io/SingersVoice', fetchImpl };
    expect((await json<ClubOwnerOverview>(await app.request('/admin/club-owners', { headers: as('alice') }))).stripe).toBe(true);
    const open = await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('frank') }));
    expect(open.checkout).toBe(true);
    const co = await json<{ url: string }>(await app.request('/club-owner/checkout', { method: 'POST', headers: as('frank'), body: '{}' }));
    expect(co.url).toContain('checkout.stripe.com');
    const sent = new URLSearchParams(asked.find((a) => a.url.endsWith('/checkout/sessions'))!.body);
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('line_items[0][price_data][unit_amount]')).toBe('4900');
    expect(sent.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(sent.get('line_items[0][price_data][recurring][interval]')).toBe('year');
    expect(sent.get('line_items[0][price]')).toBeNull();
    expect(sent.get('success_url')).toBe('https://singersvoice.github.io/SingersVoice/club-owner?billing=success');
    expect(sent.get('cancel_url')).toBe('https://singersvoice.github.io/SingersVoice/club-owner?billing=cancel');
    // A super admin has nothing to buy.
    expect((await json<{ code: string }>(await app.request('/club-owner/checkout', { method: 'POST', headers: as('alice'), body: '{}' }))).code).toBe('super_admin');

    // frank pays: the year opens, the payment is on record once — a retried event and the first invoice add nothing.
    const webhook = async (event: Record<string, unknown>) => {
      const body = JSON.stringify(event);
      return app.request('/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': await signStripePayload('whsec_test_secret', body, Math.floor(Date.now() / 1000)) }, body });
    };
    const frankId = (await json<{ user: { userId: string } }>(await app.request('/me', { headers: as('frank') }))).user.userId;
    expect((await webhook({ id: 'evt_f1', type: 'checkout.session.completed', data: { object: { id: 'cs_frank', client_reference_id: frankId, customer: 'cus_frank', subscription: 'sub_frank', amount_total: 4900, currency: 'usd' } } })).status).toBe(200);
    expect((await webhook({ id: 'evt_f1', type: 'checkout.session.completed', data: { object: { id: 'cs_frank', client_reference_id: frankId, customer: 'cus_frank', subscription: 'sub_frank', amount_total: 4900, currency: 'usd' } } })).status).toBe(200);
    expect((await webhook({ id: 'evt_f2', type: 'invoice.paid', data: { object: { id: 'in_first', customer: 'cus_frank', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_create' } } })).status).toBe(200);
    const end = Math.floor(Date.now() / 1000) + 365 * 86400;
    expect((await webhook({ id: 'evt_f3', type: 'customer.subscription.updated', data: { object: { id: 'sub_frank', customer: 'cus_frank', status: 'active', current_period_end: end } } })).status).toBe(200);
    const paid = await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('frank') }));
    expect(paid).toMatchObject({ role: 'club_owner', canPublish: true, portal: true, publishingNote: '' });
    expect(paid.subscription).toMatchObject({ status: 'active', source: 'stripe' });
    expect(paid.daysLeft).toBeGreaterThan(360);
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]).toMatchObject({ amountCents: 4900, currency: 'usd', source: 'stripe', ref: 'cs_frank' });
    expect((await app.request('/publishing/destinations', { headers: as('frank') })).status).toBe(200);
    expect((await json<{ url: string }>(await app.request('/club-owner/portal', { method: 'POST', headers: as('frank'), body: '{}' }))).url).toContain('billing.stripe.com');
    // A year on, Stripe renews: the invoice is a payment of its own, with the period it paid for.
    expect((await webhook({ id: 'evt_f4', type: 'invoice.paid', data: { object: { id: 'in_renew', customer: 'cus_frank', amount_paid: 4900, currency: 'usd', billing_reason: 'subscription_cycle', lines: { data: [{ period: { start: end, end: end + 365 * 86400 } }] } } } })).status).toBe(200);
    const renewed = await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('frank') }));
    expect(renewed.payments.map((p) => p.ref)).toEqual(['in_renew', 'cs_frank']);
    expect(renewed.payments[0]!.periodEnd).toBe(new Date((end + 365 * 86400) * 1000).toISOString());

    // Self-service off: the page says to ask, Checkout is refused even with Stripe and a price.
    await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ selfService: false }) });
    const closed = await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('grace') }));
    expect(closed).toMatchObject({ checkout: false, selfService: false });
    expect(closed.price).toEqual({ amount: 4900, currency: 'usd', interval: 'year' }); // the price still shows
    expect((await json<{ code: string }>(await app.request('/club-owner/checkout', { method: 'POST', headers: as('grace'), body: '{}' }))).code).toBe('self_service_off');
    await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ selfService: true }) });

    // The overview: a year granted is a payment of 0 on record; one about to run out stands "expiring", one past "expired" — both ahead of the active ones.
    for (const who of ['grace', 'heidi', 'ivan']) await app.request('/me', { headers: as(who) });
    const all = await json<{ users: { userId: string; email: string }[] }>(await app.request('/admin/users', { headers: as('alice') }));
    const idOf = (email: string) => all.users.find((u) => u.email === email)!.userId;
    expect((await app.request(`/admin/users/${idOf('grace@dev.local')}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'grant' } }) })).status).toBe(200);
    const soon = new Date(Date.now() + 10 * 86400000).toISOString();
    expect((await app.request(`/admin/users/${idOf('heidi@dev.local')}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'set', startedAt: '2026-01-01T00:00:00Z', expiresAt: soon } }) })).status).toBe(200);
    expect((await app.request(`/admin/users/${idOf('ivan@dev.local')}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'set', startedAt: '2024-01-01T00:00:00Z', expiresAt: '2025-01-01T00:00:00Z' } }) })).status).toBe(200);
    const overview = await json<ClubOwnerOverview>(await app.request('/admin/club-owners', { headers: as('alice') }));
    const row = (email: string) => overview.owners.find((o) => o.user.email === email)!;
    expect(row('frank@dev.local').standing).toBe('active');
    expect(row('grace@dev.local').standing).toBe('active');
    expect(row('heidi@dev.local')).toMatchObject({ standing: 'expiring' });
    expect(row('heidi@dev.local').daysLeft).toBeLessThanOrEqual(10);
    expect(row('ivan@dev.local').standing).toBe('expired');
    expect(row('ivan@dev.local').daysLeft).toBeLessThan(-600);
    const order = overview.owners.map((o) => o.standing);
    expect(order.indexOf('expired')).toBeLessThan(order.indexOf('expiring'));
    expect(order.indexOf('expiring')).toBeLessThan(order.indexOf('active'));
    expect(overview.owners.every((o) => o.user.role === 'club_owner' || o.user.subscription)).toBe(true);
    expect(row('grace@dev.local').lastPayment).toMatchObject({ amountCents: 0, source: 'grant', ref: `admin:${idOf('alice@dev.local')}` });
    expect(row('frank@dev.local').lastPayment).toMatchObject({ ref: 'in_renew', source: 'stripe' });
    expect(overview.payments.filter((p) => p.userId === idOf('grace@dev.local'))).toHaveLength(1);
    expect((await json<ClubOwnerStatus>(await app.request('/club-owner', { headers: as('grace') }))).payments[0]).toMatchObject({ source: 'grant', amountCents: 0 });

    // Grace days: a year a day past its end is closed — unless the admin allows grace; then it is open and flagged "expiring" to act on.
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    await app.request(`/admin/users/${idOf('heidi@dev.local')}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'set', startedAt: '2025-11-01T00:00:00Z', expiresAt: yesterday } }) });
    expect((await json<{ user: { canPublish: boolean } }>(await app.request('/me', { headers: as('heidi') }))).user.canPublish).toBe(false);
    expect((await app.request('/publishing/destinations', { headers: as('heidi') })).status).toBe(403);
    await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ graceDays: 7 }) });
    const graced = await json<{ user: { canPublish: boolean; subscription: { status: string } } }>(await app.request('/me', { headers: as('heidi') }));
    expect(graced.user.canPublish).toBe(true);
    expect(graced.user.subscription.status).toBe('active');
    expect((await app.request('/publishing/destinations', { headers: as('heidi') })).status).toBe(200);
    const flagged = await json<ClubOwnerOverview>(await app.request('/admin/club-owners', { headers: as('alice') }));
    expect(flagged.owners.find((o) => o.user.email === 'heidi@dev.local')).toMatchObject({ standing: 'expiring', daysLeft: -1 });
    await app.request('/admin/club-owners/settings', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ graceDays: 0 }) });
    expect((await json<{ user: { canPublish: boolean } }>(await app.request('/me', { headers: as('heidi') }))).user.canPublish).toBe(false);
    // Revoked: closed whatever the dates, and the overview says so; a revoke is no payment.
    const paymentsBefore = (await json<ClubOwnerOverview>(await app.request('/admin/club-owners', { headers: as('alice') }))).payments.length;
    await app.request(`/admin/users/${idOf('grace@dev.local')}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'revoke' } }) });
    const after = await json<ClubOwnerOverview>(await app.request('/admin/club-owners', { headers: as('alice') }));
    expect(after.owners.find((o) => o.user.email === 'grace@dev.local')!.standing).toBe('revoked');
    expect(after.payments.length).toBe(paymentsBefore);
    delete deps.billing;
    resetPriceCache();
  });

  it('roles: a new account is dual; the super admin sees every account, sets roles and club owner subscriptions; Publishing opens with the subscription and closes by itself at its expiry; the last super admin stays', async () => {
    // Everyone so far: alice (the first account: super admin), bob, carol, erin…
    const me = await json<{ user: { role: string; media: string; subscription: unknown; canPublish: boolean; publishingNote: string } }>(await app.request('/me', { headers: as('bob') }));
    expect(me.user).toMatchObject({ role: 'dual', media: 'dual', canPublish: false });
    expect(me.user.publishingNote).toMatch(/club owners/);
    expect((await json<{ user: { role: string } }>(await app.request('/me', { headers: as('alice') }))).user.role).toBe('super_admin');
    // The Admin page is the super admin's alone.
    expect((await app.request('/admin/users', { headers: as('bob') })).status).toBe(403);
    const all = await json<{ users: { userId: string; role: string; email: string }[]; total: number }>(await app.request('/admin/users', { headers: as('alice') }));
    expect(all.total).toBe(all.users.length);
    const bobId = all.users.find((u) => u.email === 'bob@dev.local')!.userId;
    const carolId = all.users.find((u) => u.email === 'carol@dev.local')!.userId;
    expect((await app.request(`/admin/users/${bobId}`, { method: 'PATCH', headers: as('bob'), body: JSON.stringify({ role: 'super_admin' }) })).status).toBe(403);
    // Audio only: the account's media permission follows, and a meet's participant carries it.
    const audio = await json<{ user: { role: string; media: string } }>(await app.request(`/admin/users/${bobId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'audio' }) }));
    expect(audio.user).toMatchObject({ role: 'audio', media: 'audio' });
    const m = await json<{ meet: { meetId: string } }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Roles', trackId: 'trk-1', trackTitle: 'Song' }) }));
    const joined = await json<{ you: { media: string } }>(await app.request(`/meets/${m.meet.meetId}/join`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ role: 'performer' }) }));
    expect(joined.you.media).toBe('audio');
    expect((await app.request(`/admin/users/${bobId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'dual' }) })).status).toBe(200);
    expect((await app.request(`/admin/users/${bobId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'king' }) })).status).toBe(400);
    // A club owner's year: granted, Publishing opens; the dates set to the past, it closes by itself; renewed, it opens for a year on.
    const granted = await json<{ user: { role: string; canPublish: boolean; subscription: { startedAt: string; expiresAt: string; status: string } } }>(await app.request(`/admin/users/${carolId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'grant' } }) }));
    expect(granted.user.role).toBe('club_owner'); // a subscription makes a club owner of a singer
    expect(granted.user.canPublish).toBe(true);
    expect(granted.user.subscription.status).toBe('active');
    const year = Date.parse(granted.user.subscription.expiresAt) - Date.parse(granted.user.subscription.startedAt);
    expect(Math.abs(year - 365.25 * 86400000)).toBeLessThan(2 * 86400000);
    expect((await app.request('/publishing/destinations', { headers: as('carol') })).status).toBe(200);
    expect((await app.request(`/meets/${m.meet.meetId}/join`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ role: 'publisher' }) })).status).toBe(200);
    const expired = await json<{ user: { canPublish: boolean; publishingNote: string; subscription: { status: string } } }>(await app.request(`/admin/users/${carolId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'set', startedAt: '2024-01-01T00:00:00Z', expiresAt: '2025-01-01T00:00:00Z' } }) }));
    expect(expired.user.canPublish).toBe(false);
    expect(expired.user.subscription.status).toBe('expired');
    expect(expired.user.publishingNote).toMatch(/expired on 2025-01-01/);
    const shut = await app.request('/publishing/destinations', { headers: as('carol') });
    expect(shut.status).toBe(403);
    expect((await json<{ code: string; error: string }>(shut)).error).toMatch(/expired/);
    expect((await app.request(`/meets/${m.meet.meetId}/join`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ role: 'publisher' }) })).status).toBe(403);
    const renewed = await json<{ user: { canPublish: boolean; subscription: { expiresAt: string; status: string } } }>(await app.request(`/admin/users/${carolId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'renew' } }) }));
    expect(renewed.user.canPublish).toBe(true);
    expect(Date.parse(renewed.user.subscription.expiresAt)).toBeGreaterThan(Date.now() + 360 * 86400000); // from now, since the old expiry had passed
    const revoked = await json<{ user: { canPublish: boolean; subscription: { status: string }; publishingNote: string } }>(await app.request(`/admin/users/${carolId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ subscription: { action: 'revoke' } }) }));
    expect(revoked.user.canPublish).toBe(false);
    expect(revoked.user.subscription.status).toBe('revoked');
    expect(revoked.user.publishingNote).toMatch(/revoked/);
    // A super admin publishes without any subscription; the last one cannot be demoted; a second one can be.
    expect((await app.request('/publishing/destinations', { headers: as('alice') })).status).toBe(200);
    const aliceId = all.users.find((u) => u.email === 'alice@dev.local')!.userId;
    expect((await app.request(`/admin/users/${aliceId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'dual' }) })).status).toBe(409);
    expect((await json<{ user: { role: string; canPublish: boolean } }>(await app.request(`/admin/users/${carolId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'super_admin' }) }))).user).toMatchObject({ role: 'super_admin', canPublish: true });
    expect((await app.request('/admin/users', { headers: as('carol') })).status).toBe(200);
    expect((await app.request(`/admin/users/${carolId}`, { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'dual' }) })).status).toBe(200);
    expect((await app.request('/admin/users', { headers: as('carol') })).status).toBe(403);
    expect((await app.request('/admin/users/nobody', { method: 'PATCH', headers: as('alice'), body: JSON.stringify({ role: 'dual' }) })).status).toBe(404);
    expect((await app.request(`/meets/${m.meet.meetId}/end`, { method: 'POST', headers: as('alice') })).status).toBe(200);
  });

  it('publishing: the plan (or an admin) only; keys are sealed and only hinted; jobs need enabled destinations', async () => {
    expect((await app.request('/publishing/destinations', { headers: as('bob') })).status).toBe(403);
    const list = await json<{ destinations: { kind: string; enabled: boolean }[] }>(await app.request('/publishing/destinations', { headers: as('alice') }));
    expect(list.destinations.map((d) => d.kind)).toEqual(['youtube', 'facebook', 'instagram', 'twitch', 'inhouse']);
    const noKey = await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true }) });
    expect(noKey.status).toBe(400);
    const yt = await json<{ destination: { keyHint: string; enabled: boolean } }>(
      await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, streamKey: 'abcd-efgh-1234' }) }),
    );
    expect(yt.destination.keyHint).toBe('…1234');
    expect(JSON.stringify(yt)).not.toContain('abcd-efgh');
    // The live link — where viewers watch on the platform: a bare handle becomes the channel's live page; kept across saves; cleared with ''.
    const linked = await json<{ destination: { watchUrl?: string; keyHint: string } }>(
      await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, watchUrl: '@AliceSings' }) }),
    );
    expect(linked.destination.watchUrl).toBe('https://www.youtube.com/@AliceSings/live');
    expect(linked.destination.keyHint).toBe('…1234'); // the key stays
    const kept = await json<{ destination: { watchUrl?: string } }>(await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true }) }));
    expect(kept.destination.watchUrl).toBe('https://www.youtube.com/@AliceSings/live');
    expect((await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, watchUrl: 'not a link' }) })).status).toBe(400);
    const listed = await json<{ destinations: { kind: string; watchUrl?: string }[] }>(await app.request('/publishing/destinations', { headers: as('alice') }));
    expect(listed.destinations.find((d) => d.kind === 'youtube')?.watchUrl).toBe('https://www.youtube.com/@AliceSings/live');
    const cleared = await json<{ destination: { watchUrl?: string } }>(await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, watchUrl: '' }) }));
    expect(cleared.destination.watchUrl).toBeUndefined();
    // A YouTube link of any shape becomes the page viewers open — a Studio dashboard link above all.
    const studio = await json<{ destination: { watchUrl?: string } }>(await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, watchUrl: 'https://studio.youtube.com/video/FTUbrBKUSvY/livestreaming' }) }));
    expect(studio.destination.watchUrl).toBe('https://www.youtube.com/watch?v=FTUbrBKUSvY');
    // YouTube run by the app: `auto` is kept across saves until set off.
    const auto = await json<{ destination: { auto?: boolean; keyHint: string } }>(await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, streamKey: 'made-by-the-app-5678', auto: true, watchUrl: '' }) }));
    expect(auto.destination.auto).toBe(true);
    expect(auto.destination.keyHint).toBe('…5678');
    expect((await json<{ destination: { auto?: boolean } }>(await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true }) }))).destination.auto).toBe(true);
    expect((await json<{ destination: { auto?: boolean } }>(await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, auto: false }) }))).destination.auto).toBeUndefined();
    const meet = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Show' }) }));
    const bad = await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['twitch'] }) });
    expect(bad.status).toBe(400);
    const job = await json<{ job: { jobId: string; state: string; watchUrl: string | null } }>(
      await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['youtube', 'inhouse'], title: 'Show' }) }),
    );
    expect(job.job.state).toBe('requested');
    expect(job.job.watchUrl).toBe(`/watch/${meet.meet.meetId}`);
    await app.request(`/publishing/jobs/${job.job.jobId}/stop`, { method: 'POST', headers: as('alice') });
    // The public pages the app made for a show (a YouTube broadcast of its own) and the broadcast to end on Stop ride on the job; nonsense is left off.
    const withLinks = await json<{ job: { links?: Record<string, string>; youtube?: { broadcastId: string; streamId: string } } }>(
      await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['youtube', 'inhouse'], title: 'Show', links: { youtube: 'https://www.youtube.com/watch?v=FTUbrBKUSvY', twitch: 'https://twitch.tv/x', inhouse: 'javascript:alert(1)' }, youtube: { broadcastId: 'FTUbrBKUSvY', streamId: 'hls1' } }) }),
    );
    expect(withLinks.job.links).toEqual({ youtube: 'https://www.youtube.com/watch?v=FTUbrBKUSvY' }); // only the show's own destinations, only https
    expect(withLinks.job.youtube).toEqual({ broadcastId: 'FTUbrBKUSvY', streamId: 'hls1' });
    const listedJobs = await json<{ jobs: { links?: Record<string, string>; youtube?: unknown }[] }>(await app.request('/publishing/jobs', { headers: as('alice') }));
    expect(listedJobs.jobs.some((j) => j.links?.youtube === 'https://www.youtube.com/watch?v=FTUbrBKUSvY' && j.youtube)).toBe(true); // kept, listed
    // A privileged account that is not the host publishes a meet only once it has joined it (its show view).
    const bobs = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('bob'), body: JSON.stringify({ title: "Bob's meet" }) }));
    const notIn = await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: bobs.meet.meetId, destinations: ['inhouse'] }) });
    expect(notIn.status).toBe(403);
    expect((await app.request(`/meets/${bobs.meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'publisher' }) })).status).toBe(200);
    const joined = await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: bobs.meet.meetId, destinations: ['inhouse'] }) });
    expect(joined.status).toBe(201);
    expect((await app.request('/publishing/jobs', { method: 'POST', headers: as('bob'), body: JSON.stringify({ meetId: bobs.meet.meetId, destinations: ['inhouse'] }) })).status).toBe(403); // bob is not privileged
  });

  it('live segments: kept for the portal, forwarded to YouTube with a playlist; the key decides live vs rejected', async () => {
    const meet = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Live show' }) }));
    const id = meet.meet.meetId;
    await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, streamKey: 'wxyz-9876' }) });
    const { job } = await json<{ job: { jobId: string } }>(await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: id, destinations: ['youtube', 'inhouse'], title: 'Show' }) }));
    // Not on yet.
    expect((await json<{ live: boolean }>(await app.request(`/watch/${id}/live`))).live).toBe(false);
    expect((await app.request(`/watch/${id}/live.m3u8`)).status).toBe(404);

    // YouTube is a fetch away: record what the service sends it.
    const sent: { url: string; method: string; type: string; body: string | Uint8Array }[] = [];
    const realFetch = globalThis.fetch;
    let youtubeStatus = 200;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      sent.push({ url: String(input), method: init?.method ?? 'GET', type: new Headers(init?.headers).get('content-type') ?? '', body: typeof body === 'string' ? body : new Uint8Array(body as ArrayBuffer) });
      return new Response('', { status: youtubeStatus });
    }) as typeof fetch;
    try {
      const seg = (n: number) => new Uint8Array([0x47, ...Array.from({ length: 187 }, (_, i) => (i + n) & 0xff)]);
      const put = (name: string, seq: number, bytes: Uint8Array, dur = 2000) => app.request(`/publishing/jobs/${job.jobId}/live/${name}?seq=${seq}&dur=${dur}`, { method: 'PUT', headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice', 'Content-Type': 'video/MP2T' }, body: bytes as unknown as BodyInit });
      expect((await put('bad name.ts', 0, seg(0))).status).toBe(400);
      expect((await put('s0.ts', 0, new Uint8Array([1, 2, 3]))).status).toBe(400); // not TS
      expect((await app.request(`/publishing/jobs/${job.jobId}/live/s0.ts?seq=0&dur=2000`, { method: 'PUT', headers: { 'X-Dev-User': 'bob', 'X-Dev-Name': 'bob' }, body: seg(0) as unknown as BodyInit })).status).toBe(403); // bob: not privileged
      const first = await json<{ job: { state: string; live: { segments: number; youtube: string } } }>(await put('s0.ts', 0, seg(0)));
      expect(first.job.state).toBe('live');
      expect(first.job.live.segments).toBe(1);
      // YouTube is sent the segment after the answer went out (its PUTs must never hold up the next segment): the verdict lands on the job then.
      expect(first.job.live.youtube).toBe('waiting');
      await drain();
      const verdict = (await json<{ jobs: { jobId: string; live: { youtube: string; youtubeNote: string } }[] }>(await app.request('/publishing/jobs', { headers: as('alice') }))).jobs.find((j) => j.jobId === job.jobId)!;
      expect(verdict.live.youtube).toBe('ok');
      expect(verdict.live.youtubeNote).toBe('YouTube is receiving the show');
      // Segment then playlist, to the key's ingest URL, the key never in the playlist body.
      expect(sent.map((x) => x.method)).toEqual(['PUT', 'PUT']);
      expect(sent[0]!.url).toContain('cid=wxyz-9876&copy=0&file=s0.ts');
      expect(sent[0]!.type).toBe('video/MP2T');
      expect(sent[1]!.url).toContain('file=live.m3u8');
      expect(sent[1]!.body).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      expect(sent[1]!.body).toContain('#EXTINF:2.000,\ns0.ts');
      await put('s1.ts', 1, seg(1));
      await drain();
      await put('s2.ts', 2, seg(2), 1900);
      await drain();
      expect(sent[5]!.body).toContain('#EXT-X-TARGETDURATION:2');
      // The next answer carries the verdict of the segment before it.
      const third = await json<{ job: { live: { youtube: string } } }>(await put('s3.ts', 3, seg(3)));
      expect(third.job.live.youtube).toBe('ok');
      await drain();

      // The portal: on, with a playlist of the kept segments and the bytes themselves.
      const status = await json<{ live: boolean; segments: number; playlistPath: string }>(await app.request(`/watch/${id}/live`));
      expect(status.live).toBe(true);
      expect(status.segments).toBe(4);
      expect(status.playlistPath).toBe(`/watch/${id}/live.m3u8`);
      const pl = await app.request(`/watch/${id}/live.m3u8`);
      expect(pl.headers.get('content-type')).toContain('mpegurl');
      const text = await pl.text();
      expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      expect(text).toContain('live/s3.ts');
      const bytes = new Uint8Array(await (await app.request(`/watch/${id}/live/s1.ts`)).arrayBuffer());
      expect(bytes).toEqual(seg(1));
      expect((await app.request(`/watch/${id}/live/nope.ts`)).status).toBe(404);
      // The rolling window: after 14 segments only the last LIVE_KEEP (12) remain, the sequence moves on.
      for (let i = 4; i < 14; i++) await put(`s${i}.ts`, i, seg(i));
      await drain();
      const later = await (await app.request(`/watch/${id}/live.m3u8`)).text();
      expect(later).toContain(`#EXT-X-MEDIA-SEQUENCE:${14 - LIVE_KEEP}`);
      expect(later).not.toContain('live/s1.ts');
      expect((await app.request(`/watch/${id}/live/s1.ts`)).status).toBe(404);

      // The publisher started over (seq from 0 again): the earlier run's segments go, the playlist starts afresh.
      await put('r0.ts', 0, seg(20));
      const restarted = await (await app.request(`/watch/${id}/live.m3u8`)).text();
      expect(restarted).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      expect(restarted).not.toContain('live/s9.ts');
      for (let i = 1; i < 11; i++) await put(`r${i}.ts`, i, seg(20 + i));
      await drain();
      // A wrong key: YouTube answers 401 → rejected, the job carries the reason, the portal keeps playing.
      youtubeStatus = 401;
      await put('r11.ts', 11, seg(31));
      await drain();
      const rejected = (await json<{ jobs: { jobId: string; state: string; error: string | null; live: { youtube: string } }[] }>(await app.request('/publishing/jobs', { headers: as('alice') }))).jobs.find((j) => j.jobId === job.jobId)!;
      expect(rejected.live.youtube).toBe('rejected');
      expect(rejected.error).toContain('stream key');
      expect(rejected.state).toBe('live');
      expect((await json<{ live: boolean }>(await app.request(`/watch/${id}/live`))).live).toBe(true);

      // Stop: segments gone, the portal off, no more segments accepted.
      await app.request(`/publishing/jobs/${job.jobId}/stop`, { method: 'POST', headers: as('alice') });
      expect((await json<{ live: boolean }>(await app.request(`/watch/${id}/live`))).live).toBe(false);
      expect((await put('r12.ts', 12, seg(32))).status).toBe(409);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('YouTube song tracks: nothing without the relay; with it, search and a fetch job go through the relay, the signer\'s own token with the job and never back out', async () => {
    deps.relay = undefined;
    expect(await json<{ available: boolean }>(await app.request('/yt', { headers: as('alice') }))).toMatchObject({ available: false });
    expect((await app.request('/yt/search?q=amma', { headers: as('alice') })).status).toBe(404);
    expect((await app.request('/yt/fetch', { method: 'POST', headers: as('alice'), body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', folderId: 'folder00000001', name: 'x' }) })).status).toBe(404);
    const calls: { url: string; method: string; auth: string; body: string }[] = [];
    deps.relay = {
      url: 'https://relay.test',
      secret: 'shh-relay',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') ?? '', body: typeof init?.body === 'string' ? init.body : '' });
        if (url.endsWith('/yt')) return Response.json({ available: true, ytdlp: '2025.11.12', note: '' });
        if (url.includes('/yt/search?q=')) return Response.json({ items: [{ id: 'dQw4w9WgXcQ', title: 'Amma karaoke', channel: 'K', durationMs: 213000, thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', views: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] });
        if (url.endsWith('/yt/fetch')) return Response.json({ job: { jobId: 'yt-1', state: 'queued', fraction: 0, note: 'starting', videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', startedAt: 'now' } }, { status: 202 });
        if (url.endsWith('/yt/jobs/yt-1')) return Response.json({ job: { jobId: 'yt-1', state: 'done', fraction: 1, note: 'done', videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', startedAt: 'now', result: { videoFileId: 'v1', audioFileId: 'a1' } } });
        return Response.json({ error: 'no such job' }, { status: 404 });
      }) as typeof fetch,
    };
    try {
      expect(await json<{ available: boolean; ytdlp: string }>(await app.request('/yt', { headers: as('alice') }))).toEqual({ available: true, ytdlp: '2025.11.12', note: '' });
      const found = await json<{ items: { id: string }[] }>(await app.request('/yt/search?q=amma%20karaoke', { headers: as('alice') }));
      expect(found.items.map((i) => i.id)).toEqual(['dQw4w9WgXcQ']);
      expect(calls.at(-1)!.url).toBe('https://relay.test/yt/search?q=amma%20karaoke');
      expect(calls.every((x) => x.auth === 'Bearer shh-relay')).toBe(true);
      expect((await json<{ items: unknown[] }>(await app.request('/yt/search?q=', { headers: as('alice') }))).items).toEqual([]);
      // A fetch: validated here, then the relay gets the ask with the singer's Google token (the request's bearer).
      expect((await app.request('/yt/fetch', { method: 'POST', headers: as('alice'), body: JSON.stringify({ videoId: 'nope', trackId: 'trk-y', folderId: 'folder00000001', name: 'x' }) })).status).toBe(400);
      expect((await app.request('/yt/fetch', { method: 'POST', headers: as('alice'), body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', folderId: 'short', name: 'x' }) })).status).toBe(400);
      const noToken = await app.request('/yt/fetch', { method: 'POST', headers: as('alice'), body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', folderId: 'folder00000001', name: 'x' }) });
      expect(noToken.status).toBe(400); // a dev identity carries no Google token — the files go into the singer's Drive
      const r = await app.request('/yt/fetch', { method: 'POST', headers: { ...as('alice'), Authorization: 'Bearer google-token-abc' }, body: JSON.stringify({ videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', folderId: 'folder00000001', name: 'Amma (karaoke)' }) });
      expect(r.status).toBe(202);
      const { job } = await json<{ job: { jobId: string; state: string } }>(r);
      expect(job).toMatchObject({ jobId: 'yt-1', state: 'queued' });
      expect('token' in job).toBe(false);
      const sent = JSON.parse(calls.at(-1)!.body) as Record<string, string>;
      expect(sent).toEqual({ videoId: 'dQw4w9WgXcQ', trackId: 'trk-y', folderId: 'folder00000001', name: 'Amma (karaoke)', token: 'google-token-abc' });
      const done = await json<{ job: { state: string; result: { videoFileId: string } } }>(await app.request('/yt/jobs/yt-1', { headers: as('alice') }));
      expect(done.job.state).toBe('done');
      expect(done.job.result.videoFileId).toBe('v1');
      expect((await app.request('/yt/jobs/yt-9', { headers: as('alice') })).status).toBe(404);
      expect((await app.request('/yt/jobs/not%20an%20id', { headers: as('alice') })).status).toBe(400);
    } finally {
      deps.relay = undefined;
    }
  });

  it('with the RTMP relay deployed: RTMP destinations stream through it (keys service-to-service only), YouTube skips HLS ingestion, a lost stream is started again, stop ends it', async () => {
    const calls: { url: string; method: string; auth: string; type: string; body: string | Uint8Array }[] = [];
    let answer: (url: string) => Response | Promise<Response> = () => Response.json({ ok: true });
    deps.relay = {
      url: 'https://relay.test/',
      secret: 'shh-relay',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        const body = init?.body;
        calls.push({ url: String(input), method: init?.method ?? 'GET', auth: h.get('authorization') ?? '', type: h.get('content-type') ?? '', body: typeof body === 'string' ? body : body ? new Uint8Array(body as ArrayBuffer) : '' });
        return answer(String(input));
      }) as typeof fetch,
    };
    const realFetch = globalThis.fetch;
    const outside: string[] = []; // anything the service would send elsewhere (YouTube's HLS ingestion must stay quiet)
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outside.push(String(input));
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      expect((await json<{ relay: boolean }>(await app.request('/publishing/destinations', { headers: as('alice') }))).relay).toBe(true);
      await app.request('/publishing/destinations/youtube', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, streamKey: 'yt-key-0002' }) });
      await app.request('/publishing/destinations/facebook', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, streamKey: 'fb-key-0001' }) });
      const meet = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Relayed show' }) }));
      const made = await json<{ job: { jobId: string; live: { relay: string }; events: { note: string }[] } }>(
        await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['youtube', 'facebook', 'inhouse'], title: 'Show' }) }),
      );
      const job = made.job;
      expect(job.live.relay).toBe('starting');
      expect(job.events[0]!.note).toContain('youtube, facebook, inhouse'); // all three are fed from the browser now
      expect(job.events[0]!.note).not.toContain('need the RTMP relay');
      const seg = (n: number) => new Uint8Array([0x47, ...Array.from({ length: 187 }, (_, i) => (i + n) & 0xff)]);
      const put = (name: string, seq: number, bytes: Uint8Array) => app.request(`/publishing/jobs/${job.jobId}/live/${name}?seq=${seq}&dur=2000`, { method: 'PUT', headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice', 'Content-Type': 'video/MP2T' }, body: bytes as unknown as BodyInit });
      const first = await json<{ job: { state: string; live: { relay: string; relayNote: string; youtube: string; youtubeNote: string } }; youtube: unknown }>(await put('s0.ts', 0, seg(0)));
      expect(first.job.state).toBe('live');
      expect(first.job.live.relay).toBe('ok');
      expect(first.job.live.relayNote).toContain('youtube, facebook');
      expect(first.job.live.youtube).toBe('ok'); // YouTube rides the relay…
      expect(first.job.live.youtubeNote).toContain('relay');
      expect(outside).toEqual([]); // …so its HLS ingestion is never called
      expect(outside).toEqual([]);
      // The relay saw: start (every target with its real key and ingest url, bearer secret), then the segment bytes.
      expect(calls.map((x) => x.url.replace(/^https:\/\/relay\.test\/streams\/[^/]+/, 'S'))).toEqual(['S/start', 'S/segments']);
      expect(calls[0]!.url).toBe(`https://relay.test/streams/${job.jobId}/start`);
      expect(calls.every((x) => x.auth === 'Bearer shh-relay')).toBe(true);
      const targets = (JSON.parse(calls[0]!.body as string) as { targets: { kind: string; url: string; key: string }[] }).targets;
      expect(targets).toEqual([
        { kind: 'youtube', url: 'rtmps://a.rtmps.youtube.com:443/live2', key: 'yt-key-0002' },
        { kind: 'facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', key: 'fb-key-0001' },
      ]);
      expect(calls[1]!.type).toBe('video/MP2T');
      expect(calls[1]!.body).toEqual(seg(0));
      // The job as the API returns it never carries a key.
      expect(JSON.stringify(first)).not.toContain('yt-key');
      expect(JSON.stringify(first)).not.toContain('fb-key');
      // The relay restarted and knows no such stream (404): the service starts it again and resends the segment.
      answer = (url) => (url.endsWith('/segments') && calls.filter((x) => x.url.endsWith('/segments')).length === 2 ? Response.json({ error: 'no stream — start it first' }, { status: 404 }) : Response.json({ ok: true }));
      const again = await json<{ job: { live: { relay: string } } }>(await put('s1.ts', 1, seg(1)));
      expect(again.job.live.relay).toBe('ok');
      expect(calls.slice(2).map((x) => x.url.split('/').pop())).toEqual(['segments', 'start', 'segments']);
      // ffmpeg died on the relay (502): reported, not fatal — the watch page keeps playing; the next segment tries again later.
      answer = (url) => (url.endsWith('/segments') ? Response.json({ error: 'ffmpeg is gone (exit 1): Connection refused' }, { status: 502 }) : Response.json({ ok: true }));
      const broken = await json<{ job: { state: string; live: { relay: string; relayNote: string; youtube: string } } }>(await put('s2.ts', 2, seg(2)));
      expect(broken.job.state).toBe('live');
      expect(broken.job.live.relay).toBe('error');
      expect(broken.job.live.relayNote).toContain('ffmpeg is gone');
      expect(broken.job.live.youtube).toBe('error');
      // Stop: the relay's stream is ended too.
      const stopped = await json<{ job: { live: { relay: string } } }>(await app.request(`/publishing/jobs/${job.jobId}/stop`, { method: 'POST', headers: as('alice') }));
      expect(stopped.job.live.relay).toBe('off');
      expect(calls.at(-1)!.url).toBe(`https://relay.test/streams/${job.jobId}/stop`);
      expect(outside).toEqual([]);
      // A segment still on its way when Stop lands (here: the relay's answer pending; in the browser's case its body still
      // arriving): the stop wins — the segment is refused, nothing of it is kept, the job stays stopped, the portal dark.
      answer = () => Response.json({ ok: true });
      const made2 = await json<{ job: { jobId: string } }>(await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['youtube', 'inhouse'], title: 'Show again' }) }));
      const job2 = made2.job;
      const put2 = (name: string, seq: number, bytes: Uint8Array) => app.request(`/publishing/jobs/${job2.jobId}/live/${name}?seq=${seq}&dur=2000`, { method: 'PUT', headers: { 'X-Dev-User': 'alice', 'X-Dev-Name': 'alice', 'Content-Type': 'video/MP2T' }, body: bytes as unknown as BodyInit });
      expect((await put2('t0.ts', 0, seg(10))).status).toBe(200);
      expect((await json<{ live: boolean }>(await app.request(`/watch/${meet.meet.meetId}/live`))).live).toBe(true);
      answer = (url) => (url.endsWith('/segments') ? Promise.resolve(app.request(`/publishing/jobs/${job2.jobId}/stop`, { method: 'POST', headers: as('alice') })).then(() => Response.json({ ok: true })) : Response.json({ ok: true }));
      const raced = await put2('t1.ts', 1, seg(11));
      expect(raced.status).toBe(409);
      expect((await json<{ code: string }>(raced)).code).toBe('not_live');
      expect((await json<{ live: boolean }>(await app.request(`/watch/${meet.meet.meetId}/live`))).live).toBe(false);
      expect((await app.request(`/watch/${meet.meet.meetId}/live.m3u8`)).status).toBe(404);
      const jobs = await json<{ jobs: { jobId: string; state: string }[] }>(await app.request('/publishing/jobs', { headers: as('alice') }));
      expect(jobs.jobs.find((j) => j.jobId === job2.jobId)?.state).toBe('stopped');
      expect((await put2('t2.ts', 2, seg(12))).status).toBe(409); // and the next one is refused outright
    } finally {
      globalThis.fetch = realFetch;
      deps.relay = undefined;
    }
  });
});
