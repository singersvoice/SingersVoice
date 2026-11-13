import { beforeAll, describe, expect, it } from 'vitest';
import type { CatalogListResponse, JoinMeetResponse, Meet, MeetSnapshot } from '@singersvoice/protocol';
import { createApp, type AppDeps } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { SecretBox } from '../src/crypto.ts';
import { nodeSqliteDriver } from '../src/store/driver.ts';
import { openNodeSqlite } from '../src/store/node-sqlite.ts';
import { SqlStore } from '../src/store/sql.ts';

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const db = await openNodeSqlite(':memory:');
  const deps: AppDeps = {
    store: new SqlStore(nodeSqliteDriver(db)),
    auth: createAuthenticator({ devAuth: true }),
    secrets: new SecretBox(''),
    runtime: 'node',
    allowedOrigins: [],
    privilegedEmails: [],
    version: 'test',
  };
  app = createApp(() => deps);
});

const as = (user: string) => ({ 'X-Dev-User': user, 'X-Dev-Name': user, 'Content-Type': 'application/json' });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

describe('sv-control API', () => {
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

    // Everyone enters as audience: bob asks to sing, the host (admin) lets him on; the stage policy can be opened.
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

    await app.request(`/meets/${meet.meetId}/chat`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, text: 'ready!' }) });
    const hb = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/heartbeat`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, chatSince: 0, driftMs: 12, rttMs: 80 }) }));
    expect(hb.chat.map((m) => m.text)).toEqual(['ready!']);
    expect(hb.meet.stage[0]!.driftMs).toBe(12);

    const notHost = await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, leadMs: 5000 }) });
    expect(notHost.status).toBe(403);
    // The set list: the meet was created with a title only; bob (on stage) picks the first song, alice queues another.
    const noSong = await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 5000 }) });
    expect((await json<{ code: string }>(noSong)).code).toBe('no_song');
    const picked = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, song: { trackId: 'trk-1', catalogTrackId: 'trk-1', trackTitle: 'Amma', durationMs: 283000 } }) }));
    expect(picked.meet).toMatchObject({ trackTitle: 'Amma', catalogTrackId: 'trk-1' });
    const queued = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, song: { trackId: 'trk-2', catalogTrackId: null, trackTitle: 'Next one' } }) }));
    expect(queued.meet.setList.map((e) => e.trackTitle)).toEqual(['Next one']);
    expect((await app.request(`/meets/${meet.meetId}/songs/${queued.meet.setList[0]!.id}`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, action: 'up' }) })).status).toBe(403);
    expect((await app.request(`/meets/${meet.meetId}/songs/nope`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, action: 'remove' }) })).status).toBe(404);
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

    // Song over (host): back to the lobby with the next song up; the stage stays as it was.
    expect((await app.request(`/meets/${meet.meetId}/songs/next`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken }) })).status).toBe(403);
    const over = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/songs/next`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken }) }));
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

  it('publishing: privileged only; keys are sealed and only hinted; jobs need enabled destinations', async () => {
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
    const meet = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Show' }) }));
    const bad = await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['twitch'] }) });
    expect(bad.status).toBe(400);
    const job = await json<{ job: { state: string; watchUrl: string | null } }>(
      await app.request('/publishing/jobs', { method: 'POST', headers: as('alice'), body: JSON.stringify({ meetId: meet.meet.meetId, destinations: ['youtube', 'inhouse'], title: 'Show' }) }),
    );
    expect(job.job.state).toBe('requested');
    expect(job.job.watchUrl).toBe(`/watch/${meet.meet.meetId}`);
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
      const first = await json<{ job: { state: string; live: { segments: number; youtube: string } }; youtube: { status: number } | null }>(await put('s0.ts', 0, seg(0)));
      expect(first.job.state).toBe('live');
      expect(first.job.live.segments).toBe(1);
      expect(first.job.live.youtube).toBe('ok');
      expect(first.youtube?.status).toBe(200);
      // Segment then playlist, to the key's ingest URL, the key never in the playlist body.
      expect(sent.map((x) => x.method)).toEqual(['PUT', 'PUT']);
      expect(sent[0]!.url).toContain('cid=wxyz-9876&copy=0&file=s0.ts');
      expect(sent[0]!.type).toBe('video/MP2T');
      expect(sent[1]!.url).toContain('file=live.m3u8');
      expect(sent[1]!.body).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      expect(sent[1]!.body).toContain('#EXTINF:2.000,\ns0.ts');
      await put('s1.ts', 1, seg(1));
      await put('s2.ts', 2, seg(2), 1900);
      expect(sent[5]!.body).toContain('#EXT-X-TARGETDURATION:2');

      // The portal: on, with a playlist of the kept segments and the bytes themselves.
      const status = await json<{ live: boolean; segments: number; playlistPath: string }>(await app.request(`/watch/${id}/live`));
      expect(status.live).toBe(true);
      expect(status.segments).toBe(3);
      expect(status.playlistPath).toBe(`/watch/${id}/live.m3u8`);
      const pl = await app.request(`/watch/${id}/live.m3u8`);
      expect(pl.headers.get('content-type')).toContain('mpegurl');
      const text = await pl.text();
      expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      expect(text).toContain('live/s2.ts');
      const bytes = new Uint8Array(await (await app.request(`/watch/${id}/live/s1.ts`)).arrayBuffer());
      expect(bytes).toEqual(seg(1));
      expect((await app.request(`/watch/${id}/live/nope.ts`)).status).toBe(404);
      // The rolling window: after 10 segments only the last 8 remain, the sequence moves on.
      for (let i = 3; i < 10; i++) await put(`s${i}.ts`, i, seg(i));
      const later = await (await app.request(`/watch/${id}/live.m3u8`)).text();
      expect(later).toContain('#EXT-X-MEDIA-SEQUENCE:2');
      expect(later).not.toContain('live/s1.ts');
      expect((await app.request(`/watch/${id}/live/s1.ts`)).status).toBe(404);

      // The publisher started over (seq from 0 again): the earlier run's segments go, the playlist starts afresh.
      await put('r0.ts', 0, seg(20));
      const restarted = await (await app.request(`/watch/${id}/live.m3u8`)).text();
      expect(restarted).toContain('#EXT-X-MEDIA-SEQUENCE:0');
      expect(restarted).not.toContain('live/s9.ts');
      for (let i = 1; i < 11; i++) await put(`r${i}.ts`, i, seg(20 + i));
      // A wrong key: YouTube answers 401 → rejected, the job carries the reason, the portal keeps playing.
      youtubeStatus = 401;
      const rejected = await json<{ job: { state: string; error: string | null; live: { youtube: string } } }>(await put('r11.ts', 11, seg(31)));
      expect(rejected.job.live.youtube).toBe('rejected');
      expect(rejected.job.error).toContain('stream key');
      expect(rejected.job.state).toBe('live');
      expect((await json<{ live: boolean }>(await app.request(`/watch/${id}/live`))).live).toBe(true);

      // Stop: segments gone, the portal off, no more segments accepted.
      await app.request(`/publishing/jobs/${job.jobId}/stop`, { method: 'POST', headers: as('alice') });
      expect((await json<{ live: boolean }>(await app.request(`/watch/${id}/live`))).live).toBe(false);
      expect((await put('r12.ts', 12, seg(32))).status).toBe(409);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
