/**
 * The life of a meet and of a broadcast, end to end on the service: nothing outlives what it belongs to, every end
 * is idempotent, and a device that goes without a word is settled in seconds — not a minute later.
 *
 * - A broadcast ends with its meet (the host's End meet, the idle expiry): stopped, its segments gone, the relay told.
 * - A broadcast whose show view went away (no segment for JOB_STALE_MS) or never began (JOB_UNSTARTED_MS) is ended by
 *   the sweep; a fresh one is left alone; ending one twice changes nothing.
 * - A device's `away` (the tab closing, the page reloading): heard from within the grace it keeps its slot; past it,
 *   the slot is cleared by itself and the room told — the usual minute of silence is not waited for.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JoinMeetResponse, Meet, MeetSnapshot, PublishJob } from '@singersvoice/protocol';
import { createApp, endJob, JOB_STALE_MS, JOB_UNSTARTED_MS, sweepJobs, sweepMeets, type AppDeps } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { SecretBox } from '../src/crypto.ts';
import { nodeSqliteDriver } from '../src/store/driver.ts';
import { openNodeSqlite } from '../src/store/node-sqlite.ts';
import { SqlStore } from '../src/store/sql.ts';

let app: ReturnType<typeof createApp>;
let deps: AppDeps;
/** What the service told the relay (RELAY_URL stood in for by a fetch that records). */
const relayCalls: string[] = [];

beforeAll(async () => {
  const db = await openNodeSqlite(':memory:');
  deps = {
    store: Object.assign(new SqlStore(nodeSqliteDriver(db)), { couponsRequiredDefault: false }),
    auth: createAuthenticator({ devAuth: true }),
    secrets: new SecretBox(''),
    runtime: 'node',
    allowedOrigins: [],
    privilegedEmails: [],
    version: 'test',
    relay: { url: 'http://relay.test', secret: 's' },
    background: (p) => void p.catch(() => undefined),
  };
  app = createApp(() => deps);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    relayCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

const as = (user: string) => ({ 'X-Dev-User': user, 'X-Dev-Name': user, 'Content-Type': 'application/json' });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

async function newMeet(host: string, title: string): Promise<Meet> {
  return (await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as(host), body: JSON.stringify({ title }) }))).meet;
}
async function join(meetId: string, user: string, role: 'audience' | 'performer' | 'publisher'): Promise<JoinMeetResponse> {
  return json<JoinMeetResponse>(await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as(user), body: JSON.stringify({ role }) }));
}
async function heartbeat(meetId: string, user: string, resumeToken: string): Promise<MeetSnapshot> {
  return json<MeetSnapshot>(await app.request(`/meets/${meetId}/heartbeat`, { method: 'POST', headers: as(user), body: JSON.stringify({ resumeToken, chatSince: 0 }) }));
}
async function publish(meetId: string, user: string): Promise<PublishJob> {
  return (await json<{ job: PublishJob }>(await app.request('/publishing/jobs', { method: 'POST', headers: as(user), body: JSON.stringify({ meetId, destinations: ['inhouse', 'twitch'], title: 'Show' }) }))).job;
}
async function jobNow(jobId: string, user: string): Promise<PublishJob> {
  const { jobs } = await json<{ jobs: PublishJob[] }>(await app.request('/publishing/jobs', { headers: as(user) }));
  return jobs.find((j) => j.jobId === jobId)!;
}

describe('the life of a meet and its broadcasts', () => {
  it('a broadcast ends with its meet: stopped with the reason, its segments gone, the relay told — and ending it again changes nothing', async () => {
    await app.request('/publishing/destinations/twitch', { method: 'PUT', headers: as('alice'), body: JSON.stringify({ enabled: true, streamKey: 'live_1234' }) });
    const meet = await newMeet('alice', 'Ends with its job');
    const host = await join(meet.meetId, 'alice', 'performer');
    const job = await publish(meet.meetId, 'alice');
    expect(job.state).toBe('requested');
    // A segment on the air: the job is live and holds a window.
    const seg = new Uint8Array(188 * 4);
    seg[0] = 0x47;
    const put = await app.request(`/publishing/jobs/${job.jobId}/live/sv-1.ts?seq=1&dur=2000`, { method: 'PUT', headers: { ...as('alice'), 'Content-Type': 'video/mp2t' }, body: seg });
    expect(put.status).toBe(200);
    expect((await deps.store.listLiveSegments(job.jobId)).length).toBe(1);
    expect((await deps.store.liveJobsForMeet(meet.meetId)).map((j) => j.jobId)).toEqual([job.jobId]);
    relayCalls.length = 0;
    // The host ends the meet.
    const stop = await app.request(`/meets/${meet.meetId}/stop`, { method: 'POST', headers: as('alice'), body: JSON.stringify({ resumeToken: host.resumeToken }) });
    expect(stop.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // the close hook runs after the write
    const after = await jobNow(job.jobId, 'alice');
    expect(after.state).toBe('stopped');
    expect(after.events.at(-1)?.note).toBe('The meet ended');
    expect(await deps.store.listLiveSegments(job.jobId)).toEqual([]);
    expect(await deps.store.liveJobsForMeet(meet.meetId)).toEqual([]);
    expect(relayCalls.some((c) => /stop|DELETE/.test(c))).toBe(true); // the RTMP streams are ended on the relay
    // Idempotent: a second end (Stop after the meet's end, a sweep) leaves it as it is.
    const events = after.events.length;
    await endJob(deps, after, 'Again');
    expect((await jobNow(job.jobId, 'alice')).events.length).toBe(events);
    expect((await app.request(`/publishing/jobs/${job.jobId}/stop`, { method: 'POST', headers: as('alice') })).status).toBe(200);
    expect((await jobNow(job.jobId, 'alice')).events.length).toBe(events);
  });

  it('the sweep ends a broadcast whose show view went quiet or never began, and leaves a fresh one alone', async () => {
    const meet = await newMeet('alice', 'Swept jobs');
    await join(meet.meetId, 'alice', 'performer');
    // Never began: requested long ago, no segment ever.
    const unstarted = await publish(meet.meetId, 'alice');
    expect(await sweepJobs(deps, Date.now())).toBe(0); // fresh: left alone
    expect(await sweepJobs(deps, Date.now() + JOB_UNSTARTED_MS + 1000)).toBe(1);
    expect((await jobNow(unstarted.jobId, 'alice')).state).toBe('stopped');
    expect((await jobNow(unstarted.jobId, 'alice')).events.at(-1)?.note).toMatch(/never started/);
    // Went quiet: a segment came, then nothing for JOB_STALE_MS.
    const quiet = await publish(meet.meetId, 'alice');
    const seg = new Uint8Array(188 * 4);
    seg[0] = 0x47;
    await app.request(`/publishing/jobs/${quiet.jobId}/live/sv-1.ts?seq=1&dur=2000`, { method: 'PUT', headers: { ...as('alice'), 'Content-Type': 'video/mp2t' }, body: seg });
    expect((await jobNow(quiet.jobId, 'alice')).state).toBe('live');
    expect(await sweepJobs(deps, Date.now() + JOB_STALE_MS / 2)).toBe(0);
    expect(await sweepJobs(deps, Date.now() + JOB_STALE_MS + 1000)).toBe(1);
    const ended = await jobNow(quiet.jobId, 'alice');
    expect(ended.state).toBe('stopped');
    expect(ended.events.at(-1)?.note).toMatch(/show view went away/);
    expect(await deps.store.listLiveSegments(quiet.jobId)).toEqual([]);
    // The meet sweep runs the job sweep too (the cron on Cloudflare, the timer on Node).
    const again = await publish(meet.meetId, 'alice');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + JOB_UNSTARTED_MS + 1000);
    await sweepMeets(deps.store, deps);
    vi.useRealTimers();
    expect((await jobNow(again.jobId, 'alice')).state).toBe('stopped');
  });

  it('away: a reload keeps its slot; a tab that closed is taken off the stage in seconds, and the room is told', async () => {
    const meet = await newMeet('alice', 'Away');
    const host = await join(meet.meetId, 'alice', 'performer');
    const bob = await join(meet.meetId, 'bob', 'performer');
    expect((await heartbeat(meet.meetId, 'alice', host.resumeToken)).meet.stage.filter((s) => s.participantId).length).toBe(2);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    // Bob's tab reloads: away, then back within the grace.
    expect((await app.request(`/meets/${meet.meetId}/away`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken }) })).status).toBe(200);
    vi.advanceTimersByTime(3000);
    await heartbeat(meet.meetId, 'bob', bob.resumeToken); // back
    vi.advanceTimersByTime(12_000);
    await vi.runOnlyPendingTimersAsync();
    expect((await heartbeat(meet.meetId, 'alice', host.resumeToken)).meet.stage.some((s) => s.participantId === bob.you.participantId)).toBe(true);
    // Bob's tab closes for good: away, and nothing more.
    await app.request(`/meets/${meet.meetId}/away`, { method: 'POST', headers: as('bob'), body: JSON.stringify({ resumeToken: bob.resumeToken }) });
    vi.advanceTimersByTime(12_000);
    await vi.runOnlyPendingTimersAsync();
    const snap = await heartbeat(meet.meetId, 'alice', host.resumeToken);
    expect(snap.meet.stage.some((s) => s.participantId === bob.you.participantId)).toBe(false);
    expect(snap.meet.performerCount).toBe(1);
    // Nothing else changed for the host; a token nobody holds is ignored; a beacon carries the token in the query and no sign-in at all (the browser sends it after the page is gone).
    expect(snap.you?.slot).not.toBeNull();
    expect((await app.request(`/meets/${meet.meetId}/away`, { method: 'POST', headers: as('carol'), body: JSON.stringify({ resumeToken: 'nobody' }) })).status).toBe(200);
    expect((await app.request(`/meets/${meet.meetId}/away?rt=${encodeURIComponent(host.resumeToken)}`, { method: 'POST' })).status).toBe(200);
    vi.advanceTimersByTime(12_000);
    await vi.runOnlyPendingTimersAsync();
    expect((await deps.store.getMeet(meet.meetId))!.stage.filter((s) => s.participantId).length).toBe(0); // the host's device went too: its slot cleared by the settle, nobody's heartbeat needed
  });
});
