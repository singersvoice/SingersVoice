/** The SVT DB store: users, public track catalog, meets, participants, chat, recordings, publishing. */
import type { CatalogTrack, ChatMessage, Destination, Meet, MeetRecording, Participant, PublishJob, UserRecord } from '@singersvoice/protocol';
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
    if (q) {
      where.push('search LIKE ?');
      params.push(`%${q.toLowerCase()}%`);
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

  async getParticipantByUser(meetId: string, userId: string): Promise<StoredParticipant | null> {
    const r = await this.db.get<{ data: string }>('SELECT data FROM participants WHERE meet_id=? AND user_id=? ORDER BY last_seen_at DESC LIMIT 1', [meetId, userId]);
    return r ? (JSON.parse(r.data) as StoredParticipant) : null;
  }

  async listParticipants(meetId: string): Promise<StoredParticipant[]> {
    const rows = await this.db.all<{ data: string }>('SELECT data FROM participants WHERE meet_id=? ORDER BY last_seen_at DESC', [meetId]);
    return rows.map((r) => JSON.parse(r.data) as StoredParticipant);
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
}
