/** Pure meet rules (no I/O) so they are unit-testable and identical on every runtime. */
import type { MeetPlayback, StagePolicy } from '@singersvoice/protocol';
import { emptyStage, idlePlayback, MAX_LIVE_TAKE_MS, MAX_PERFORMERS, MEET_IDLE_EXPIRY_MS, meetIsOpen, newId, newJoinCode, playbackPositionMs, type Meet, type Participant, type StageSlot } from '@singersvoice/protocol';

/** Participants unseen for this long are dropped from the stage/audience counts. */
export const PARTICIPANT_TIMEOUT_MS = 60 * 1000;

export function newMeet(input: { title: string; hostUserId: string; hostName: string; trackId: string | null; trackTitle: string; catalogTrackId: string | null; backgroundId: string }, now = Date.now()): Meet {
  const iso = new Date(now).toISOString();
  return {
    meetId: newId('meet-'),
    joinCode: newJoinCode(),
    title: input.title.trim() || `${input.hostName}'s meet`,
    hostUserId: input.hostUserId,
    hostName: input.hostName,
    trackId: input.trackId,
    trackTitle: input.trackTitle,
    catalogTrackId: input.catalogTrackId,
    state: 'lobby',
    backgroundId: input.backgroundId || 'mytestbg1',
    stage: emptyStage(),
    audienceCount: 0,
    performerCount: 0,
    createdAt: iso,
    lastActivityAt: iso,
    expiresAt: new Date(now + MEET_IDLE_EXPIRY_MS).toISOString(),
    kickstartEpochMs: null,
    playback: idlePlayback(),
    endedAt: null,
    streamUrl: null,
    openJoin: true,
    stagePolicy: 'ask',
    requests: [],
  };
}

/** Rows written before a field existed get its default (playback, stage policy, requests). */
export function ensureMeet(m: Meet): Meet {
  ensurePlayback(m);
  if (m.stagePolicy !== 'open' && m.stagePolicy !== 'ask') m.stagePolicy = 'ask';
  if (!Array.isArray(m.requests)) m.requests = [];
  return m;
}

/** Rows written before playback existed: a running meet counts as playing from its kickstart. */
export function ensurePlayback(m: Meet): MeetPlayback {
  if (!m.playback) {
    m.playback = idlePlayback();
    if (m.kickstartEpochMs !== null && (m.state === 'live' || m.state === 'countdown')) {
      m.playback.state = 'playing';
      m.playback.epoch = 1;
    }
  }
  return m.playback;
}

/** Any activity pushes the idle expiry out by 5 minutes. */
export function touch(m: Meet, now = Date.now()): void {
  if (!meetIsOpen(m)) return;
  m.lastActivityAt = new Date(now).toISOString();
  m.expiresAt = new Date(now + MEET_IDLE_EXPIRY_MS).toISOString();
}

/** Advance time-driven state: countdown → live at the kickstart, live → ended after the cap, open → expired when idle. */
export function tick(m: Meet, now = Date.now()): boolean {
  let changed = false;
  if (m.state === 'countdown' && m.kickstartEpochMs !== null && now >= m.kickstartEpochMs) {
    m.state = 'live';
    changed = true;
  }
  // A cued pause lands at its instant (for devices that poll it later, the position is already frozen).
  const pb = ensurePlayback(m);
  if (pb.state === 'playing' && pb.pauseAtEpochMs !== null && now >= pb.pauseAtEpochMs) {
    pb.state = 'paused';
    pb.pauseAtEpochMs = null;
    changed = true;
  }
  // A take can never run forever: the cap counts played time only (pauses don't count).
  const played = playbackPositionMs(m, now);
  if (m.state === 'live' && played !== null && played > MAX_LIVE_TAKE_MS) {
    m.state = 'ended';
    m.endedAt = new Date(now).toISOString();
    ensurePlayback(m).state = 'idle';
    changed = true;
  }
  if (meetIsOpen(m) && now > Date.parse(m.expiresAt)) {
    m.state = 'expired';
    m.endedAt = new Date(now).toISOString();
    changed = true;
  }
  return changed;
}

/** Recompute counts and free the slots of participants who stopped heart-beating. */
export function reconcile(m: Meet, participants: Participant[], now = Date.now()): { active: Participant[]; changed: boolean } {
  const active = participants.filter((p) => now - Date.parse(p.lastSeenAt) < PARTICIPANT_TIMEOUT_MS);
  const activeIds = new Set(active.map((p) => p.participantId));
  let changed = false;
  for (const s of m.stage) {
    if (s.participantId && !activeIds.has(s.participantId)) {
      clearSlot(s);
      changed = true;
    }
  }
  // Requests from members who left (or are on stage) are dropped.
  const before = (m.requests ?? []).length;
  m.requests = (m.requests ?? []).filter((r) => activeIds.has(r.participantId) && !m.stage.some((s) => s.participantId === r.participantId));
  if (m.requests.length !== before) changed = true;
  const performerCount = m.stage.filter((s) => s.participantId).length;
  const audienceCount = active.filter((p) => p.role !== 'publisher' && !m.stage.some((s) => s.participantId === p.participantId)).length;
  if (performerCount !== m.performerCount || audienceCount !== m.audienceCount) {
    m.performerCount = performerCount;
    m.audienceCount = audienceCount;
    changed = true;
  }
  return { active, changed };
}

function clearSlot(s: StageSlot): void {
  s.participantId = null;
  s.displayName = '';
  s.picture = '';
  s.ready = false;
  s.muted = false;
  s.driftMs = null;
  s.rttMs = null;
}

/**
 * Take a slot (or leave the stage with `slot = null`). Everyone who enters a meet is audience; the
 * host steps on stage freely, anyone else needs the host's permission while the stage policy is
 * 'ask' (`approved` — the host's decision seats them) or an 'open' stage. Performers already on
 * stage may move to another free slot. The stage is live from the moment the meet exists — the
 * song is just one activity on it — so a slot may be taken during the song as well (a late
 * performer starts mid-song).
 */
export function claimSlot(m: Meet, p: Participant, slot: number | null, approved = false): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (p.role === 'publisher' && slot !== null) return { ok: false, reason: 'publisher' };
  const entering = slot !== null && !m.stage.some((s) => s.participantId === p.participantId);
  if (entering && m.stagePolicy !== 'open' && !approved && p.userId !== m.hostUserId) return { ok: false, reason: 'ask_first' };
  if (slot !== null && (slot < 1 || slot > MAX_PERFORMERS)) return { ok: false, reason: 'bad_slot' };
  if (slot !== null) {
    const target = m.stage[slot - 1]!;
    if (target.participantId && target.participantId !== p.participantId) return { ok: false, reason: 'slot_taken' };
  }
  // Leave current slot first.
  for (const s of m.stage) if (s.participantId === p.participantId) clearSlot(s);
  m.requests = (m.requests ?? []).filter((r) => r.participantId !== p.participantId);
  if (slot === null) {
    p.slot = null;
    if (p.role !== 'publisher') p.role = p.userId === m.hostUserId ? 'host' : 'audience';
    return { ok: true };
  }
  const target = m.stage[slot - 1]!;
  target.participantId = p.participantId;
  target.displayName = p.displayName;
  target.picture = p.picture;
  target.ready = false;
  p.slot = slot;
  p.role = 'performer';
  p.stageRequest = 'none';
  return { ok: true };
}

/** An audience member asks the host to sing (idempotent while pending). */
export function requestStage(m: Meet, p: Participant, now = Date.now()): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (p.role === 'publisher') return { ok: false, reason: 'publisher' };
  if (p.slot !== null) return { ok: false, reason: 'on_stage' };
  if (m.stagePolicy === 'open') return { ok: false, reason: 'open_stage' };
  if (!m.requests.some((r) => r.participantId === p.participantId)) m.requests.push({ participantId: p.participantId, displayName: p.displayName, picture: p.picture, askedAt: new Date(now).toISOString() });
  p.stageRequest = 'pending';
  return { ok: true };
}

export function withdrawRequest(m: Meet, p: Participant): void {
  m.requests = (m.requests ?? []).filter((r) => r.participantId !== p.participantId);
  if (p.stageRequest === 'pending') p.stageRequest = 'none';
}

/** The host lets someone on stage (first free slot unless given) or declines; the decision clears the request. */
export function decideRequest(m: Meet, target: Participant, allow: boolean, slot?: number): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  m.requests = (m.requests ?? []).filter((r) => r.participantId !== target.participantId);
  if (!allow) {
    target.stageRequest = 'declined';
    return { ok: true };
  }
  const free = slot ?? m.stage.find((s) => !s.participantId)?.slot;
  if (!free) return { ok: false, reason: 'stage_full' };
  return claimSlot(m, target, free, true);
}

export function setStagePolicy(m: Meet, policy: StagePolicy): void {
  m.stagePolicy = policy;
  if (policy === 'open') m.requests = []; // nothing to wait for any more
}

export function setReady(m: Meet, p: Participant, ready: boolean): void {
  const s = m.stage.find((x) => x.participantId === p.participantId);
  if (s) s.ready = ready;
}

export function reportClock(m: Meet, p: Participant, driftMs: number | null, rttMs: number | null): void {
  const s = m.stage.find((x) => x.participantId === p.participantId);
  if (s) {
    s.driftMs = driftMs;
    s.rttMs = rttMs;
  }
}

export function start(m: Meet, leadMs: number, now = Date.now()): { ok: boolean; reason?: string } {
  if (m.state !== 'lobby' && m.state !== 'countdown') return { ok: false, reason: 'not_in_lobby' };
  if (!m.stage.some((s) => s.participantId)) return { ok: false, reason: 'no_performers' };
  m.kickstartEpochMs = now + Math.max(3000, Math.min(30000, leadMs));
  m.state = 'countdown';
  const pb = ensurePlayback(m);
  pb.state = 'playing';
  pb.offsetMs = 0;
  pb.pausedAtMs = 0;
  pb.pauseAtEpochMs = null;
  pb.epoch += 1;
  touch(m, now);
  return { ok: true };
}

/**
 * Host pauses the song for everyone. Like the kickstart, the pause is cued at a shared instant
 * `leadMs` ahead (≥ one poll interval), so every device freezes at the same track position.
 */
export function pause(m: Meet, now = Date.now(), leadMs = 3000): { ok: boolean; reason?: string } {
  if (m.state !== 'live' && m.state !== 'countdown') return { ok: false, reason: 'not_playing' };
  const pb = ensurePlayback(m);
  if (pb.state !== 'playing' || pb.pauseAtEpochMs !== null) return { ok: false, reason: 'not_playing' };
  const at = Math.max(now + Math.max(0, Math.min(10_000, leadMs)), m.kickstartEpochMs ?? now);
  pb.pauseAtEpochMs = at;
  pb.pausedAtMs = Math.max(0, pb.offsetMs + (at - (m.kickstartEpochMs ?? at)));
  m.state = 'live';
  touch(m, now);
  return { ok: true };
}

/** Host resumes (from the paused position) or restarts (from `fromMs`) with a short shared lead. */
export function resume(m: Meet, leadMs: number, now = Date.now(), fromMs?: number): { ok: boolean; reason?: string } {
  if (m.state !== 'live' && m.state !== 'countdown') return { ok: false, reason: 'not_live' };
  const pb = ensurePlayback(m);
  if (pb.state === 'idle') return { ok: false, reason: 'not_started' };
  const position = fromMs !== undefined ? Math.max(0, fromMs) : pb.pausedAtMs;
  if (pb.state === 'playing' && pb.pauseAtEpochMs === null && fromMs === undefined) return { ok: false, reason: 'already_playing' };
  m.kickstartEpochMs = now + Math.max(1500, Math.min(30000, leadMs));
  pb.offsetMs = position;
  pb.pausedAtMs = position;
  pb.pauseAtEpochMs = null;
  pb.state = 'playing';
  pb.epoch += 1;
  m.state = 'live';
  touch(m, now);
  return { ok: true };
}

export function stop(m: Meet, now = Date.now()): void {
  if (!meetIsOpen(m)) return;
  m.state = 'ended';
  m.endedAt = new Date(now).toISOString();
  m.kickstartEpochMs = null;
  ensurePlayback(m).state = 'idle';
}

export function isHost(m: Meet, p: Participant): boolean {
  return p.userId === m.hostUserId;
}

export const forTests = { clearSlot };
