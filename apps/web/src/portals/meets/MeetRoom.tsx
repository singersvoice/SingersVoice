/**
 * Meet room (/meet/:id): lobby with stage slots + chat, the clock-synced live stage for
 * performers (GMT kickstart), the audience view, and the ended/expired summary.
 * Every take on stage is a personal session: recorded locally and saved by itself, in the
 * background (`liveTake.ts`), to the singer's own Drive — its video being the show (the stage
 * with everyone on it and the whole mix, as Publisher mode shows it) — while the singer stays on
 * stage for the next song. The host's take of each song is the meet's saved performance, shared
 * with everyone who was in the meet. Nothing here ever waits for a review or an approval.
 */
import { formatMs, MAX_PERFORMERS, playbackPositionMs, SLOT_COLORS, type Meet, type Participant, type SingerSlot, type SongPick, type StageSlot } from '@singersvoice/protocol';
import { activeRoomInfo } from './activeRoom.ts';
import { useRoomStage, type RoomStage } from './roomStage.ts';
import { SetListPanel } from './SetListPanel.tsx';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getEngine, type AudioEngine } from '../../audio/engine.ts';
import { MixPlayer, mixPlaySupported } from '../../audio/mixPlayer.ts';
import { StageBackground } from '../../components/BackgroundPicker.tsx';
import { VirtualStage } from '../../components/VirtualStage.tsx';
import { PresetChips } from '../../components/FxPanel.tsx';
import { IcCamera, IcCameraOff, IcChat, IcCheck, IcHeadphones, IcMic, IcMusic, IcPause, IcPlay, IcPlus, IcShare, IcSkipBack, IcStop, IcUsers, IcX } from '../../components/icons.tsx';
import { CueDeck, LyricsPanel } from '../../components/LyricsPanel.tsx';
import { LiveShow, useLiveStatus, type LiveShowState } from '../../components/LiveShow.tsx';
import { MixBalance } from '../../components/MixBalance.tsx';
import { Page } from '../../components/Shell.tsx';
import { Progress, Seg, Spinner, Switch } from '../../components/ui.tsx';
import { clock, controlConfigured, serverNow } from '../../lib/api.ts';
import { shareOrCopy } from '../../lib/download.ts';
import { href } from '../../lib/nav.ts';
import { isIOS, keepAwake } from '../../lib/platform.ts';
import type { TakeResult } from '../../lib/takes.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { privileged } from '../../state/session.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../../state/settings.ts';
import { Camera } from '../../video/camera.ts';
import { MicStatus } from '../../components/MicStatus.tsx';
import { SaveStatus } from '../../components/SaveStatus.tsx';
import { SeekBar } from '../../components/SeekBar.tsx';
import { saveLiveTake } from './liveTake.ts';
import { MeetSession } from './meetSession.ts';
import { keepMeetTrack, loadMeetTrack, type MeetTrack } from './trackSource.ts';

const LEAD_MS = 8000;

export function MeetRoom(props: { id: string }) {
  const session = useMemo(() => new MeetSession(props.id), [props.id]);
  const [track, setTrack] = useState<MeetTrack | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const engineRef = useRef<AudioEngine | null>(null);
  /** Which song is decoded in the player (a karaoke event is many songs: each one is loaded when it comes up). */
  const loadedKey = useRef('');
  const camera = useMemo(() => new Camera(), []);
  const snap = session.snapshot.value;
  const you = session.you.value;
  const meet = snap?.meet ?? null;

  useEffect(() => {
    if (!controlConfigured.value) return;
    void session.join('audience').catch(() => undefined);
    return () => {
      // Unmounted = you left the meet (Leave, another meet, sign-out): free the slot right away.
      void session.leave();
      camera.close();
      void engineRef.current?.close();
      engineRef.current = null;
      void keepAwake(false);
      activeRoomInfo.value = null;
    };
  }, [props.id]);
  // What the floating pill shows while this room runs behind another page.
  useEffect(() => {
    if (meet && you) activeRoomInfo.value = { meetId: meet.meetId, title: meet.title, state: meet.state, onStage: you.slot !== null, slot: you.slot };
  }, [meet?.title, meet?.state, you?.slot]);

  // Load the current song whenever the set list moves on (every device resolves it: library, then catalog).
  const trackKey = `${meet?.trackId ?? ''}|${meet?.catalogTrackId ?? ''}`;
  useEffect(() => {
    if (!meet) return;
    let cancelled = false;
    setTrack(null);
    setPrepared(false); // a new song: get ready again (the server cleared the ready flags too)
    if (!meet.trackId && !meet.catalogTrackId) {
      setTrack({ loaded: null, source: 'none', reason: 'No song picked yet — add one to the set list.' });
      return;
    }
    void loadMeetTrack(meet).then((t) => !cancelled && setTrack(t));
    return () => {
      cancelled = true;
    };
  }, [trackKey]);
  // A singer on stage keeps what the meet sings: a shared song lands in their own library (Drive) in the background.
  useEffect(() => {
    if (track?.source === 'catalog' && you?.slot != null) keepMeetTrack(track);
  }, [track, you?.slot]);

  /** User-gesture pre-flight: audio context, mic (+camera on iOS), decode the track. Then "ready". */
  const prepare = async () => {
    if (!track?.loaded) return toast('The track is not available on this device yet', 'warn');
    setPreparing(true);
    try {
      const app = appSettings.peek();
      const audio = audioSettings.peek();
      const engine = engineRef.current ?? getEngine();
      engineRef.current = engine;
      await engine.resume();
      const wantCombined = isIOS && app.cameraOn;
      if (wantCombined) camera.close();
      const video = await engine.openMic({
        deviceId: app.audioInputId || undefined,
        echoCancellation: app.echoCancellation,
        video: wantCombined ? { facingMode: app.cameraFacing, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      if (video) camera.adopt(video, app.cameraFacing);
      else if (app.cameraOn && !camera.on.value) await camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined }).catch(() => undefined);
      camera.setPreset(app.zoomPreset);
      engine.applyFx(audio.params);
      engine.setMonitor(audio.monitor);
      const player = engine.player!;
      if (loadedKey.current !== trackKey || !player.buffer) {
        await player.load(track.loaded.audio, track.loaded.track.trackId);
        loadedKey.current = trackKey;
      }
      player.setGain(audio.backingGain);
      await keepAwake(true);
      setPrepared(true);
      await session.setReady(true);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setPreparing(false);
    }
  };

  if (!controlConfigured.value)
    return (
      <Page title="Meet">
        <div class="callout warn">Live meets need the SingersVoice service — this build has no VITE_CONTROL_URL.</div>
      </Page>
    );
  if (session.error.value && !meet)
    return (
      <Page title="Meet">
        <div class="stack">
          <div class="callout danger">{session.error.value}</div>
          <a class="btn" href={href('/meets')}>
            Back to meets
          </a>
        </div>
      </Page>
    );
  if (!meet || !you)
    return (
      <Page title="Meet">
        <div class="row">
          <Spinner /> Joining the meet…
        </div>
      </Page>
    );

  return (
    <Room
      session={session}
      meet={meet}
      you={you}
      track={track}
      camera={camera}
      engine={engineRef.current}
      prepared={prepared}
      preparing={preparing}
      onPrepare={prepare}
      participants={snap?.participants ?? []}
      onTake={(t, loaded, singers) => {
        // The take saves itself in the background; the singer is already back on the stage (ready again for the next song, or to rejoin this one).
        setPrepared(false);
        saveLiveTake({ take: t, loaded, slot: you.slot ?? 1, meet: { meetId: meet.meetId, title: meet.title, hostName: meet.hostName }, host: you.userId === meet.hostUserId, singers, resumeToken: session.resumeToken || undefined });
      }}
    />
  );
}

/** The joined room: one virtual stage for the whole meet (see roomStage.ts), then whichever screen fits. */
function Room(props: {
  session: MeetSession;
  meet: Meet;
  you: Participant;
  track: MeetTrack | null;
  camera: Camera;
  engine: AudioEngine | null;
  prepared: boolean;
  preparing: boolean;
  onPrepare: () => Promise<void>;
  participants: Participant[];
  onTake: (t: TakeResult, loaded: NonNullable<MeetTrack['loaded']>, singers: { slot: number; displayName: string; userId?: string }[]) => void;
}) {
  const { session, meet, you, track, camera, engine } = props;
  const stage = useRoomStage(session, meet, you, camera, { preparing: props.preparing, level: () => engine?.recorder?.level.value ?? 0, engine });
  const onStage = you.slot !== null;
  const live = meet.state === 'countdown' || meet.state === 'live';
  // A take in progress keeps the live stage mounted until it wraps up, even once the meet is back in
  // the lobby (the host ended the song, the set list moved on) — otherwise the take would be lost.
  const [singing, setSinging] = useState(false);
  const liveLoaded = useRef<NonNullable<MeetTrack['loaded']> | null>(null);
  if (live && track?.loaded) liveLoaded.current = track.loaded;

  if ((live || singing) && onStage && liveLoaded.current && engine) return <LiveStage session={session} meet={meet} you={you} loaded={liveLoaded.current} engine={engine} camera={camera} stage={stage} track={track} prepared={props.prepared} onPrepare={props.onPrepare} onTake={props.onTake} onSinging={setSinging} participants={props.participants} />;

  if (meet.state === 'ended' || meet.state === 'expired') return <Ended session={session} meet={meet} you={you} />;

  return <Lobby session={session} meet={meet} you={you} track={track} stage={stage} prepared={props.prepared} preparing={props.preparing} onPrepare={props.onPrepare} participants={props.participants} engine={engine} />;
}

// ---------------- Lobby + audience ----------------

/** Re-open the microphone with the settings just changed (another mic, speakers vs headphones) — the chain and the take carry on. */
async function reopenMic(engine: AudioEngine | null): Promise<void> {
  if (!engine?.micOpen.value) return;
  const app = appSettings.peek();
  try {
    await engine.openMic({ deviceId: app.audioInputId || undefined, echoCancellation: app.echoCancellation });
    engine.applyFx(audioSettings.peek().params);
    engine.setMonitor(audioSettings.peek().monitor);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

function Lobby(props: {
  session: MeetSession;
  meet: Meet;
  you: Participant;
  track: MeetTrack | null;
  stage: RoomStage;
  prepared: boolean;
  preparing: boolean;
  onPrepare: () => Promise<void>;
  participants: Participant[];
  engine: AudioEngine | null;
}) {
  const { session, meet, you, stage } = props;
  const [tab, setTab] = useState<'stage' | 'chat'>('stage');
  const [deciding, setDeciding] = useState<string | null>(null);
  useEffect(() => {
    stage.compositor.mode = 'show'; // no lyrics over the lobby stage: the performers fill it
  }, []);
  const [now, setNow] = useState(Date.now());
  const [listen, setListen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const host = you.userId === meet.hostUserId;
  const onStage = you.slot !== null;
  const msLeft = session.msToExpiry();
  const live = meet.state === 'countdown' || meet.state === 'live';
  const link = `${location.origin}${href(`/meet/${encodeURIComponent(meet.meetId)}`)}`;
  // Shared track position for everyone: negative while counting down to the kickstart, frozen while paused.
  const pos = playbackPositionMs(meet, serverNow());
  const tMs = meet.playback?.state === 'paused' ? (pos ?? 0) : meet.kickstartEpochMs !== null ? (meet.playback?.offsetMs ?? 0) + (serverNow() - meet.kickstartEpochMs) : -1;
  const countingDown = meet.kickstartEpochMs !== null && meet.playback?.state === 'playing' && serverNow() < meet.kickstartEpochMs;
  void now;

  const share = async () => {
    const r = await shareOrCopy(`Join "${meet.title}" on SingersVoice`, `Code ${meet.joinCode}`, link);
    toast(r === 'copied' ? 'Meet link copied' : r === 'shared' ? 'Shared' : link, r === 'failed' ? 'warn' : 'ok');
  };
  const openStage = meet.stagePolicy === 'open';
  const askState = you.stageRequest ?? 'none';
  /** Step on a slot: the camera opens with the tap (browsers that need the gesture), then the slot is taken. */
  const claim = async (slot: number | null) => {
    if (slot !== null && appSettings.peek().cameraOn) void stage.openCamera();
    try {
      await session.claimSlot(slot);
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const ask = async () => {
    try {
      await session.askToSing();
      toast('Asked the host — you step on stage as soon as they say yes', 'ok');
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const withdraw = async () => {
    try {
      await session.withdrawAsk();
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const decide = async (participantId: string, allow: boolean) => {
    setDeciding(participantId);
    try {
      await session.decide(participantId, allow);
    } catch (e) {
      toast(errorText(e), 'warn');
    } finally {
      setDeciding(null);
    }
  };
  const remove = async (participantId: string) => {
    try {
      await session.removeFromStage(participantId);
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const setPolicy = async (open: boolean) => {
    try {
      await session.setStagePolicy(open ? 'open' : 'ask');
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const endSong = async () => {
    if (!confirm('End the current song for everyone and move on?')) return;
    try {
      await session.nextSong();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const hasSong = Boolean(meet.trackId || meet.catalogTrackId);
  const start = async () => {
    try {
      await session.start(LEAD_MS);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const end = async () => {
    if (!confirm('End this meet for everyone?')) return;
    try {
      await session.stopMeet();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  // Audience: hear the stage — the host's device sends the blend (track + every vocal, after FX) a second at a
  // time; it plays here a couple of seconds behind, the lyrics following the sound. When no mix arrives (the
  // host's browser cannot send one), the backing track plays here instead, in sync with the shared transport.
  const pbState = meet.playback?.state ?? 'idle';
  const pbEpoch = meet.playback?.epoch ?? 0;
  const mixRef = useRef<MixPlayer | null>(null);
  const [mixState, setMixState] = useState<{ hearing: boolean; silent: boolean; seq: number; behindS: number }>({ hearing: false, silent: false, seq: 0, behindS: 0 });
  // The show itself (the publisher's broadcast), when it is on: the audience watches it here; its sound replaces the mix.
  const liveStatus = useLiveStatus(meet.meetId);
  const [show, setShow] = useState<LiveShowState>({ live: false, audio: false, playing: false });
  const showHasSound = show.playing && show.audio;
  useEffect(() => {
    if (!listen || onStage || showHasSound) return;
    const e = props.engine ?? getEngine(); // the audience has no mic open: the engine is only the speaker here
    void e.resume();
    if (!mixPlaySupported()) {
      setMixState({ hearing: false, silent: true, seq: 0, behindS: 0 });
      return;
    }
    const mp = new MixPlayer(e.ctx, e.master, (since) => session.fetchMix(since));
    mixRef.current = mp;
    mp.start();
    const t = setInterval(() => setMixState({ ...mp.state.value }), 500);
    return () => {
      clearInterval(t);
      mp.stop();
      mixRef.current = null;
    };
  }, [listen, props.engine, onStage, showHasSound]);
  const fallbackTrack = listen && mixState.silent && !showHasSound;
  useEffect(() => {
    const e = fallbackTrack ? (props.engine ?? getEngine()) : null;
    if (!fallbackTrack || !e || !props.track?.loaded || meet.kickstartEpochMs === null || pbState !== 'playing') return;
    let player = e.player;
    let stopped = false;
    const run = async () => {
      await e.resume(); // the speaker engine's player exists once it runs
      player = e.player;
      if (!player || stopped) return;
      if (!player.buffer) await player.load(props.track!.loaded!.audio, props.track!.loaded!.track.trackId);
      const localStart = meet.kickstartEpochMs! - clock.value.offsetMs;
      const startIn = (localStart - Date.now()) / 1000;
      const offset = meet.playback?.offsetMs ?? 0;
      if (stopped) return;
      if (startIn >= 0) player.play(e.ctx.currentTime + startIn, offset);
      else player.play(e.ctx.currentTime, offset - startIn * 1000);
    };
    void run();
    return () => {
      stopped = true;
      player?.stop();
    };
  }, [fallbackTrack, meet.kickstartEpochMs, pbState, pbEpoch]);
  // What the audience reads follows what it hears.
  const heardMs = mixState.hearing ? (mixRef.current?.positionMs() ?? null) : null;
  const audienceTMs = heardMs ?? tMs;

  return (
    <Page title={meet.title} right={<span class={`chip ${live ? 'ok' : ''}`}>{meet.state}</span>}>
      <div class="stack">
        <section class="card stack pad-sm">
          <div class="row between">
            <div>
              <div class="small muted">Host {meet.hostName} · {meet.trackTitle || 'no track yet'}</div>
              <div class="row" style="gap:8px">
                <span class="mono" style="font-size:1.3em;letter-spacing:.2em">{meet.joinCode}</span>
                <button class="btn sm" onClick={() => void share()}>
                  <IcShare size={16} /> Share link
                </button>
                {privileged.value && (
                  <a class="btn sm" href={href(`/publishing/show/${encodeURIComponent(meet.meetId)}`)} target="_blank" rel="noopener" title="Publishing mode: the broadcast picture (performers huge, no lyrics), in a new tab">
                    Show view
                  </a>
                )}
              </div>
            </div>
            <div class="small muted" style="text-align:right">
              <div>
                <IcUsers size={14} /> {meet.performerCount} on stage · {meet.audienceCount} watching
              </div>
              <div class={msLeft < 60_000 ? 'chip warn' : ''}>closes in {formatMs(msLeft)} without activity</div>
            </div>
          </div>
          <SaveStatus />
        </section>

        {live && (
          <section class="card accent stack">
            <h2>{countingDown ? `${meet.playback?.offsetMs ? 'Resuming' : 'Starting'} in ${Math.max(0, Math.ceil(-(serverNow() - meet.kickstartEpochMs!) / 1000))}s` : pbState === 'paused' ? 'Paused by the host' : 'Live now'}</h2>
            {onStage ? (
              <button class="btn primary lg" disabled={props.preparing || !props.track?.loaded} onClick={() => void props.onPrepare()}>
                {props.preparing ? <Spinner /> : <IcMic />} Join the song on stage
              </button>
            ) : (
              <>
                {/* The audience's picture: the show when the publisher is on air; the stage background and who is on it otherwise. Never lyrics — those are the singers'. */}
                <div class="watch-stage" style="height:240px">
                  <StageBackground id={meet.backgroundId} />
                  <LiveShow meetId={meet.meetId} status={liveStatus} onState={setShow}>
                    <div class="watch-center">
                      <div class="stack" style="text-align:center;justify-items:center">
                        <div class="muted small">{meet.trackTitle || 'On stage'} · {formatMs(Math.max(0, audienceTMs))}</div>
                        <div class="small faint">{meet.performerCount} on stage — the show picture appears here when the publisher goes live</div>
                      </div>
                    </div>
                  </LiveShow>
                </div>
                {showHasSound ? (
                  <div class="small muted">The show's own sound — the track and every singer, blended.</div>
                ) : (
                  <>
                    <label class="switch">
                      <input type="checkbox" checked={listen} onChange={(e) => setListen((e.currentTarget as HTMLInputElement).checked)} />
                      <span>Hear the stage — the singers and the track, blended</span>
                    </label>
                    {listen && (
                      <div class="small muted" data-mix-hearing={mixState.hearing ? '1' : '0'} data-mix-seq={mixState.seq}>
                        {mixState.hearing
                          ? `Hearing the stage · ${mixState.behindS.toFixed(1)} s behind`
                          : mixState.silent
                            ? mixPlaySupported()
                              ? `No sound from the stage yet (the host's device sends it once a song runs)${props.track?.loaded ? ' — playing the backing track here meanwhile' : ''}`
                              : `This browser cannot play the stage mix${props.track?.loaded ? ' — playing the backing track here instead' : ''}`
                            : 'Tuning in…'}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        )}

        <Seg<'stage' | 'chat'>
          value={tab}
          onChange={setTab}
          options={[
            { v: 'stage', label: 'Stage' },
            { v: 'chat', label: `Chat (${session.chat.value.length})` },
          ]}
        />

        {tab === 'stage' && (
          <section class="stack">
            {/* The stage is live from the start: whoever steps on appears here at once (own cut-out; other performers' video on stage devices). */}
            <StageStrip stage={stage} meet={meet} onStage={onStage} />
            <SetListPanel session={session} meet={meet} you={you} track={props.track} host={host} onStage={onStage} live={live} />
            {host && meet.requests.length > 0 && (
              <div class="card stack pad-sm requests" data-requests={meet.requests.length}>
                <div class="row between">
                  <b>Wait list · {meet.requests.length}</b>
                  {live && <span class="chip warn">a song is running — seat them when it is over</span>}
                </div>
                {meet.requests.map((r) => (
                  <div class="row between" key={r.participantId}>
                    <span class="row" style="gap:8px">
                      {r.picture ? <img class="avatar-sm" src={r.picture} alt="" referrerpolicy="no-referrer" /> : <span class="avatar-sm">{(r.displayName || '?').charAt(0).toUpperCase()}</span>}
                      <span>
                        <b>{r.displayName}</b> <span class="small muted">wants to sing</span>
                      </span>
                    </span>
                    <span class="row" style="gap:6px;flex-wrap:nowrap">
                      <button class="btn sm primary" disabled={live || deciding === r.participantId || meet.performerCount >= MAX_PERFORMERS} title={live ? 'Once the song is over' : undefined} aria-label={`Let ${r.displayName} sing`} onClick={() => void decide(r.participantId, true)}>
                        <IcCheck size={16} /> Let them sing
                      </button>
                      <button class="btn sm" disabled={deciding === r.participantId} aria-label={`Decline ${r.displayName}`} onClick={() => void decide(r.participantId, false)}>
                        <IcX size={16} /> Not now
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div class="stage-grid">
              {meet.stage.map((s) => (
                <SlotCard key={s.slot} slot={s} mine={s.participantId === you.participantId} canClaim={!s.participantId && (onStage || (!live && (host || openStage)))} onClaim={() => void claim(s.slot)} onRemove={host && s.participantId && s.participantId !== you.participantId ? () => void remove(s.participantId!) : undefined} />
              ))}
            </div>
            <div class="row">
              {onStage ? (
                <>
                  {hasSong &&
                    (!props.prepared ? (
                      <button class="btn accent" disabled={props.preparing || !props.track?.loaded} title={props.track?.loaded ? undefined : 'Loading the song on this device…'} onClick={() => void props.onPrepare()}>
                        {props.preparing ? <Spinner /> : <IcMic />} {live ? 'Join the song on stage' : "I'm ready (mic & camera check)"}
                      </button>
                    ) : (
                      <span class="chip ok">{live ? 'Joining the song…' : 'Ready — stage will start automatically'}</span>
                    ))}
                  <button class="btn" onClick={() => void claim(null)}>
                    Leave stage
                  </button>
                  {props.prepared && <MicStatus engine={props.engine} onChange={() => void reopenMic(props.engine)} />}
                </>
              ) : host || openStage ? (
                live ? (
                  <span class="chip warn">A song is running — take a slot once it is over</span>
                ) : (
                  <button class="btn primary" disabled={meet.performerCount >= MAX_PERFORMERS} onClick={() => void claim(meet.stage.find((s) => !s.participantId)?.slot ?? null)}>
                    <IcMic /> Take a stage slot
                  </button>
                )
              ) : askState === 'pending' ? (
                <>
                  <span class="chip warn">On the wait list{live ? ' — the host seats singers once the song is over' : ` — waiting for ${meet.hostName}`}</span>
                  <button class="btn sm" onClick={() => void withdraw()}>
                    Withdraw
                  </button>
                </>
              ) : (
                <>
                  <button class="btn primary" disabled={meet.performerCount >= MAX_PERFORMERS} title={live ? 'A song is running — you join the wait list and step on once it is over' : undefined} onClick={() => void ask()}>
                    <IcMic /> {askState === 'declined' ? 'Ask again to sing' : live ? 'Ask to sing next' : 'Ask to sing'}
                  </button>
                  {askState === 'declined' && <span class="chip">The host said not now</span>}
                </>
              )}
              {host && !live && (
                <button class="btn accent" disabled={meet.performerCount === 0 || !hasSong} title={!hasSong ? 'Pick a song first' : undefined} onClick={() => void start()}>
                  <IcPlay /> Start the song (8 s count-in)
                </button>
              )}
              {host && live && (
                <button class="btn" onClick={() => void endSong()}>
                  <IcMusic size={16} /> End the song
                </button>
              )}
              {host && (
                <button class="btn danger" onClick={() => void end()}>
                  <IcStop /> End meet
                </button>
              )}
            </div>
            {host && <Switch checked={openStage} onChange={(v) => void setPolicy(v)} label="Open stage: anyone may take a free slot" hint={openStage ? 'Switch off to be asked first' : 'Off: the audience asks, you decide who sings'} />}
            <div class="small muted">
              Audience ({props.participants.filter((p) => p.slot === null && p.role !== 'publisher').length}): {props.participants.filter((p) => p.slot === null && p.role !== 'publisher').map((p) => p.displayName).join(', ') || 'nobody yet'}
              {!host && !onStage && !openStage && ' · ask to sing and the host lets you on stage between songs'}
            </div>
            {meet.stage.some((s) => s.participantId && s.rttMs !== null) && (
              <div class="small faint">
                Sync: {meet.stage.filter((s) => s.participantId && s.rttMs !== null).map((s) => `${s.displayName} ±${Math.round((s.rttMs ?? 0) / 2)} ms`).join(' · ')} — every device starts the track at the same server instant.
              </div>
            )}
          </section>
        )}
        {tab === 'chat' && <Chat session={session} />}
      </div>
    </Page>
  );
}


function SlotCard(props: { slot: StageSlot; mine: boolean; canClaim: boolean; onClaim: () => void; onRemove?: () => void }) {
  const s = props.slot;
  return (
    <div class={`slot-card ${s.participantId ? 'taken' : ''} ${props.mine ? 'mine' : ''}`} style={{ borderColor: SLOT_COLORS[s.slot as SingerSlot] }}>
      <button type="button" class="slot-take" disabled={!props.canClaim} onClick={props.onClaim} aria-label={s.participantId ? `Slot ${s.slot}: ${s.displayName}` : `Take slot ${s.slot}`}>
        <span class="slot-badge" style={{ background: SLOT_COLORS[s.slot as SingerSlot] }}>S{s.slot}</span>
        <span class="name">{s.participantId ? s.displayName : 'open'}</span>
        {s.participantId && <span class={`chip ${s.ready ? 'ok' : ''}`}>{s.ready ? 'ready' : 'joined'}</span>}
      </button>
      {props.onRemove && (
        <button type="button" class="slot-remove" aria-label={`Clear slot ${s.slot} (${s.displayName})`} title="Clear this slot" onClick={props.onRemove}>
          <IcX size={14} />
        </button>
      )}
    </div>
  );
}

/** The virtual stage in the lobby: everyone on stage, cut out of their cameras (own video; others' on stage devices). */
function StageStrip(props: { stage: RoomStage; meet: Meet; onStage: boolean }) {
  const { stage, meet } = props;
  const app = appSettings.value;
  const n = meet.stage.filter((s) => s.participantId).length;
  return (
    <div class="stagestrip" data-blend={stage.blend} data-mask={stage.feed.segmenter.maskMode} data-performers={n} data-linked={stage.linked} data-onstage={props.onStage ? '1' : '0'}>
      <div class="showpic">
        <StageBackground id={meet.backgroundId} />
        <VirtualStage compositor={stage.compositor} />
        {!n && (
          <div class="show-center">
            <h2>The stage is empty</h2>
            <p class="muted">Take a slot and you are on it at once — the show runs from now on, the song is one act of it.</p>
          </div>
        )}
      </div>
      <div class="stagebar">
        <span class="chip">
          <IcUsers size={14} /> {n} on stage{props.onStage && stage.others ? ` · ${stage.linked}/${stage.others} video linked` : ''}
        </span>
        {props.onStage && stage.camOn && stage.blend === 'loading' && <span class="chip">blending you into the stage…</span>}
        {props.onStage && !stage.camOn && app.cameraOn && (
          <button class="btn sm accent" style="pointer-events:auto" onClick={() => void stage.openCamera()}>
            <IcCamera size={16} /> Turn the camera on
          </button>
        )}
        {props.onStage && stage.camError && <span class="chip warn">camera: {stage.camError}</span>}
        {props.onStage && (
          <button class={`btn sm ${app.cameraOn ? '' : 'accent'}`} style="pointer-events:auto" aria-label={app.cameraOn ? 'Camera off' : 'Camera on'} onClick={() => updateApp({ cameraOn: !app.cameraOn })}>
            {app.cameraOn ? <IcCameraOff size={16} /> : <IcCamera size={16} />}
          </button>
        )}
      </div>
    </div>
  );
}

function Chat(props: { session: MeetSession }) {
  const [text, setText] = useState('');
  const list = props.session.chat.value;
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [list.length]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      await props.session.say(t);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <section class="stack">
      <div class="chat-log">
        {!list.length && <div class="muted small">No messages yet — say hi.</div>}
        {list.map((m) => (
          <div key={m.seq} class="chat-msg">
            <b>{m.displayName}</b> <span class="faint small">{new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <div>{m.text}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div class="row">
        <input class="input" style="flex:1" value={text} maxLength={500} placeholder="Message everyone" onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
        <button class="btn primary" onClick={() => void send()}>
          <IcChat /> Send
        </button>
      </div>
    </section>
  );
}

// ---------------- Live stage (performer) ----------------

function LiveStage(props: {
  session: MeetSession;
  meet: Meet;
  you: Participant;
  loaded: NonNullable<MeetTrack['loaded']>;
  engine: AudioEngine;
  camera: Camera;
  stage: RoomStage;
  track: MeetTrack | null;
  prepared: boolean;
  onPrepare: () => Promise<void>;
  onTake: (t: TakeResult, loaded: NonNullable<MeetTrack['loaded']>, singers: { slot: number; displayName: string; userId?: string }[]) => void;
  /** A take is in progress (from the first cue until it wraps up). */
  onSinging: (singing: boolean) => void;
  participants: Participant[];
}) {
  const { session, meet, engine, camera, loaded, stage } = props;
  const { feed, compositor, blend, peerStates, show } = stage;
  const [tMs, setTMs] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [finishing, setFinishing] = useState(false);
  /** The set list drawer over the stage: see what is next, add a song, (host) end the song. */
  const [songsOpen, setSongsOpen] = useState(false);
  /** Who was on stage during this take (the manifest and the meet's performance name them). */
  const singersRef = useRef<{ slot: number; displayName: string; userId?: string }[]>([]);
  /** While paused: the track position the vocal recording's end corresponds to (a resume elsewhere jumps the take there). */
  const recPos = useRef(0);
  /** The take's timeline origin (context time of track position 0 at the first cue): pauses and jumps never move it. */
  const takeOrigin = useRef(0);
  /** A seek on its way: where the song is about to jump (cleared when the cue lands). */
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const raf = useRef(0);
  const scheduledEpoch = useRef(0);
  const pausedLocally = useRef(false);
  const app = appSettings.value;
  const audio = audioSettings.value;
  const track = loaded.track;
  const mySlot = Math.max(1, Math.min(track.singerCount, props.you.slot ?? 1)) as SingerSlot;
  const host = props.you.userId === meet.hostUserId;
  const pb = meet.playback ?? { state: 'idle' as const, offsetMs: 0, pausedAtMs: 0, pauseAtEpochMs: null, epoch: 0 };
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    engine.applyFx(audio.params);
    engine.setMonitor(audio.monitor);
    engine.player?.setGain(audio.backingGain);
  }, [audio]);

  // The room's stage (camera, cut-out, mesh) is already running since the lobby; here the lyrics sit above the performers.
  useEffect(() => {
    compositor.mode = 'stage';
    return () => {
      compositor.mode = 'show';
    };
  }, []);
  const camOn = stage.camOn;
  const stagePerformers = meet.stage.filter((s) => s.participantId);
  useEffect(() => {
    if (!started) return;
    const seen = new Map(singersRef.current.map((x) => [x.slot, x]));
    for (const s of stagePerformers) {
      const userId = props.participants.find((p) => p.participantId === s.participantId)?.userId;
      seen.set(s.slot, { slot: s.slot, displayName: s.displayName, ...(userId ? { userId } : {}) });
    }
    singersRef.current = [...seen.values()].sort((a, b) => a.slot - b.slot);
  }, [started, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|')]);

  // ---- follow the shared transport: schedule playback + recording at every kickstart (start / resume / restart) ----
  useEffect(() => {
    const ks = meet.kickstartEpochMs;
    if (ks === null || !props.prepared || pb.state !== 'playing' || scheduledEpoch.current === pb.epoch) return;
    const player = engine.player;
    if (!player?.buffer) return;
    const firstCue = scheduledEpoch.current === 0;
    scheduledEpoch.current = pb.epoch;
    const localStart = ks - clock.value.offsetMs; // server instant in local epoch ms
    const startIn = (localStart - Date.now()) / 1000;
    const t0 = engine.ctx.currentTime + Math.max(0, startIn);
    const offsetMs = pb.offsetMs + (startIn < 0 ? -startIn * 1000 : 0); // late join → start mid-song
    if (firstCue) {
      void engine.recorder?.start();
      player.play(t0, offsetMs);
      takeOrigin.current = player.originCtxTime();
      recPos.current = offsetMs;
      // The show — the stage with everyone and the whole mix — records from the kickstart.
      show.start(engine, t0);
      setStarted(true);
      props.onSinging(true);
    } else if (player.playing && !pausedLocally.current) {
      // A jump while playing (a seek, a restart from the top): the song keeps playing and jumps at the cued
      // instant — the same instant on every device — and the take follows it on the track timeline.
      const delta = offsetMs - player.positionAt(t0);
      player.cue(t0, offsetMs);
      if (Math.abs(delta) > 30) engine.recorder?.seek(t0, delta);
    } else {
      // Resume (from our pause — or a pause we only learned of late): the recorder kept the take on the
      // track timeline by dropping the pause; a seek made while paused moves it there too.
      clearTimeout(pauseTimer.current);
      if (!pausedLocally.current) {
        recPos.current = player.positionAt(engine.ctx.currentTime);
        engine.recorder?.pause(engine.ctx.currentTime);
        player.pause();
      }
      pausedLocally.current = false;
      player.play(t0, offsetMs);
      engine.recorder?.resume(t0);
      const delta = offsetMs - recPos.current;
      if (Math.abs(delta) > 30) engine.recorder?.seek(t0, delta);
      show.resume();
    }
    setSeekTarget(null);
    // The song's natural end calls the *latest* finish (through a ref): the one in this closure was made before
    // `started` became true and would return at once — a song nobody paused or seeked would never finish.
    player.onEnded = () => {
      (window as unknown as { __svEnded?: unknown }).__svEnded = Date.now(); // support / e2e
      void finishRef.current();
    };
    cancelAnimationFrame(raf.current);
    const tick = () => {
      const nowCtx = engine.ctx.currentTime;
      if (nowCtx < t0) setCountdown(Math.ceil(t0 - nowCtx));
      else {
        setCountdown(null);
        setTMs(Math.max(0, player.positionMs() - engine.outputLatencyMs));
      }
      (window as unknown as { __svPos?: unknown }).__svPos = { posMs: Math.round(player.positionMs()), epoch: pb.epoch, state: pb.state, offsetMs: pb.offsetMs, ks: meet.kickstartEpochMs, playing: player.playing }; // support / e2e
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [meet.kickstartEpochMs, pb.epoch, pb.state, props.prepared]);

  // Host paused: the pause is cued at a shared server instant — stop exactly there (sample-accurate for
  // the recorder, since the instant is converted to our own audio clock). A device that only learns of
  // it after the instant stops immediately and re-aligns on resume.
  const pauseAt = pb.pauseAtEpochMs;
  useEffect(() => {
    clearTimeout(pauseTimer.current);
    if (!started) return;
    const player = engine.player;
    if (!player) return;
    const doPause = (ctxAt: number) => {
      if (pausedLocally.current) return;
      pausedLocally.current = true;
      if (player.playing) {
        recPos.current = player.positionAt(ctxAt);
        player.pause();
        engine.recorder?.pause(ctxAt);
      } else recPos.current = player.positionMs();
      player.seek(pb.pausedAtMs);
      setTMs(pb.pausedAtMs);
      show.pause();
    };
    if (pb.state === 'paused') {
      if (!pausedLocally.current) doPause(engine.ctx.currentTime);
      else if (Math.abs(player.positionMs() - pb.pausedAtMs) > 1) {
        // A seek while paused: everyone's paused position moves; the take jumps there on resume.
        player.seek(pb.pausedAtMs);
        setTMs(pb.pausedAtMs);
      }
      setSeekTarget(null);
      return;
    }
    if (pb.state === 'playing' && pauseAt !== null) {
      const localInstant = pauseAt - clock.value.offsetMs; // server instant → local epoch ms
      const inMs = localInstant - Date.now();
      const ctxAt = engine.ctx.currentTime + Math.max(0, inMs) / 1000;
      if (inMs <= 0) doPause(ctxAt);
      else pauseTimer.current = setTimeout(() => doPause(ctxAt), inMs);
    }
    return () => clearTimeout(pauseTimer.current);
  }, [pb.state, pauseAt, pb.pausedAtMs, started]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      props.onSinging(false);
    },
    [],
  );

  // The song is over (its track ended on the host's device, or the host ended it) or the meet ended → wrap up the personal take.
  useEffect(() => {
    if (started && (meet.state === 'lobby' || meet.state === 'ended' || meet.state === 'expired')) void finish();
  }, [meet.state]);

  const finishRef = useRef<() => Promise<void>>(async () => undefined);
  const finish = async () => {
    (window as unknown as { __svFinish?: unknown }).__svFinish = { at: Date.now(), finishing, started, step: 'called' }; // support / e2e
    if (finishing || !started) return;
    setFinishing(true);
    cancelAnimationFrame(raf.current);
    try {
      const player = engine.player!;
      const origin = takeOrigin.current || player.originCtxTime();
      const durationMs = Math.round(player.positionMs());
      player.onEnded = null;
      player.stop();
      let vocal = new Blob([], { type: 'audio/wav' });
      let vocalOffsetMs = 0;
      let sampleRate = engine.ctx.sampleRate;
      if (engine.recorder?.recording) {
        const rec = await engine.recorder.stop();
        vocal = rec.wav;
        sampleRate = rec.sampleRate;
        vocalOffsetMs = (rec.startCtxTime - origin) * 1000;
      }
      // The show's first frame shows the stage as it was a lag earlier (its sources are held back to meet the others).
      const rec = await show.stop();
      const video = rec?.video ?? null;
      const videoOffsetMs = rec ? (rec.startCtxTime - origin) * 1000 - rec.lagMs : null;
      engine.closeMic();
      await keepAwake(false);
      (window as unknown as { __svFinish?: unknown }).__svFinish = { at: Date.now(), step: 'stopped', host, state: meet.state };
      // The host's take ending ends the song for everyone: the meet goes back to the lobby, next song up.
      if (host && (meet.state === 'live' || meet.state === 'countdown')) void session.nextSong().catch(() => undefined);
      props.onTake(
        {
          vocal,
          video,
          durationMs,
          vocalOffsetMs: Math.round(vocalOffsetMs),
          videoOffsetMs: videoOffsetMs === null ? null : Math.round(videoOffsetMs),
          latencyCompMs: Math.round(engine.outputLatencyMs * 2),
          sampleRate,
          startedAtEpochMs: meet.kickstartEpochMs ?? Date.now(),
        },
        loaded,
        singersRef.current,
      );
      props.onSinging(false);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
      setFinishing(false);
    }
  };

  finishRef.current = finish;
  const transport = async (what: 'pause' | 'resume' | 'restart') => {
    try {
      if (what === 'pause') await session.pause(3000);
      else if (what === 'resume') await session.resume(4000);
      else await session.restart(3000, 0);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  /** Move the song back or forth for everyone: cued, so every device jumps at the same instant (the take follows). */
  const seek = async (ms: number) => {
    if (!started) return;
    const to = Math.max(0, Math.min(track.durationMs, ms));
    setSeekTarget(to);
    try {
      await session.seek(to, paused ? 0 : 3000);
    } catch (e) {
      setSeekTarget(null);
      toast(errorText(e), 'warn');
    }
  };

  const others = stagePerformers.filter((s) => s.participantId !== props.you.participantId);
  const connected = others.filter((s) => peerStates[s.participantId!] === 'connected').length;
  const level = engine.recorder?.level.value ?? 0;
  const paused = pb.state === 'paused';

  return (
    <Page title={meet.title} nav={false} full>
      <div class="sing">
        <StageBackground id={meet.backgroundId} />
        <VirtualStage compositor={compositor} />
        <section class="stagebar" data-blend={blend} data-mask={feed.segmenter.maskMode} data-performers={compositor.tiles.length}>
          <span class="chip">
            <IcUsers size={14} /> {stagePerformers.length} on stage{others.length ? ` · ${connected}/${others.length} video linked` : ''}
          </span>
          {camOn && blend === 'loading' && <span class="chip">blending you into the stage…</span>}
          {camOn && blend === 'oval' && app.cutout && <span class="chip warn">soft-focus mode</span>}
          {paused && <span class="chip warn">paused</span>}
          {!paused && pauseAt !== null && <span class="chip warn">pausing…</span>}
          {seekTarget !== null && !paused && <span class="chip warn">jumping to {formatMs(seekTarget)}…</span>}
          {host && meet.requests.length > 0 && <span class="chip">wait list · {meet.requests.length} — seated when the song is over</span>}
          <SaveStatus compact />
        </section>
        <LyricsPanel lines={track.lyrics} tMs={tMs} mySlot={mySlot} countdown={countdown} showWho={track.singerCount > 1} title={track.title} />
        {songsOpen && (
          <div class="drawer" role="dialog" aria-label="Set list">
            <div class="row between">
              <b>Set list</b>
              <button class="btn icon sm" aria-label="Close the set list" onClick={() => setSongsOpen(false)}>
                <IcX size={16} />
              </button>
            </div>
            <SetListPanel session={session} meet={meet} you={props.you} track={props.track} host={host} onStage live compact />
          </div>
        )}
        {app.showCueDeck && track.singerCount > 1 && started && countdown === null && <CueDeck lines={track.lyrics} tMs={tMs} mySlot={mySlot} />}
        <section class="controls">
          <PresetChips value={audio} onChange={updateAudio} />
          <MicStatus engine={engine} onChange={() => void reopenMic(engine)} />
          <SeekBar tMs={tMs} durationMs={track.durationMs} onSeek={started && props.prepared ? (ms) => void seek(ms) : undefined} pending={seekTarget} disabled={countdown !== null} />
          <div class="main">
            <button class={`btn icon ${app.cameraOn ? 'on' : ''}`} aria-label="Camera" onClick={() => updateApp({ cameraOn: !app.cameraOn })}>
              {app.cameraOn ? <IcCamera /> : <IcCameraOff />}
            </button>
            <button class={`btn icon ${audio.monitor ? 'on' : ''}`} aria-label="Hear myself" onClick={() => updateAudio({ monitor: !audio.monitor })}>
              <IcHeadphones />
            </button>
            <button class={`btn icon ${songsOpen ? 'on' : ''}`} aria-label="Set list" title="Set list: what's next, add a song" aria-pressed={songsOpen} onClick={() => setSongsOpen((o) => !o)}>
              <IcMusic />
            </button>
            {!props.prepared ? (
              <button class="btn big primary" onClick={() => void props.onPrepare()}>
                <IcMic /> Join the song
              </button>
            ) : started ? (
              <>
                {paused ? (
                  <button class="btn big primary" aria-label="Resume for everyone" onClick={() => void transport('resume')}>
                    <IcPlay /> Resume
                  </button>
                ) : (
                  <button class="btn big" aria-label="Pause for everyone" disabled={countdown !== null || pauseAt !== null} onClick={() => void transport('pause')}>
                    <IcPause /> {pauseAt !== null ? 'Pausing…' : 'Pause'}
                  </button>
                )}
                <button class="btn" aria-label="Restart the song for everyone" title="Restart from the top — for everyone on stage" onClick={() => void transport('restart')}>
                  <IcSkipBack /> Restart
                </button>
                <button class="btn big accent" disabled={finishing} aria-label={host ? 'Stop the song for everyone' : 'Stop my take'} title={host ? 'Stops the song for everyone — the next one on the set list comes up' : 'Stops your take (the song goes on for the others)'} onClick={() => void finish()}>
                  {finishing ? <Spinner /> : <IcStop />} {host ? 'Stop song' : 'Stop'}
                </button>
              </>
            ) : (
              <button class="btn big primary" disabled>
                <Spinner /> Waiting for the kickstart…
              </button>
            )}
            <span class="pitch-pill">
              <span class="dot" style={{ background: level > 0.9 ? 'var(--danger)' : 'var(--ok)', opacity: 0.4 + level * 0.6 }} /> ±{Math.round(clock.value.rttMs / 2)} ms
            </span>
            <span class="chip" style={{ borderColor: SLOT_COLORS[mySlot] }}>S{mySlot}</span>
          </div>
          <MixBalance />
        </section>
      </div>
    </Page>
  );
}

// ---------------- Ended ----------------

function Ended(props: { session: MeetSession; meet: Meet; you: Participant }) {
  const { meet } = props;
  const snap = props.session.snapshot.value;
  const recs = snap?.recordings ?? [];
  const shows = snap?.performances ?? [];
  const host = props.you.userId === meet.hostUserId;
  const canPublish = privileged.value;
  const shareShow = async (p: { songTitle: string; videoLink: string | null; link: string | null }) => {
    const url = p.videoLink ?? p.link;
    if (!url) return toast('This performance has no link yet (the host saved it without Drive)', 'warn');
    const r = await shareOrCopy(`${meet.title} — ${p.songTitle}`, 'A SingersVoice performance', url);
    toast(r === 'copied' ? 'Link copied' : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok');
  };
  return (
    <Page title={meet.title}>
      <div class="stack">
        <div class="review-hero">
          <h2>{meet.state === 'expired' ? 'This meet closed after 5 idle minutes' : 'Meet ended'}</h2>
          <div class="muted small">
            {meet.trackTitle || 'no track'} · host {meet.hostName} · {new Date(meet.createdAt).toLocaleString()}
          </div>
        </div>
        <section class="card stack">
          <h3>Performances of this meet</h3>
          <div class="muted small">One per song: the show — everyone on stage over the stage background, with the whole mix — saved by the host and shared with everyone who was in the meet. Find them any time under Performances.</div>
          {!shows.length && <div class="muted small">No song was recorded in this meet.</div>}
          <div class="list">
            {shows.map((p) => (
              <div class="item wide-actions" key={p.performanceId} data-performance={p.performanceId}>
                <div class="thumb">
                  <IcPlay size={18} />
                </div>
                <div class="meta">
                  <div class="t">{p.songTitle || 'Untitled song'}</div>
                  <div class="s">
                    {new Date(p.createdAt).toLocaleString()} · {formatMs(p.durationMs)} · {p.singers.map((x) => x.displayName.split(' ')[0]).join(', ') || p.hostName}
                  </div>
                </div>
                <div class="actions">
                  {(p.videoLink ?? p.link) && (
                    <a class="btn sm" href={p.videoLink ?? p.link ?? '#'} target="_blank" rel="noopener">
                      Watch
                    </a>
                  )}
                  <button class="btn sm" onClick={() => void shareShow(p)}>
                    <IcShare size={14} /> Share
                  </button>
                </div>
              </div>
            ))}
          </div>
          <a class="btn" href={href('/studio/performances')}>
            All performances
          </a>
        </section>
        <section class="card stack">
          <h3>Personal takes from this meet</h3>
          {!recs.length && <div class="muted small">No takes were registered. Each singer's take stays in their own Drive (Performances › Live).</div>}
          <div class="list">
            {recs.map((r) => (
              <div class="item" key={r.performanceId}>
                <div class="thumb">
                  <IcMic size={18} />
                </div>
                <div class="meta">
                  <div class="t">
                    {r.displayName} {r.slot ? <span class="slot-badge" style={{ background: SLOT_COLORS[r.slot as SingerSlot] }}>S{r.slot}</span> : null}
                  </div>
                  <div class="s">{formatMs(r.durationMs)} · {new Date(r.createdAt).toLocaleTimeString()}</div>
                </div>
                {r.driveFolderLink ? (
                  <a class="btn sm" href={r.driveFolderLink} target="_blank" rel="noopener">
                    Drive
                  </a>
                ) : (
                  <span class="chip">private</span>
                )}
              </div>
            ))}
          </div>
        </section>
        <div class="row">
          <a class="btn primary" href={href('/meets')}>
            Create another meet
          </a>
          <a class="btn" href={href('/studio/performances')}>
            My performances
          </a>
          {host && canPublish && (
            <a class="btn" href={href(`/publishing?meet=${encodeURIComponent(meet.meetId)}`)}>
              Publish this meet
            </a>
          )}
        </div>
      </div>
    </Page>
  );
}
