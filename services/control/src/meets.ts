/** Pure meet rules (no I/O) so they are unit-testable and identical on every runtime. */
import type { MeetPlayback } from '@singersvoice/protocol';
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
  };
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
  const performerCount = m.stage.filter((s) => s.participantId).length;
  const audienceCount = active.filter((p) => !m.stage.some((s) => s.participantId === p.participantId)).length;
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

export function claimSlot(m: Meet, p: Participant, slot: number | null): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  // Leave current slot first.
  for (const s of m.stage) if (s.participantId === p.participantId) clearSlot(s);
  if (slot === null) {
    p.slot = null;
    p.role = p.userId === m.hostUserId ? 'host' : 'audience';
    return { ok: true };
  }
  if (slot < 1 || slot > MAX_PERFORMERS) return { ok: false, reason: 'bad_slot' };
  const target = m.stage[slot - 1]!;
  if (target.participantId && target.participantId !== p.participantId) return { ok: false, reason: 'slot_taken' };
  if (m.state === 'live') return { ok: false, reason: 'already_live' };
  target.participantId = p.participantId;
  target.displayName = p.displayName;
  target.picture = p.picture;
  target.ready = false;
  p.slot = slot;
  p.role = 'performer';
  return { ok: true };
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
