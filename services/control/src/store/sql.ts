/** The SVT DB store: users, public track catalog, meets, participants, chat, recordings, publishing. */
import { LIVE_KEEP, MIX_KEEP, type CatalogTrack, type ChatMessage, type Destination, type Meet, type MeetPerformance, type MeetRecording, type LiveSegmentInfo, type MeetSignal, type MixBatch, type Participant, type PublishJob, type UserRecord } from '@singersvoice/protocol';
import type { Driver } from './driver.ts';
import { SCHEMA_SQL } from './schema.ts';

export interface StoredParticipant extends Participant {
  meetId: string;
  resumeToken: string;
}

export interface StoredDestination extends Destination {
  keyEnc: string;
}

export class SqlStore {
  private ready: Promise<void> | null = null;
  private db: Driver;

  constructor(db: Driver) {
    this.db = db;
  }

  migrate(): Promise<void> {
    if (!this.ready) this.ready = this.db.exec(SCHEMA_SQL);
    return this.ready;
  }

  // ---------- users ----------

  async upsertUser(u: Omit<UserRecord, 'createdAt' | 'lastSeenAt' | 'privileged'> & { privileged?: boolean }): Promise<UserRecord> {
    const now = new Date().toISOString();
    const existing = await this.getUser(u.userId);
    if (existing) {
      const privileged = u.privileged ?? existing.privileged;
      await this.db.run('UPDATE users SET email=?, name=?, picture=?, privileged=?, last_seen_at=? WHERE user_id=?', [
        u.email || existing.email,
        u.name || existing.name,
        u.picture || existing.picture,
        privileged ? 1 : 0,
        now,
        u.userId,
      ]);
      return { ...existing, email: u.email || existing.email, name: u.name || existing.name, picture: u.picture || existing.picture, privileged, lastSeenAt: now };
    }
    const count = await this.countUsers();
    // The very first account becomes privileged (bootstrap admin) unless told otherwise.
    const privileged = u.privileged ?? count === 0;
    await this.db.run('INSERT INTO users (user_id, email, name, picture, privileged, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)', [
      u.userId,
      u.email,
      u.name,
      u.picture,
      privileged ? 1 : 0,
      now,
      now,
    ]);
    return { userId: u.userId, email: u.email, name: u.name, picture: u.picture, privileged, createdAt: now, lastSeenAt: now };
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const r = await this.db.get<{ user_id: string; email: string; name: string; picture: string; privileged: number; created_at: string; last_seen_at: string }>(
      'SELECT * FROM users WHERE user_id=?',
      [userId],
    );
    return r ? { userId: r.user_id, email: r.email, name: r.name, picture: r.picture, privileged: !!r.privileged, createdAt: r.created_at, lastSeenAt: r.last_seen_at } : null;
  }

  async setPrivileged(userId: string, privileged: boolean): Promise<void> {
    await this.db.run('UPDATE users SET privileged=? WHERE user_id=?', [privileged ? 1 : 0, userId]);
  }

  async countUsers(): Promise<number> {
    const r = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return Number(r?.n ?? 0);
  }

  // ---------- catalog ----------

  async publishTrack(t: CatalogTrack): Promise<CatalogTrack> {
    const search = `${t.title} ${t.artist} ${t.genre} ${t.language} ${t.ownerName}`.toLowerCase();
    const existing = await this.getCatalogTrack(t.trackId);
    if (existing) {
      const merged = { ...t, publishedAt: existing.publishedAt, pulls: existing.pulls };
      await this.db.run('UPDATE catalog_tracks SET data=?, search=? WHERE track_id=?', [JSON.stringify(merged), search, t.trackId]);
      return merged;
    }
    await this.db.run('INSERT INTO catalog_tracks (track_id, owner_user_id, data, search, published_at, pulls) VALUES (?,?,?,?,?,0)', [
      t.trackId,
      t.ownerUserId,
      JSON.stringify(t),
      search,
      t.publishedAt,
    ]);
    return t;
  }

  async unpublishTrack(trackId: string, ownerUserId: string): Promise<boolean> {
    const t = await this.getCatalogTrack(trackId);
    if (!t || t.ownerUserId !== ownerUserId) return false;
    await this.db.run('DELETE FROM catalog_tracks WHERE track_id=?', [trackId]);
    return true;
  }

  async getCatalogTrack(trackId: string): Promise<CatalogTrack | null> {
    const r = await this.db.get<{ data: string; pulls: number }>('SELECT data, pulls FROM catalog_tracks WHERE track_id=?', [trackId]);
    return r ? { ...(JSON.parse(r.data) as CatalogTrack), pulls: Number(r.pulls) } : null;
  }

  async listCatalog(q: string, offset: number, limit: number, ownerUserId?: string): Promise<{ items: CatalogTrack[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    // Every word of the query must appear (in the title, artist, genre, language or owner), in any order.
    for (const word of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("search LIKE ? ESCAPE '\\'");
      params.push(`%${word.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    }
    if (ownerUserId) {
      where.push('owner_user_id=?');
      params.push(ownerUserId);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM catalog_tracks ${w}`, params))?.n ?? 0);
    const rows = await this.db.all<{ data: string; pulls: number }>(`SELECT data, pulls FROM catalog_tracks ${w} ORDER BY published_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { items: rows.map((r) => ({ ...(JSON.parse(r.data) as CatalogTrack), pulls: Number(r.pulls) })), total };
  }

  async countPull(trackId: string): Promise<number> {
    await this.db.run('UPDATE catalog_tracks SET pulls = pulls + 1 WHERE track_id=?', [trackId]);
    return Number((await this.db.get<{ pulls: number }>('SELECT pulls FROM catalog_tracks WHERE track_id=?', [trackId]))?.pulls ?? 0);
  }

  // ---------- meets ----------

  async createMeet(m: Meet): Promise<void> {
    await this.db.run('INSERT INTO meets (meet_id, join_code, host_user_id, state, data, last_activity_at, created_at) VALUES (?,?,?,?,?,?,?)', [
      m.meetId,
      m.joinCode,
      m.hostUserId,
      m.state,
      JSON.stringify(m),
      m.lastActivityAt,
      m.createdAt,
    ]);
  }

  async saveMeet(m: Meet): Promise<void> {
    await this.db.run('UPDATE meets SET state=?, data=?, last_activity_at=? WHERE meet_id=?', [m.state, JSON.stringify(m), m.lastActivityAt, m.meetId]);
  }

  async getMeet(meetId: string): Promise<Meet | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM meets WHERE meet_id=?', [meetId]);
    return r ? (JSON.parse(r.data) as Meet) : null;
  }

  async getMeetByCode(code: string): Promise<Meet | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM meets WHERE join_code=?', [code.toUpperCase()]);
    return r ? (JSON.parse(r.data) as Meet) : null;
  }

  async listMeetsForUser(userId: string, limit = 30): Promise<Meet[]> {
    const rows = await this.db.all<{ data: string }>(
      `SELECT m.data AS data FROM meets m
       WHERE m.host_user_id=? OR m.meet_id IN (SELECT meet_id FROM participants WHERE user_id=?)
       ORDER BY m.created_at DESC LIMIT ?`,
      [userId, userId, limit],
    );
    return rows.map((r) => JSON.parse(r.data) as Meet);
  }

  async listOpenMeets(): Promise<Meet[]> {
    const rows = await this.db.all<{ data: string }>("SELECT data FROM meets WHERE state IN ('lobby','countdown','live')");
    return rows.map((r) => JSON.parse(r.data) as Meet);
  }

  // ---------- participants ----------

  async saveParticipant(p: StoredParticipant): Promise<void> {
    await this.db.run(
      `INSERT INTO participants (meet_id, participant_id, user_id, resume_token, data, last_seen_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(meet_id, participant_id) DO UPDATE SET data=excluded.data, last_seen_at=excluded.last_seen_at, resume_token=excluded.resume_token`,
      [p.meetId, p.participantId, p.userId, p.resumeToken, JSON.stringify(p), p.lastSeenAt],
    );
  }

  async getParticipantByToken(meetId: string, token: string): Promise<StoredParticipant | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND resume_token=?', [meetId, token]);
    return r ? (JSON.parse(r.data) as StoredParticipant) : null;
  }

  async getParticipant(meetId: string, participantId: string): Promise<StoredParticipant | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND participant_id=?', [meetId, participantId]);
    return r ? (JSON.parse(r.data) as StoredParticipant) : null;
  }

  /**
   * The user's participant in a meet. One account can be in a meet twice: as a member (host /
   * performer / audience) and, from a Publishing show view, as a publisher — `kind` picks which.
   */
  async getParticipantByUser(meetId: string, userId: string, kind: 'member' | 'publisher' | 'any' = 'member'): Promise<StoredParticipant | null> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND user_id=? ORDER BY last_seen_at DESC', [meetId, userId]);
    for (const r of rows) {
      const p = JSON.parse(r.data) as StoredParticipant;
      if (kind === 'any' || (kind === 'publisher') === (p.role === 'publisher')) return p;
    }
    return null;
  }

  async listParticipants(meetId: string): Promise<StoredParticipant[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM participants WHERE meet_id=? ORDER BY last_seen_at DESC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as StoredParticipant);
  }

  /** Delete a meet and everything that hangs off it (the takes and shows themselves live in the singers' Drives). */
  async deleteMeet(meetId: string): Promise<void> {
    for (const t of ['mix', 'performances', 'meet_members', 'recordings', 'signals', 'chat', 'participants', 'meets']) await this.db.run(`DELETE FROM ${t} WHERE meet_id=?`, [meetId]);
  }

  // ---------- the stage mix for the audience: a rolling window of one-second Opus batches per meet ----------

  async addMix(meetId: string, batch: MixBatch): Promise<void> {
    await this.db.run('INSERT INTO mix (meet_id, seq, created_at, data) VALUES (?,?,?,?) ON CONFLICT(meet_id, seq) DO UPDATE SET data=excluded.data', [meetId, batch.seq, new Date().toISOString(), JSON.stringify(batch)]);
    await this.db.run('DELETE FROM mix WHERE meet_id=? AND seq <= ?', [meetId, batch.seq - MIX_KEEP]);
  }

  async listMix(meetId: string, since: number, limit = 8): Promise<{ batches: MixBatch[]; latest: number }> {
    const latest = (await this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM mix WHERE meet_id=?', [meetId]))?.m ?? 0;
    const rows = await this.db.all<{ data: string }>('SELECT data FROM mix WHERE meet_id=? AND seq > ? ORDER BY seq ASC LIMIT ?', [meetId, since, limit]);
    return { batches: rows.map((r) => JSON.parse(r.data) as MixBatch), latest };
  }

  // ---------- members: every account that was ever in a meet (participants come and go; the shows are shared with all of them) ----------

  async addMember(meetId: string, userId: string): Promise<void> {
    await this.db.run('INSERT OR IGNORE INTO meet_members (meet_id, user_id, joined_at) VALUES (?,?,?)', [meetId, userId, new Date().toISOString()]);
  }

  async listMembers(meetId: string): Promise<UserRecord[]> {
    const rows = await this.db.all<{ user_id: string; email: string; name: string; picture: string; privileged: number; created_at: string; last_seen_at: string }>(
      'SELECT u.* FROM meet_members m JOIN users u ON u.user_id = m.user_id WHERE m.meet_id=? ORDER BY m.joined_at ASC',
      [meetId],
    );
    return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, picture: r.picture, privileged: !!r.privileged, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  // ---------- performances: the saved shows (one per song, registered by the host) ----------

  async addPerformance(p: MeetPerformance): Promise<void> {
    await this.db.run(
      `INSERT INTO performances (performance_id, meet_id, host_user_id, data, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(performance_id) DO UPDATE SET data=excluded.data`,
      [p.performanceId, p.meetId, p.hostUserId, JSON.stringify(p), p.createdAt],
    );
  }

  async getPerformance(performanceId: string): Promise<MeetPerformance | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM performances WHERE performance_id=?', [performanceId]);
    return r ? (JSON.parse(r.data) as MeetPerformance) : null;
  }

  async listPerformancesForMeet(meetId: string): Promise<MeetPerformance[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM performances WHERE meet_id=? ORDER BY created_at ASC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as MeetPerformance);
  }

  /** Every show of every meet the user hosted or was ever in, newest first. */
  async listPerformancesForUser(userId: string, limit = 200): Promise<MeetPerformance[]> {
    const rows = await this.db.all<{ data: string }>(
      `SELECT data FROM performances WHERE host_user_id=? OR meet_id IN (SELECT meet_id FROM meet_members WHERE user_id=?) ORDER BY created_at DESC LIMIT ?`,
      [userId, userId, limit],
    );
    return rows.map((r) => JSON.parse(r.data) as MeetPerformance);
  }

  async deletePerformance(performanceId: string): Promise<void> {
    await this.db.run('DELETE FROM performances WHERE performance_id=?', [performanceId]);
  }

  async removeParticipant(meetId: string, participantId: string): Promise<void> {
    await this.db.run('DELETE FROM participants WHERE meet_id=? AND participant_id=?', [meetId, participantId]);
  }

  // ---------- chat ----------

  async addChat(meetId: string, m: Omit<ChatMessage, 'seq'>): Promise<ChatMessage> {
    const seq = Number((await this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq),0)+1 AS n FROM chat WHERE meet_id=?', [meetId]))?.n ?? 1);
    const msg: ChatMessage = { ...m, seq };
    await this.db.run('INSERT INTO chat (meet_id, seq, data) VALUES (?,?,?)', [meetId, seq, JSON.stringify(msg)]);
    return msg;
  }

  async chatSince(meetId: string, since: number, limit = 100): Promise<ChatMessage[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM chat WHERE meet_id=? AND seq>? ORDER BY seq ASC LIMIT ?', [meetId, since, limit]);
    return rows.map((r) => JSON.parse(r.data) as ChatMessage);
  }

  async chatTail(meetId: string, limit = 50): Promise<ChatMessage[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM chat WHERE meet_id=? ORDER BY seq DESC LIMIT ?', [meetId, limit]);
    return rows.map((r) => JSON.parse(r.data) as ChatMessage).reverse();
  }

  // ---------- WebRTC signalling (performer ↔ performer, relayed) ----------

  /**
   * Append a signal. The per-meet sequence is assigned inside the INSERT itself (one statement, so
   * two performers — or a publisher fanning out offers to the whole stage — signalling at the same
   * instant can never collide on a seq and lose an offer); the seq column is authoritative on read.
   */
  async addSignal(meetId: string, sig: Omit<MeetSignal, 'seq'>): Promise<MeetSignal> {
    await this.db.run('INSERT INTO signals (meet_id, seq, to_id, data) SELECT ?, COALESCE(MAX(seq),0)+1, ?, ? FROM signals WHERE meet_id=?', [meetId, sig.to, JSON.stringify(sig), meetId]);
    const r = await this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq),0) AS n FROM signals WHERE meet_id=?', [meetId]);
    return { ...sig, seq: Number(r?.n ?? 0) };
  }

  async signalsFor(meetId: string, to: string, since: number, limit = 200): Promise<MeetSignal[]> {
    const rows = await this.db.all<{ seq: number; data: string }>('SELECT seq, data FROM signals WHERE meet_id=? AND to_id=? AND seq>? ORDER BY seq ASC LIMIT ?', [meetId, to, since, limit]);
    return rows.map((r) => ({ ...(JSON.parse(r.data) as Omit<MeetSignal, 'seq'>), seq: Number(r.seq) }));
  }

  async clearSignals(meetId: string): Promise<void> {
    await this.db.run('DELETE FROM signals WHERE meet_id=?', [meetId]);
  }

  // ---------- recordings ----------

  async addRecording(r: MeetRecording): Promise<void> {
    await this.db.run(
      `INSERT INTO recordings (meet_id, participant_id, performance_id, data, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(meet_id, performance_id) DO UPDATE SET data=excluded.data`,
      [r.meetId, r.participantId, r.performanceId, JSON.stringify(r), r.createdAt],
    );
  }

  async listRecordings(meetId: string): Promise<MeetRecording[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM recordings WHERE meet_id=? ORDER BY created_at ASC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as MeetRecording);
  }

  // ---------- publishing ----------

  async listDestinations(ownerUserId: string): Promise<StoredDestination[]> {
    const rows = await this.db.all<{ data: string; key_enc: string }>('SELECT data, key_enc FROM destinations WHERE owner_user_id=?', [ownerUserId]);
    return rows.map((r) => ({ ...(JSON.parse(r.data) as Destination), keyEnc: r.key_enc }));
  }

  async getDestination(ownerUserId: string, kind: string): Promise<StoredDestination | null> {
    const r = await this.db.get<{ data: string; key_enc: string }>('SELECT data, key_enc FROM destinations WHERE owner_user_id=? AND kind=?', [ownerUserId, kind]);
    return r ? { ...(JSON.parse(r.data) as Destination), keyEnc: r.key_enc } : null;
  }

  async saveDestination(ownerUserId: string, d: StoredDestination): Promise<void> {
    const { keyEnc, ...pub } = d;
    await this.db.run(
      `INSERT INTO destinations (owner_user_id, kind, data, key_enc) VALUES (?,?,?,?)
       ON CONFLICT(owner_user_id, kind) DO UPDATE SET data=excluded.data, key_enc=excluded.key_enc`,
      [ownerUserId, d.kind, JSON.stringify(pub), keyEnc],
    );
  }

  async saveJob(j: PublishJob): Promise<void> {
    await this.db.run(
      `INSERT INTO publish_jobs (job_id, owner_user_id, meet_id, state, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(job_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=excluded.updated_at`,
      [j.jobId, j.ownerUserId, j.meetId, j.state, JSON.stringify(j), j.createdAt, j.updatedAt],
    );
  }

  async getJob(jobId: string): Promise<PublishJob | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM publish_jobs WHERE job_id=?', [jobId]);
    return r ? (JSON.parse(r.data) as PublishJob) : null;
  }

  async listJobs(ownerUserId: string, meetId?: string): Promise<PublishJob[]> {
    const rows = meetId
      ? await this.db.all<{ data: string }>('SELECT data FROM publish_jobs WHERE owner_user_id=? AND meet_id=? ORDER BY created_at DESC LIMIT 50', [ownerUserId, meetId])
      : await this.db.all<{ data: string }>('SELECT data FROM publish_jobs WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 50', [ownerUserId]);
    return rows.map((r) => JSON.parse(r.data) as PublishJob);
  }

  async liveJobsForMeet(meetId: string): Promise<PublishJob[]> {
    const rows = await this.db.all<{ data: string }>("SELECT data FROM publish_jobs WHERE meet_id=? AND state IN ('requested','starting','live') ORDER BY created_at DESC", [meetId]);
    return rows.map((r) => JSON.parse(r.data) as PublishJob);
  }

  // ---------- live segments (the browser-published show, a rolling window per job) ----------

  async addLiveSegment(jobId: string, seg: LiveSegmentInfo, data: Uint8Array): Promise<void> {
    // A publisher that started over (a reload) counts from 0 again: what remains of the earlier run is stale.
    await this.db.run('DELETE FROM live_segments WHERE job_id=? AND seq>=?', [jobId, seg.seq]);
    await this.db.run(
      `INSERT INTO live_segments (job_id, seq, name, duration_ms, created_at, data) VALUES (?,?,?,?,?,?)
       ON CONFLICT(job_id, seq) DO UPDATE SET name=excluded.name, duration_ms=excluded.duration_ms, created_at=excluded.created_at, data=excluded.data`,
      [jobId, seg.seq, seg.name, seg.durationMs, seg.createdAt, data],
    );
    await this.db.run('DELETE FROM live_segments WHERE job_id=? AND seq<=?', [jobId, seg.seq - LIVE_KEEP]);
  }

  async listLiveSegments(jobId: string): Promise<LiveSegmentInfo[]> {
    const rows = await this.db.all<{ seq: number; name: string; duration_ms: number; created_at: string }>('SELECT seq, name, duration_ms, created_at FROM live_segments WHERE job_id=? ORDER BY seq ASC', [jobId]);
    return rows.map((r) => ({ seq: Number(r.seq), name: r.name, durationMs: Number(r.duration_ms), createdAt: r.created_at }));
  }

  async getLiveSegment(jobId: string, name: string): Promise<Uint8Array | null> {
    const r = await this.db.get<{ data: unknown }>('SELECT data FROM live_segments WHERE job_id=? AND name=?', [jobId, name]);
    return r ? toBytes(r.data) : null;
  }

  async clearLiveSegments(jobId: string): Promise<void> {
    await this.db.run('DELETE FROM live_segments WHERE job_id=?', [jobId]);
  }
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(0);
}
