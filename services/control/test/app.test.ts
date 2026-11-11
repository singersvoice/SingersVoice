import { beforeAll, describe, expect, it } from 'vitest';
import type { CatalogListResponse, JoinMeetResponse, Meet, MeetSnapshot } from '@singersvoice/protocol';
import { createApp, type AppDeps } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { SecretBox } from '../src/crypto.ts';
import { nodeSqliteDriver, openNodeSqlite } from '../src/store/driver.ts';
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
    const created = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('alice'), body: JSON.stringify({ title: 'Sunday meet', trackTitle: 'AA' }) }));
    const meet = created.meet;
    expect(meet.joinCode).toHaveLength(6);
    const byCode = await json<{ meet: Meet }>(await app.request(`/meets/code/${meet.joinCode.toLowerCase()}`, { headers: as('bob') }));
    expect(byCode.meet.meetId).toBe(meet.meetId);

    const host = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ role: 'performer' }) }));
    expect(host.you.role).toBe('performer');
    expect(host.you.slot).toBe(1);
    const bob = await json<JoinMeetResponse>(await app.request(`/meets/${meet.meetId}/join`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ role: 'audience' }) }));
    expect(bob.you.slot).toBeNull();

    const taken = await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, slot: 1 }) });
    expect(taken.status).toBe(409);
    const ok = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/slot`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, slot: 2 }) }));
    expect(ok.meet.performerCount).toBe(2);

    await app.request(`/meets/${meet.meetId}/chat`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, text: 'ready!' }) });
    const hb = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/heartbeat`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, chatSince: 0, driftMs: 12, rttMs: 80 }) }));
    expect(hb.chat.map((m) => m.text)).toEqual(['ready!']);
    expect(hb.meet.stage[0]!.driftMs).toBe(12);

    const notHost = await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken, leadMs: 5000 }) });
    expect(notHost.status).toBe(403);
    const started = await json<MeetSnapshot>(await app.request(`/meets/${meet.meetId}/start`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken, leadMs: 5000 }) }));
    expect(started.meet.state).toBe('countdown');
    expect(started.meet.kickstartEpochMs! - Date.now()).toBeGreaterThan(4000);

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
  });
});
