/**
 * The storage budget of a running meet, and what the service does when the budget is spent.
 *
 * A SQLite-backed Durable Object on the free plan may write 100,000 rows a day (an index entry counts as a
 * row); the service used to spend them on heartbeats, mix batches and segments. These tests count the rows
 * node:sqlite reports changed — a lower bound for the Durable Object's own count (it adds index rows), so
 * the budgets here are tight: a minute of a seven-singer stage writes rows only for what actually changed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { JoinMeetResponse, Meet, MeetSnapshot } from '@singersvoice/protocol';
import { createApp, secondsToUtcMidnight, storageLimitNote, type AppDeps } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { SecretBox } from '../src/crypto.ts';
import { nodeSqliteDriver, type Driver } from '../src/store/driver.ts';
import { SOFT_FLUSH_MS } from '../src/store/live.ts';
import { openNodeSqlite } from '../src/store/node-sqlite.ts';
import { SqlStore } from '../src/store/sql.ts';

let app: ReturnType<typeof createApp>;
let deps: AppDeps;
let driver: Driver;
/** Flip to make every write fail the way the Durable Object does past its daily allowance. */
let failWrites = false;
const LIMIT_MESSAGE = 'Exceeded allowed rows written in Durable Objects free tier.';

beforeAll(async () => {
  const db = await openNodeSqlite(':memory:');
  const inner = nodeSqliteDriver(db);
  driver = {
    ...inner,
    stats: inner.stats,
    async run(sql, params) {
      if (failWrites && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
        inner.stats.lastError = { at: Date.now(), message: LIMIT_MESSAGE, write: true };
        throw new Error(LIMIT_MESSAGE);
      }
      return inner.run(sql, params);
    },
  };
  deps = {
    store: Object.assign(new SqlStore(driver), { couponsRequiredDefault: false }),
    auth: createAuthenticator({ devAuth: true }),
    secrets: new SecretBox(''),
    runtime: 'node',
    allowedOrigins: [],
    privilegedEmails: [],
    version: 'test',
  };
  app = createApp(() => deps);
});

const as = (user: string) => ({ 'X-Dev-User': user, 'X-Dev-Name': user, 'Content-Type': 'application/json', Origin: 'https://singersvoice.github.io' });
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const written = () => driver.stats.rowsWritten;

describe('the storage budget of a live meet', () => {
  it('seven singers on stage for a minute: heartbeats, clock reports, mix batches and signals write no rows; the expiry reaches the row once a minute', async () => {
    const created = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('host'), body: JSON.stringify({ title: 'Budget' }) }));
    const meetId = created.meet.meetId;
    const singers: JoinMeetResponse[] = [];
    for (const name of ['host', 's2', 's3', 's4', 's5', 's6', 's7']) singers.push(await json<JoinMeetResponse>(await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as(name), body: JSON.stringify({ role: 'performer' }) })));
    expect(singers.map((s) => s.you.slot)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const before = written();
    // A minute of heartbeats at three seconds each, every one with a clock report that moved.
    for (let round = 0; round < 20; round++) {
      for (const [i, s] of singers.entries()) {
        const r = await app.request(`/meets/${meetId}/heartbeat`, { method: 'POST', headers: as(i === 0 ? 'host' : `s${i + 1}`), body: JSON.stringify({ resumeToken: s.resumeToken, chatSince: 0, driftMs: round + i, rttMs: 40 + round }) });
        expect(r.status).toBe(200);
      }
    }
    expect(written() - before).toBe(0);
    // The host's device sends the mix a second at a time, and the mesh trades signals: memory, never rows.
    const mid = written();
    for (let i = 0; i < 60; i++) {
      const r = await app.request(`/meets/${meetId}/mix`, { method: 'POST', headers: as('host'), body: JSON.stringify({ resumeToken: singers[0]!.resumeToken, seq: i, atMs: i * 1000, codec: 'opus', sampleRate: 48000, channels: 1, packets: [{ ts: 0, b64: 'AAAA' }] }) });
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 30; i++) {
      const from = singers[i % 7]!;
      const to = singers[(i + 1) % 7]!;
      const r = await app.request(`/meets/${meetId}/signal`, { method: 'POST', headers: as(i % 7 === 0 ? 'host' : `s${(i % 7) + 1}`), body: JSON.stringify({ resumeToken: from.resumeToken, to: to.you.participantId, type: 'ice', data: '{"candidate":"x"}' }) });
      expect(r.status).toBe(200);
    }
    expect(written() - mid).toBe(0);
    const sigs = await json<{ signals: unknown[] }>(await app.request(`/meets/${meetId}/signals`, { method: 'POST', headers: as('s2'), body: JSON.stringify({ resumeToken: singers[1]!.resumeToken, since: 0 }) }));
    expect(sigs.signals.length).toBeGreaterThan(0);
    const mix = await json<{ batches: unknown[]; latest: number }>(await app.request(`/watch/${meetId}/mix?since=55`));
    expect(mix.latest).toBe(60);
    expect(mix.batches.length).toBe(5);
    // What a heartbeat moved (the idle expiry) reaches the row at the flush — one row for the meet, once a minute.
    const flushBefore = written();
    expect(await deps.store.flush(Date.now())).toBe(0); // not due yet
    expect(await deps.store.flush(Date.now() + SOFT_FLUSH_MS + 1)).toBe(1);
    expect(written() - flushBefore).toBe(1);
    // A real change — a singer steps off — is a row at once (the participant and the meet).
    const stepOff = written();
    await app.request(`/meets/${meetId}/slot`, { method: 'POST', headers: as('s7'), body: JSON.stringify({ resumeToken: singers[6]!.resumeToken, slot: null }) });
    expect(written() - stepOff).toBe(2);
    await app.request(`/meets/${meetId}/end`, { method: 'POST', headers: as('host') });
  });

  it('a restart mid-meet loses nobody: the meet comes back open with its people, who have a minute to be heard from', async () => {
    const created = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('host'), body: JSON.stringify({ title: 'Restart' }) }));
    const meetId = created.meet.meetId;
    const host = await json<JoinMeetResponse>(await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as('host'), body: JSON.stringify({ role: 'performer' }) }));
    const s2 = await json<JoinMeetResponse>(await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as('s2'), body: JSON.stringify({ role: 'performer' }) }));
    // Time passes: heartbeats keep the meet alive in memory, the row sees a flush now and then.
    const later = Date.now() + 4 * 60_000;
    await deps.store.flush(later, true);
    // The object is evicted (or the service restarted): a fresh store over the same rows.
    const fresh = new SqlStore(driver);
    await fresh.migrate();
    const meet = (await fresh.getMeet(meetId))!;
    expect(meet.state).toBe('lobby');
    expect(Date.parse(meet.expiresAt)).toBeGreaterThan(Date.parse(created.meet.expiresAt)); // what the row had, plus the flush's grace
    const people = await fresh.listParticipants(meetId);
    expect(people.map((p) => p.participantId).sort()).toEqual([host.you.participantId, s2.you.participantId].sort());
    for (const p of people) expect(Date.now() - Date.parse(p.lastSeenAt)).toBeLessThan(5000); // seen at the restart: a minute to be heard from
    expect((await fresh.getParticipantByToken(meetId, s2.resumeToken))?.slot).toBe(2);
    await app.request(`/meets/${meetId}/end`, { method: 'POST', headers: as('host') });
  });

  it("the budget spent: reads still answer, /health says writes fail, a write is a 503 'storage_limit' with CORS headers and a Retry-After — never 'unreachable'", async () => {
    const created = await json<{ meet: Meet }>(await app.request('/meets', { method: 'POST', headers: as('host'), body: JSON.stringify({ title: 'Spent' }) }));
    const meetId = created.meet.meetId;
    const host = await json<JoinMeetResponse>(await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as('host'), body: JSON.stringify({ role: 'performer' }) }));
    failWrites = true;
    try {
      // A join is a write: refused plainly, with the headers a browser needs to read the refusal.
      const r = await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as('s2'), body: JSON.stringify({ role: 'performer' }) });
      expect(r.status).toBe(503);
      expect(r.headers.get('access-control-allow-origin')).toBe('https://singersvoice.github.io');
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
      const body = await json<{ code: string; error: string; retryAfterS: number }>(r);
      expect(body.code).toBe('storage_limit');
      expect(body.error).toMatch(/cannot save anything more today/);
      expect(body.error).toMatch(/00:00 UTC/);
      // A heartbeat of someone already in writes nothing: it still answers, and the meet is still open.
      const hb = await app.request(`/meets/${meetId}/heartbeat`, { method: 'POST', headers: as('host'), body: JSON.stringify({ resumeToken: host.resumeToken, chatSince: 0 }) });
      expect(hb.status).toBe(200);
      expect((await json<MeetSnapshot>(hb)).meet.state).toBe('lobby');
      // Reads answer; /health says what is wrong.
      expect((await app.request(`/meets/${meetId}`, { headers: as('host') })).status).toBe(200);
      const health = await json<{ ok: boolean; storage: { writes: string; note: string; rowsWritten: number } }>(await app.request('/health'));
      expect(health.ok).toBe(true);
      expect(health.storage.writes).toBe('failing');
      expect(health.storage.note).toBe(LIMIT_MESSAGE);
      expect(health.storage.rowsWritten).toBeGreaterThan(0);
    } finally {
      failWrites = false;
    }
    // The budget back (a new day): writes go through again, nothing had to restart.
    const r = await app.request(`/meets/${meetId}/join`, { method: 'POST', headers: as('s2'), body: JSON.stringify({ role: 'performer' }) });
    expect(r.status).toBe(200);
    const health = await json<{ storage: { writes: string } }>(await app.request('/health'));
    expect(health.storage.writes).toBe('failing'); // for the minute after the last failure — then 'ok'
    await app.request(`/meets/${meetId}/end`, { method: 'POST', headers: as('host') });
  });

  it('the words for a spent budget: until 00:00 UTC, in hours and minutes, nothing lost', () => {
    const at = Date.UTC(2026, 10, 21, 19, 30); // 19:30 UTC → 4 h 30 min to midnight
    expect(secondsToUtcMidnight(at)).toBe(4.5 * 3600);
    expect(storageLimitNote(LIMIT_MESSAGE, 4.5 * 3600)).toBe('The SingersVoice service cannot save anything more today — its daily storage allowance is spent. It starts over at 00:00 UTC (in 4 h 30 min). Nothing already saved is lost.');
    expect(storageLimitNote('Exceeded allowed rows read in Durable Objects free tier.', 600)).toMatch(/cannot read anything more today .* \(in 10 min\)/);
  });
});
