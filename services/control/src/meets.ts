/** Pure meet rules (no I/O) so they are unit-testable and identical on every runtime. */
import type { MeetPlayback, SetListEntry, SongPick, StagePolicy } from '@singersvoice/protocol';
import { emptyStage, idlePlayback, MAX_LIVE_TAKE_MS, MAX_PERFORMERS, MEET_IDLE_EXPIRY_MS, meetIsOpen, newId, newJoinCode, playbackPositionMs, songPlace, type Meet, type Participant, type StageSlot } from '@singersvoice/protocol';

/** Participants unseen for this long are dropped from the stage/audience counts. */
export const PARTICIPANT_TIMEOUT_MS = 60 * 1000;

/**
 * How many of the audience a snapshot names. The rest is `meet.audienceCount`: what every poll
 * carries stays a few kilobytes whether three people are in the room or three hundred.
 */
export const SNAPSHOT_AUDIENCE_NAMES = 12;

/**
 * A heartbeat extends the idle expiry (five minutes); rewriting the meet row for every heartbeat
 * of a large audience would be most of the database's work, so the extension is written only when
 * the last one is older than this (an expiry a couple of seconds stale costs nothing).
 */
export const TOUCH_COALESCE_MS = 2000;

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
    stagePolicy: 'open', // whoever has the link may sing; the host can switch to deciding each one
    bannedUserIds: [],
    requests: [],
    setList: [],
    songCount: 0,
  };
}

/** Rows written before a field existed get its default (playback, stage policy, requests). */
export function ensureMeet(m: Meet): Meet {
  ensurePlayback(m);
  if (m.stagePolicy !== 'open' && m.stagePolicy !== 'ask') m.stagePolicy = 'ask';
  if (!Array.isArray(m.requests)) m.requests = [];
  if (!Array.isArray(m.bannedUserIds)) m.bannedUserIds = [];
  if (!Array.isArray(m.setList)) m.setList = [];
  if (typeof m.songCount !== 'number') m.songCount = 0;
  return m;
}

// ---------- the song of the stage: one at a time ----------
//
// At most one song is up (or playing). A song picked while one is up is *put forward*: the stage then
// chooses — every singer on stage sees every song put forward (the one up included, while it has not
// started), one tap on any device settles it, and the others are dropped. While a song plays, songs
// put forward wait for its end: one alone comes up by itself, several leave the choice to the stage.
// A song is never listed twice (`songPlace`), and nobody has to pick a song twice: picked is up.

export const hasSong = (m: Meet): boolean => Boolean(m.trackId || m.catalogTrackId);
/** A song is in progress (count-in, playing or paused) — the current song cannot be swapped under it. */
export const songInProgress = (m: Meet): boolean => m.state === 'countdown' || (m.state === 'live' && ensurePlayback(m).state !== 'idle');
/** The host and everyone on stage pick songs. */
export const canPickSong = (m: Meet, p: Participant): boolean => p.role !== 'publisher' && (p.userId === m.hostUserId || p.slot !== null);
/** The stage has songs put forward and no song running: it must choose before anything starts. */
export const choicePending = (m: Meet): boolean => m.setList.length > 0 && !songInProgress(m);

function setCurrent(m: Meet, song: SongPick | null): void {
  m.trackId = song?.trackId ?? null;
  m.catalogTrackId = song?.catalogTrackId ?? null;
  m.registryId = song?.registryId ?? null;
  m.trackTitle = song ? song.trackTitle.slice(0, 120) : '';
  m.currentDurationMs = song?.durationMs ?? 0;
  for (const s of m.stage) s.ready = false; // a new song: everyone gets ready again (loads it)
}

/**
 * Pick a song — the host and anyone on stage. Nothing up: it is up at once, anyone on stage starts
 * it. A song up already: the pick is put forward and the stage chooses (`chooseSong`). A song that
 * is up or put forward already is not added again (`duplicate` says where it is).
 */
export function addSong(m: Meet, p: Participant, song: SongPick, at = Date.now()): { ok: boolean; reason?: string; entry?: SetListEntry; duplicate?: 'current' | 'proposed' } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (!canPickSong(m, p)) return { ok: false, reason: 'not_on_stage' };
  if (!song.trackId && !song.catalogTrackId) return { ok: false, reason: 'no_track' };
  if (!song.trackTitle?.trim()) return { ok: false, reason: 'no_title' };
  const pick: SongPick = { trackId: song.trackId ?? null, catalogTrackId: song.catalogTrackId ?? null, registryId: song.registryId ?? null, trackTitle: song.trackTitle.trim(), durationMs: Math.max(0, Math.round(song.durationMs ?? 0)) };
  const already = songPlace(m, pick);
  if (already?.place === 'current') return { ok: true, duplicate: 'current' };
  if (already?.place === 'proposed') return { ok: true, duplicate: 'proposed', entry: already.entry };
  const entry: SetListEntry = { id: newId('song-'), ...pick, durationMs: pick.durationMs ?? 0, pickedBy: p.participantId, pickedByName: p.displayName, addedAt: new Date(at).toISOString() };
  if (!hasSong(m)) {
    setCurrent(m, pick);
    return { ok: true, entry };
  }
  m.setList.push(entry);
  return { ok: true, entry };
}

/**
 * The stage settles on one song — any singer on stage, one tap: `songId` is a song put forward, or
 * 'current' for the one up. No song running: the chosen one is up and every other song put forward
 * is dropped (the one that was up included). A song running: the chosen one is the only song
 * waiting for its end.
 */
export function chooseSong(m: Meet, p: Participant, songId: string): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (!canPickSong(m, p)) return { ok: false, reason: 'not_on_stage' };
  if (songId === 'current') {
    if (!hasSong(m)) return { ok: false, reason: 'no_song' };
    m.setList = [];
    return { ok: true };
  }
  const entry = m.setList.find((e) => e.id === songId);
  if (!entry) return { ok: false, reason: 'no_song' };
  if (songInProgress(m)) {
    m.setList = [entry];
    return { ok: true };
  }
  m.setList = [];
  setCurrent(m, entry);
  return { ok: true };
}

/**
 * Withdraw a song put forward — anyone on stage, or the one who put it forward. A withdrawal that
 * leaves one song put forward with nothing up and nothing running ends the choice: that song is up.
 */
export function songAction(m: Meet, p: Participant, songId: string, action: 'remove' | 'choose'): { ok: boolean; reason?: string } {
  if (action === 'choose') return chooseSong(m, p, songId);
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  const i = m.setList.findIndex((e) => e.id === songId);
  if (i < 0) return { ok: false, reason: 'no_song' };
  const entry = m.setList[i]!;
  if (!canPickSong(m, p) && entry.pickedBy !== p.participantId) return { ok: false, reason: 'not_on_stage' };
  m.setList.splice(i, 1);
  if (!hasSong(m) && m.setList.length === 1 && !songInProgress(m)) setCurrent(m, m.setList.shift()!);
  return { ok: true };
}

/**
 * The current song is over (its track ended, or a singer ended it — or the stage skips it): the meet
 * goes back to the lobby — stage, slots and cameras untouched. One song put forward comes up by
 * itself; several stay put forward with nothing up, for the stage to choose; none: nothing up until
 * somebody picks. Playback and the kickstart are cleared; ready flags reset.
 */
export function nextSong(m: Meet, now = Date.now()): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (m.state === 'countdown' || m.state === 'live') m.songCount += 1;
  m.state = 'lobby';
  m.kickstartEpochMs = null;
  const pb = ensurePlayback(m);
  pb.state = 'idle';
  pb.offsetMs = 0;
  pb.pausedAtMs = 0;
  pb.pauseAtEpochMs = null;
  const next = m.setList.length === 1 ? (m.setList.shift() ?? null) : null;
  setCurrent(m, next);
  touch(m, now);
  return { ok: true };
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

/**
 * Touch the meet for a heartbeat when the extension is due (see TOUCH_COALESCE_MS), and say whether it
 * was — that is when the row is worth writing. A closed meet has nothing to extend.
 */
export function touchForHeartbeat(m: Meet, now = Date.now()): boolean {
  if (!meetIsOpen(m) || now - Date.parse(m.lastActivityAt) < TOUCH_COALESCE_MS) return false;
  touch(m, now);
  return true;
}

/**
 * The participants a snapshot carries: everyone on stage, the host, the publishers, the wait list,
 * and the first dozen of the audience (by arrival) — the people the room shows by name. The size of
 * the audience is `meet.audienceCount`.
 */
export function visibleParticipants(m: Meet, active: Participant[], names = SNAPSHOT_AUDIENCE_NAMES): Participant[] {
  if (names === Infinity) return active; // the host sees everyone (they decide who stays)
  const onStage = new Set(m.stage.map((s) => s.participantId).filter(Boolean));
  const asking = new Set((m.requests ?? []).map((r) => r.participantId));
  const named: Participant[] = [];
  const audience: Participant[] = [];
  for (const p of active) (onStage.has(p.participantId) || asking.has(p.participantId) || p.role === 'host' || p.role === 'publisher' ? named : audience).push(p);
  audience.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  return [...named, ...audience.slice(0, names)];
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
  // A song can never run forever: the cap counts played time only (pauses don't count) — the meet
  // goes back to the lobby for the next song, like any song that ended.
  const played = playbackPositionMs(m, now);
  if (m.state === 'live' && played !== null && played > MAX_LIVE_TAKE_MS) {
    nextSong(m, now);
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
 * song is just one activity on it — but a running song is the stage singers' own: nobody new
 * steps on until it is over; they wait on the wait list.
 */
export function claimSlot(m: Meet, p: Participant, slot: number | null, approved = false): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (p.role === 'publisher' && slot !== null) return { ok: false, reason: 'publisher' };
  const entering = slot !== null && !m.stage.some((s) => s.participantId === p.participantId);
  // A running song belongs to the singers on stage: nobody steps on until it is over (the wait list is served then).
  if (entering && songInProgress(m)) return { ok: false, reason: 'song_in_progress' };
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

/**
 * The host removes someone from the meet: off the stage, off the wait list, and out — the account
 * cannot join this meet again. Only the host, never themselves.
 */
export function kick(m: Meet, host: Participant, target: Participant): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (host.userId !== m.hostUserId) return { ok: false, reason: 'not_host' };
  if (target.participantId === host.participantId || target.userId === m.hostUserId) return { ok: false, reason: 'self' };
  claimSlot(m, target, null);
  withdrawRequest(m, target);
  m.bannedUserIds = [...new Set([...(m.bannedUserIds ?? []), target.userId])];
  return { ok: true };
}

/** True when the host removed this account from the meet. */
export const isBanned = (m: Meet, userId: string): boolean => (m.bannedUserIds ?? []).includes(userId);

/** The host lets someone on stage (first free slot unless given) or declines; the decision clears the request. */
export function decideRequest(m: Meet, target: Participant, allow: boolean, slot?: number): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (allow && songInProgress(m)) return { ok: false, reason: 'song_in_progress' }; // they stay on the wait list until the song is over
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

/** The stage background: the host or anyone on stage (not a publisher) switches it, whenever — the stage is theirs. */
export function setBackground(m: Meet, p: Participant, backgroundId: string): { ok: boolean; reason?: string } {
  if (!meetIsOpen(m)) return { ok: false, reason: 'meet_closed' };
  if (!canPickSong(m, p)) return { ok: false, reason: 'not_on_stage' };
  const id = backgroundId.trim();
  if (!/^[\w-]{1,64}$/.test(id)) return { ok: false, reason: 'bad_background' };
  m.backgroundId = id;
  return { ok: true };
}

export function setReady(m: Meet, p: Participant, ready: boolean): void {
  const s = m.stage.find((x) => x.participantId === p.participantId);
  if (s) s.ready = ready;
}

/** A performer's clock report lands on their stage slot; true when it changed what the slot says. */
export function reportClock(m: Meet, p: Participant, driftMs: number | null, rttMs: number | null): boolean {
  const s = m.stage.find((x) => x.participantId === p.participantId);
  if (!s || (s.driftMs === driftMs && s.rttMs === rttMs)) return false;
  s.driftMs = driftMs;
  s.rttMs = rttMs;
  return true;
}

/**
 * Start the song: a shared kickstart `leadMs` ahead. Any singer on stage may ask (the route checks);
 * a second tap while the count-in runs changes nothing — the stage starts once, together.
 */
export function start(m: Meet, leadMs: number, now = Date.now()): { ok: boolean; reason?: string } {
  if (m.state === 'countdown' && m.kickstartEpochMs !== null && m.kickstartEpochMs > now) return { ok: true }; // already counting in
  if (m.state !== 'lobby' && m.state !== 'countdown') return { ok: false, reason: 'not_in_lobby' };
  if (!m.stage.some((s) => s.participantId)) return { ok: false, reason: 'no_performers' };
  if (choicePending(m)) return { ok: false, reason: 'choice_pending' }; // more than one song put forward: the stage chooses first
  if (!hasSong(m)) return { ok: false, reason: 'no_song' };
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
  // A restart (or a resume) asked while the count-in still runs changes nothing: the song has not started, the one
  // deadline stands — so a count-in never jumps because a second device asked for the top of the song.
  if (m.state === 'countdown' && m.kickstartEpochMs !== null && m.kickstartEpochMs > now && pb.state === 'playing' && pb.pauseAtEpochMs === null) return { ok: true };
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

/**
 * A jump on the song's timeline, for everyone: while playing it is cued `leadMs` ahead like a
 * kickstart (every device keeps playing and jumps at the same instant — seamless); while paused the
 * paused position simply moves (and the epoch bumps so every device re-seeks). Any singer on stage
 * may do it; the devices stay in sync whoever asks.
 */
export function seek(m: Meet, leadMs: number, toMs: number, now = Date.now()): { ok: boolean; reason?: string } {
  if (m.state !== 'live' && m.state !== 'countdown') return { ok: false, reason: 'not_live' };
  const pb = ensurePlayback(m);
  if (pb.state === 'idle') return { ok: false, reason: 'not_started' };
  if (m.state === 'countdown' && m.kickstartEpochMs !== null && m.kickstartEpochMs > now && pb.state === 'playing') return { ok: false, reason: 'counting_in' };
  const to = Math.max(0, Math.round(toMs));
  if (pb.state === 'paused') {
    pb.pausedAtMs = to;
    pb.offsetMs = to;
    pb.epoch += 1;
    touch(m, now);
    return { ok: true };
  }
  if (pb.pauseAtEpochMs !== null) return { ok: false, reason: 'pausing' };
  m.kickstartEpochMs = now + Math.max(1500, Math.min(30000, leadMs));
  pb.offsetMs = to;
  pb.pausedAtMs = to;
  pb.epoch += 1;
  m.state = 'live';
  touch(m, now);
  return { ok: true };
}

/** Who may pause, resume and seek: the host and any singer on stage (the song belongs to the stage). */
export function canTransport(m: Meet, p: Participant): boolean {
  return isHost(m, p) || (p.slot !== null && p.role !== 'publisher');
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
