/**
 * Meet room (/meet/:id): lobby with stage slots + chat, the clock-synced live stage for
 * performers (GMT kickstart), the audience view, and the ended/expired summary.
 * Nothing is recorded per song on a singer's device: the record of a meet is its film — one file
 * for the whole meet, the stage with everyone on it and the whole mix as Publisher mode shows it,
 * a chapter mark where each song starts — kept by the host's device in the host's Drive
 * (`roomStage.ts` → `video/meetRecorder.ts`) and shared, in the background (`meetFilm.ts`), with
 * everyone who was in the meet. Nothing here ever waits for a review or an approval.
 */
import { clampSlot, formatMs, hoursLabel, MAX_PERFORMERS, planParts, playbackPositionMs, SLOT_COLORS, songChoicePending, type Meet, type Participant, type SingerSlot, type StageSlot } from '@singersvoice/protocol';
import { activeRoomInfo } from './activeRoom.ts';
import { useRoomStage, type RoomStage } from './roomStage.ts';
import { SetListPanel } from './SetListPanel.tsx';
import { effect, useSignal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getEngine, type AudioEngine } from '../../audio/engine.ts';
import { MixPlayer, mixPlaySupported } from '../../audio/mixPlayer.ts';
import { StageBackground, StageBackgroundChoice } from '../../components/BackgroundPicker.tsx';
import { VirtualStage } from '../../components/VirtualStage.tsx';
import { FxPanel, PresetChips } from '../../components/FxPanel.tsx';
import { IcCamera, IcCameraOff, IcChat, IcCheck, IcHeadphones, IcImage, IcMic, IcMusic, IcPause, IcPlay, IcShare, IcSkipBack, IcSliders, IcStop, IcTv, IcUsers, IcX, IcZoom } from '../../components/icons.tsx';
import { KaraokeVideo } from '../../components/KaraokeVideo.tsx';
import { CueDeck, LyricsPanel } from '../../components/LyricsPanel.tsx';
import { LiveShow, useLiveStatus, type LiveShowState } from '../../components/LiveShow.tsx';
import { MixBalance } from '../../components/MixBalance.tsx';
import { audienceLine } from './audience.ts';
import { PictureChoices } from '../../components/PictureChoices.tsx';
import { TvPanel } from '../../components/TvPanel.tsx';
import { tvLink } from '../../lib/tv.ts';
import { Page } from '../../components/Shell.tsx';
import { Seg, Sheet, Spinner, Switch } from '../../components/ui.tsx';
import { ApiError, clock, controlConfigured, refreshAccount, serverNow } from '../../lib/api.ts';
import { ServiceBanner } from '../../components/ServiceBanner.tsx';
import { recordAccess } from '../../lib/registry.ts';
import { shareOrCopy } from '../../lib/download.ts';
import { href, safeHref } from '../../lib/nav.ts';
import { isIOS, keepAwake } from '../../lib/platform.ts';
import { errorText, toast } from '../../lib/toast.ts';
import { canPublish as canPublishSignal } from '../../state/session.ts';
import { appSettings, audioSettings, updateApp, updateAudio } from '../../state/settings.ts';
import { Camera } from '../../video/camera.ts';
import { openMicWithCamera, restartCamera } from '../../video/capture.ts';
import { filmSound, type MeetRecorder } from '../../video/meetRecorder.ts';
import { LevelDot, MicStatus } from '../../components/MicStatus.tsx';
import { SaveStatus } from '../../components/SaveStatus.tsx';
import { NoticeCenter } from '../../components/NoticeCenter.tsx';
import { useStageNotices } from './stageNotices.ts';
import { SeekBar } from '../../components/SeekBar.tsx';
import { marksLine } from '../../video/chapters.ts';
import { MeetSession } from './meetSession.ts';
import { keepMeetTrack, loadMeetTrack, type MeetTrack } from './trackSource.ts';

const LEAD_MS = 8000;
/** A singer joining a song that is further in than this restarts it for everyone: the song is divided again, one more singer. */
const LATE_JOIN_RESTART_MS = 6000;

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
    void refreshAccount(); // the account's role as it stands (audio only, dual): the room applies it from the start
    // The join, tried again with backoff while the trouble is the link's (no answer, a failure answered) — not for a
    // refusal (the meet is over, the host removed this account), which the screen says as it is.
    let gone = false;
    let wait = 3000;
    const tryJoin = () =>
      session.join('audience').catch((e: unknown) => {
        if (gone || !(e instanceof ApiError) || (e.status !== 0 && e.status < 500) || e.code === 'storage_limit') return;
        setTimeout(() => !gone && void tryJoin(), wait * (0.8 + Math.random() * 0.4));
        wait = Math.min(60_000, wait * 2);
      });
    void tryJoin();
    return () => {
      gone = true;
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
  const trackKey = `${meet?.trackId ?? ''}|${meet?.catalogTrackId ?? ''}|${meet?.registryId ?? ''}`;
  useEffect(() => {
    if (!meet) return;
    let cancelled = false;
    setTrack(null);
    setPrepared(false); // a new song: get ready again (the server cleared the ready flags too)
    if (!meet.trackId && !meet.catalogTrackId && !meet.registryId) {
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
    if ((track?.source === 'catalog' || track?.source === 'registry') && you?.slot != null) keepMeetTrack(track);
  }, [track, you?.slot]);
  // The mic is a stage thing: open while on stage (talk-back between songs, the vocal in the song), closed on stepping off or when the meet is over.
  const onStageNow = you?.slot != null;
  const meetOver = meet?.state === 'ended' || meet?.state === 'expired';
  useEffect(() => {
    if ((!onStageNow || meetOver) && engineRef.current?.micOpen.value) engineRef.current.closeMic();
  }, [onStageNow, meetOver]);

  /**
   * The microphone (and on iOS the camera with it, one capture), through the vocal chain: opened
   * with the tap that takes the stage, so the singer can talk to the others before the song and
   * is heard by the audience; "I'm ready" opens it too when it is not open yet.
   */
  const openMic = async (): Promise<AudioEngine> => {
    const engine = engineRef.current ?? getEngine();
    engineRef.current = engine;
    await engine.resume();
    await openMicWithCamera(engine, camera);
    return engine;
  };
  const [micBusy, setMicBusy] = useState(false);
  /**
   * On iOS the mic and the camera are one capture: opening the mic re-opens the camera with it, which only a tap
   * may do — so the device never tries that by itself there (one tap, "Turn my mic on" / "Join the song", remains).
   */
  const needsTapForMic = () => isIOS && appSettings.peek().cameraOn && camera.on.value;
  /** `quiet`: an attempt the device makes by itself — no toast when the browser wants a tap first; the button stays. */
  const openMicForStage = async (quiet = false) => {
    if (engineRef.current?.micOpen.value) return;
    if (quiet && needsTapForMic()) return;
    setMicBusy(true);
    try {
      await openMic();
    } catch (e) {
      if (!quiet) toast(errorText(e), 'warn', 6000);
    } finally {
      setMicBusy(false);
    }
  };
  // The mic is part of being on stage: it opens by itself the moment you are seated (talk-back, the vocal in the
  // song), with no tap — a browser that wants a tap first (a permission not given yet) leaves the "Turn my mic on"
  // button, nothing else. One quiet try per seating.
  const micTriedFor = useRef<string | null>(null);
  const seatKey = onStageNow && !meetOver ? `${you?.participantId}:${you?.slot}` : null;
  useEffect(() => {
    if (!seatKey || micTriedFor.current === seatKey || engineRef.current?.micOpen.value) return;
    // A moment after the seat: the camera, the cut-out model and the video links start with the seat — the mic (and
    // the audio engine behind it) comes right after, not in the same breath, so a phone is not asked for everything at once.
    const t = setTimeout(() => {
      micTriedFor.current = seatKey;
      void openMicForStage(true);
    }, 1500);
    return () => clearTimeout(t);
  }, [seatKey]);

  /** Pre-flight: audio context, mic (+camera on iOS), decode the track. Then "ready". `quiet`: by the device itself. */
  const prepare = async (quiet = false): Promise<boolean> => {
    if (!track?.loaded) {
      if (!quiet) toast('The track is not available on this device yet', 'warn');
      return false;
    }
    if (quiet && !engineRef.current?.micOpen.value && needsTapForMic()) return false;
    setPreparing(true);
    try {
      const audio = audioSettings.peek();
      const engine = engineRef.current?.micOpen.value ? engineRef.current : await openMic();
      await engine.resume();
      const player = engine.player!;
      if (loadedKey.current !== trackKey || !player.buffer) {
        await player.load(track.loaded.audio, track.loaded.track.trackId);
        loadedKey.current = trackKey;
        // The song is in on this device, opened for performance: an access of mine on record in the SingersVoice track
        // database (its global "last sung" moves to now) — only on a successful load, never for a pick or a search.
        void recordAccess(meet?.registryId ?? track.loaded.track.registryId ?? (track.source === 'catalog' ? track.entry.registryId : track.source === 'registry' ? track.record.trackId : null), 'sing');
      }
      player.setGain(audio.backingGain);
      await keepAwake(true);
      setPrepared(true);
      const m = session.snapshot.peek()?.meet;
      const wasInSong = Boolean(m?.stage.find((s) => s.participantId === session.you.peek()?.participantId)?.ready);
      await session.setReady(true);
      // A new singer in a song well under way (not one coming back after Leave, and never a device that merely took its
      // time getting ready at the start: only a singer's own tap restarts the song for the stage): the song restarts from
      // the top for everyone, divided again among one more singer — every line in its singer's colour (planParts).
      if (!quiet && !wasInSong && m?.state === 'live' && (playbackPositionMs(m, serverNow()) ?? 0) > LATE_JOIN_RESTART_MS) {
        const n = m.stage.filter((s) => s.participantId && s.ready).length + 1;
        await session.restart(3000, 0).catch(() => undefined);
        toast(`You joined — the song restarts from the top, divided for ${n} singers`, 'ok', 6000);
      }
      return true;
    } catch (e) {
      if (!quiet) toast(errorText(e), 'error', 8000);
      return false;
    } finally {
      setPreparing(false);
    }
  };
  // Whoever starts the song, EVERY singer on stage is in it: each device goes to the singing screen the moment the
  // song runs and joins the song by itself — mic opened or not yet (it opens on the way; the track is loaded) — from
  // the count-in, or as soon as the track is in on a slower device. Only a browser that insists on a tap for the mic
  // leaves one tap, "Join the song", on the singing screen itself. A singer who left the running song (Leave) is
  // not pulled back in. One quiet try per song start (the kickstart), so a refusal never loops.
  const songRunning = meet?.state === 'countdown' || meet?.state === 'live';
  const leftSong = useRef(false);
  const joinTriedFor = useRef<string | null>(null);
  const songKey = songRunning ? `${trackKey}|${meet?.kickstartEpochMs ?? ''}|${meet?.songCount ?? 0}` : null;
  useEffect(() => {
    if (!songKey || leftSong.current || !onStageNow || prepared || preparing || !track?.loaded) return;
    if (joinTriedFor.current === songKey) return;
    joinTriedFor.current = songKey;
    void prepare(true);
  }, [songKey, onStageNow, prepared, preparing, track]);
  // The singing screen needs the audio engine; it exists from the moment the song runs (the mic may come after).
  if (songRunning && onStageNow && !engineRef.current) engineRef.current = getEngine();
  const inLobby = meet?.state === 'lobby';
  useEffect(() => {
    if (inLobby) leftSong.current = false; // the song is over (or a new one is up): everyone is in again
  }, [inLobby, trackKey]);

  if (!controlConfigured.value)
    return (
      <Page title="Meet">
        <div class="callout warn">Live meets need the SingersVoice service — this build has no VITE_CONTROL_URL.</div>
      </Page>
    );
  if ((session.error.value && !meet) || session.over.value)
    return (
      <Page title={meet?.title ?? 'Meet'}>
        <div class="stack" data-closed={session.over.value?.code ?? 'error'}>
          <ServiceBanner what="The room" />
          {session.over.value || session.link.value === 'ok' ? <div class="callout danger">{session.over.value?.code === 'removed' ? `${meet?.hostName ?? 'The host'} removed you from this meet.` : (session.over.value?.message ?? session.error.value)}</div> : null}
          {!session.over.value && session.link.value !== 'ok' && session.link.value !== 'storage_limit' && (
            <div class="row">
              <Spinner /> Trying to join again…
            </div>
          )}
          <a class="btn primary" href={href('/meets')}>
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
      onPrepare={() => prepare()}
      onOpenMic={() => openMicForStage()}
      micBusy={micBusy}
      participants={snap?.participants ?? []}
      onSongOver={() => {
        // The song is over on this device (it ended, the host stopped it, or this singer stepped out): the singer is back on
        // the stage, ready again for the next song or to rejoin this one. Nothing is saved per song — the film of the meet
        // (one file, the host's Drive) is the record of every song.
        if (meet.state === 'live' || meet.state === 'countdown') leftSong.current = true; // they stepped out of a running song: back in only by their own tap
        setPrepared(false);
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
  onPrepare: () => Promise<boolean>;
  onOpenMic: () => Promise<void>;
  micBusy: boolean;
  participants: Participant[];
  onSongOver: () => void;
}) {
  const { session, meet, you, track, camera, engine } = props;
  // The song is paused on THIS device (at the cued instant, not when the next poll says so): talk-back opens for the pause.
  const [paused, setPaused] = useState(false);
  const stage = useRoomStage(session, meet, you, camera, { preparing: props.preparing, engine, paused, restartCamera: () => restartCamera(engine, camera) });
  // The TV in the room (lib/tv.ts): this stage's show picture goes to it while the room is open; a remembered TV is found again by itself.
  const tvLook = appSettings.value.tvLook;
  useEffect(() => {
    tvLink.attach(stage.show);
    void tvLink.autoConnect();
    return () => tvLink.detach(stage.show);
  }, [stage.show]);
  useEffect(() => tvLink.setLook(tvLook, you.displayName), [tvLook, you.displayName]);
  const onStage = you.slot !== null;
  const live = meet.state === 'countdown' || meet.state === 'live';
  // A song running on this device keeps the live stage mounted until it wraps up, even once the meet is
  // back in the lobby (the host ended the song, the set list moved on) — the stage stops the song cleanly.
  const [singing, setSinging] = useState(false);
  const liveLoaded = useRef<NonNullable<MeetTrack['loaded']> | null>(null);
  if (live && track?.loaded) liveLoaded.current = track.loaded;

  if ((live || singing) && onStage && liveLoaded.current && engine) return <LiveStage session={session} meet={meet} you={you} loaded={liveLoaded.current} engine={engine} camera={camera} stage={stage} track={track} prepared={props.prepared} onPrepare={props.onPrepare} onSongOver={props.onSongOver} onSinging={setSinging} onPaused={setPaused} />;

  if (meet.state === 'ended' || meet.state === 'expired') return <Ended session={session} meet={meet} you={you} />;

  return <Lobby session={session} meet={meet} you={you} track={track} stage={stage} camera={camera} prepared={props.prepared} preparing={props.preparing} onPrepare={props.onPrepare} onOpenMic={props.onOpenMic} micBusy={props.micBusy} participants={props.participants} engine={engine} />;
}

// ---------------- Lobby + audience ----------------

/**
 * Re-open the microphone with the settings just changed (another mic, speakers vs headphones) — the chain and the
 * take carry on. On iOS the camera is re-captured with it (one capture per page there: a mic opened on its own
 * would end the camera and freeze this singer's picture for everyone).
 */
async function reopenMic(engine: AudioEngine | null, camera: Camera): Promise<void> {
  if (!engine?.micOpen.value) return;
  try {
    await openMicWithCamera(engine, camera);
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
  camera: Camera;
  prepared: boolean;
  preparing: boolean;
  onPrepare: () => Promise<boolean>;
  onOpenMic: () => Promise<void>;
  micBusy: boolean;
  participants: Participant[];
  engine: AudioEngine | null;
}) {
  const { session, meet, you, stage } = props;
  const [tab, setTab] = useState<'stage' | 'chat'>('stage');
  const micOpen = props.engine?.micOpen.value ?? false;
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
  /** Step on a slot: the mic and camera open with the tap (browsers need the gesture), then the slot is taken. */
  const claim = async (slot: number | null) => {
    if (slot !== null) {
      void props.onOpenMic(); // talk to the other singers until the song starts; the audience hears the stage
      if (appSettings.peek().cameraOn) void stage.openCamera();
    }
    try {
      await session.claimSlot(slot);
    } catch (e) {
      toast(errorText(e), 'warn');
      if (slot !== null && session.you.peek()?.slot == null) props.engine?.closeMic(); // the slot was not ours after all: no open mic off stage
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
  /** Host: out of the meet for good (stage or audience). */
  const kick = async (p: { participantId: string; displayName: string }) => {
    if (!confirm(`Remove ${p.displayName} from this meet? They cannot come back in.`)) return;
    try {
      await session.kick(p.participantId);
      toast(`${p.displayName} was removed from the meet`, 'ok');
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  /** Host: out of the meet now and blocked from every meet of mine, for good. */
  const block = async (p: { participantId: string; displayName: string }) => {
    if (!confirm(`Block ${p.displayName}? They are removed now and can never get into any meet of yours (Settings → Account lists who you blocked).`)) return;
    try {
      await session.block(p.participantId);
      toast(`${p.displayName} is blocked from your meets`, 'ok');
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
  const setMembersOnly = async (on: boolean) => {
    try {
      await session.setMembersOnly(on);
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
  const [bgOpen, setBgOpen] = useState(false);
  /** The stage background for everyone: a tap by the host or any singer on stage; every device in the room and the show follow at once. */
  const pickBackground = async (id: string) => {
    try {
      await session.setBackground(id);
      toast('Stage background switched for everyone', 'ok');
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  /** Songs put forward and none running: the stage chooses one (on the song card) before anything starts. */
  const choosing = songChoicePending(meet);
  /** Anyone on stage starts the song for the stage; the one who starts is made ready on the way (mic, track) if not yet. */
  const start = async () => {
    try {
      if (!props.prepared && !(await props.onPrepare())) return;
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
    const mp = new MixPlayer(e.ctx, e.master, (since) => session.fetchMix(since), (since) => session.mixStreamUrl(since));
    mixRef.current = mp;
    (window as unknown as { __svMix?: MixPlayer | null }).__svMix = mp; // support / e2e: the sound the audience hears
    mp.start();
    const t = setInterval(() => setMixState({ ...mp.state.value }), 500);
    return () => {
      clearInterval(t);
      mp.stop();
      mixRef.current = null;
      (window as unknown as { __svMix?: MixPlayer | null }).__svMix = null;
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
                {canPublishSignal.value && (
                  <a class="btn sm accent" href={href(`/publishing/show/${encodeURIComponent(meet.meetId)}`)} target="_blank" rel="noopener" data-publish title="Publishing mode, in a new tab: the broadcast picture (performers huge, no lyrics) and Go live to the destinations saved on your account — YouTube and the watch page">
                    <IcShare size={16} /> Publish
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
            <StageStrip stage={stage} meet={meet} onStage={onStage} session={session} />
            {(host || onStage) && (
              <div class="row" style="justify-content:flex-end">
                <button class="btn sm" aria-label="Stage background" title="Switch the stage background for everyone — every device and the show follow at once" onClick={() => setBgOpen(true)}>
                  <IcImage size={16} /> Stage background
                </button>
              </div>
            )}
            <Sheet open={bgOpen} onClose={() => setBgOpen(false)} title="Stage background">
              <StageBackgroundChoice value={meet.backgroundId} onPick={(id) => pickBackground(id)} />
            </Sheet>
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
                <SlotCard key={s.slot} slot={s} mine={s.participantId === you.participantId} canClaim={!s.participantId && (onStage || (!live && (host || openStage)))} onClaim={() => void claim(s.slot)} onRemove={host && s.participantId && s.participantId !== you.participantId ? () => void remove(s.participantId!) : undefined} onKick={host && s.participantId && s.participantId !== you.participantId ? () => void kick({ participantId: s.participantId!, displayName: s.displayName }) : undefined} onBlock={host && s.participantId && s.participantId !== you.participantId ? () => void block({ participantId: s.participantId!, displayName: s.displayName }) : undefined} />
              ))}
            </div>
            <div class="row">
              {onStage ? (
                <>
                  {hasSong &&
                    !choosing &&
                    (!props.prepared ? (
                      <button class="btn accent" disabled={props.preparing || !props.track?.loaded} title={props.track?.loaded ? undefined : 'Loading the song on this device…'} onClick={() => void props.onPrepare()}>
                        {props.preparing ? <Spinner /> : <IcMic />} {live ? 'Join the song on stage' : "I'm ready (mic & camera check)"}
                      </button>
                    ) : (
                      <span class="chip ok">{live ? 'Joining the song…' : 'Ready — start the song when the stage is'}</span>
                    ))}
                  <button class="btn" onClick={() => void claim(null)}>
                    Leave stage
                  </button>
                  {!micOpen && (
                    <button class="btn" disabled={props.micBusy} title="Talk to the other singers before the song; the audience hears the stage" onClick={() => void props.onOpenMic()}>
                      {props.micBusy ? <Spinner /> : <IcMic />} Turn my mic on
                    </button>
                  )}
                  {micOpen && <MicStatus engine={props.engine} onChange={() => void reopenMic(props.engine, props.camera)} />}
                  {micOpen && !live && <span class="chip ok" data-talkback="1" title="Until the countdown, the singers on stage hear each other and the audience hears the stage; once the song runs, nobody on stage hears anyone else">Talk-back on · headphones recommended</span>}
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
              {onStage && !live && (
                <button class="btn accent" disabled={meet.performerCount === 0 || !hasSong || choosing || !props.track?.loaded || props.preparing} title={choosing ? 'Several songs are picked — choose one on the song card first' : !hasSong ? 'Pick a song first' : !props.track?.loaded ? 'Loading the song on this device…' : 'Starts the song for everyone on stage — an 8 s count-in, every device in step'} onClick={() => void start()}>
                  {props.preparing ? <Spinner /> : <IcPlay />} Start the song (8 s count-in)
                </button>
              )}
              {onStage && live && (
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
            {host && meet.membersOnly !== undefined && <Switch checked={meet.membersOnly} onChange={(v) => void setMembersOnly(v)} label="Club meet: members only" hint={meet.membersOnly ? 'Only the members of your club (and you) can come in — Club lists them' : 'Open: anyone with the link can come in'} />}
            {!host && meet.membersOnly && <div class="small muted">A club meet: members only.</div>}
            {host && <MeetFilmSwitch film={stage.film} onStage={onStage} />}
            {host ? (
              <div class="small muted audience-list" data-audience={meet.audienceCount}>
                Audience ({meet.audienceCount}):{' '}
                {props.participants.filter((p) => p.slot === null && p.role !== 'publisher').length === 0 && 'nobody yet'}
                {props.participants
                  .filter((p) => p.slot === null && p.role !== 'publisher')
                  .map((p) => (
                    <span key={p.participantId} class="chip audience-chip">
                      {p.displayName}
                      <button type="button" class="chip-x" aria-label={`Remove ${p.displayName} from the meet`} title="Remove from the meet" onClick={() => void kick(p)}>
                        <IcX size={12} />
                      </button>
                      <button type="button" class="chip-x" aria-label={`Block ${p.displayName} from all your meets`} title="Block: out now, and never into any meet of yours" data-block onClick={() => void block(p)}>
                        ⛔
                      </button>
                    </span>
                  ))}
                <span class="faint"> · only you, the host, can remove anyone (× on a name or a slot) or block them for good (⛔)</span>
              </div>
            ) : (
              <div class="small muted">
                Audience ({meet.audienceCount}): {audienceLine(meet.audienceCount, props.participants)}
                {!onStage && !openStage && ' · ask to sing and the host lets you on stage between songs'}
                {!onStage && openStage && !live && ' · the stage is open: take a slot to sing'}
              </div>
            )}
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


/** Host: the film of the whole meet — on by default, with what it is doing right now. */
function MeetFilmSwitch(props: { film: MeetRecorder; onStage: boolean }) {
  const on = appSettings.value.recordMeet;
  const s = props.film.state.value;
  const mb = (n: number) => `${Math.round(n / 1e5) / 10} MB`;
  const hint = !on
    ? 'Off: nothing of this meet is kept as one video'
    : s.recording
      ? `Filming · ${formatMs(s.seconds * 1000)} · ${mb(s.bytes)}${s.stored < s.bytes ? ` (${mb(s.stored)} in Drive)` : ' in Drive'} · ${filmSound(s)}${s.chapter ? ` · chapter ${s.chapter.index} ${s.chapter.kind === 'song' ? '♪' : s.chapter.kind === 'pause' ? '⏸' : '▪'} ${s.chapter.title} ${formatMs(s.chapter.seconds * 1000)}` : ''}${s.note ? ` · ${s.note}` : ''}`
      : s.saved
        ? `Saved: one film, ${formatMs(s.saved.durationMs)}, ${s.chapters} chapter mark${s.chapters === 1 ? '' : 's'} — under Performances for everyone who was in the meet`
        : s.note
          ? s.note
          : props.onStage
            ? 'Starts with your mic — the show picture and the stage mix, as the audience sees and hears it, into your Drive as it happens'
            : 'Films while you are on stage: the show picture and the stage mix, into your Drive as it happens';
  return (
    <div data-meet-film={s.recording ? 'on' : on ? 'armed' : 'off'} data-film-seconds={s.seconds} data-film-level={Math.round(s.level)} data-film-heard={s.heard ? '1' : '0'} data-film-chapter={s.chapter?.index ?? 0} data-film-chapter-kind={s.chapter?.kind ?? ''} data-film-chapters={s.chapters}>
      <Switch checked={on} onChange={(v) => updateApp({ recordMeet: v })} label="Film the whole meet into my Drive — one file, a chapter mark per song" hint={hint} />
    </div>
  );
}

function SlotCard(props: { slot: StageSlot; mine: boolean; canClaim: boolean; onClaim: () => void; onRemove?: () => void; onKick?: () => void; onBlock?: () => void }) {
  const s = props.slot;
  return (
    <div class={`slot-card ${s.participantId ? 'taken' : ''} ${props.mine ? 'mine' : ''}`} style={{ borderColor: SLOT_COLORS[s.slot as SingerSlot] }}>
      <button type="button" class="slot-take" disabled={!props.canClaim} onClick={props.onClaim} aria-label={s.participantId ? `Slot ${s.slot}: ${s.displayName}` : `Take slot ${s.slot}`}>
        <span class="slot-badge" style={{ background: SLOT_COLORS[s.slot as SingerSlot] }}>S{s.slot}</span>
        <span class="name">{s.participantId ? s.displayName : 'open'}</span>
        {s.participantId && <span class={`chip ${s.ready ? 'ok' : ''}`}>{s.ready ? 'ready' : 'joined'}</span>}
      </button>
      {props.onRemove && (
        <button type="button" class="slot-remove" aria-label={`Clear slot ${s.slot} (${s.displayName}) — back to the audience`} title="Back to the audience" onClick={props.onRemove}>
          <IcX size={14} />
        </button>
      )}
      {props.onKick && (
        <button type="button" class="slot-kick" aria-label={`Remove ${s.displayName} from the meet`} title="Remove from the meet" onClick={props.onKick}>
          out
        </button>
      )}
      {props.onBlock && (
        <button type="button" class="slot-kick block" aria-label={`Block ${s.displayName} from all your meets`} title="Block: out now, and never into any meet of yours" onClick={props.onBlock}>
          ⛔
        </button>
      )}
    </div>
  );
}

/** The virtual stage in the lobby: everyone on stage, cut out of their cameras (own video; others' on stage devices). */
function StageStrip(props: { stage: RoomStage; meet: Meet; onStage: boolean; session: MeetSession }) {
  const { stage, meet } = props;
  const app = appSettings.value;
  const n = meet.stage.filter((s) => s.participantId).length;
  // The plan's video hours, as the service counts them (every heartbeat): a notice says what is left, or — the hours used up, an
  // audio-only account — why there is no picture. A free account simply sings (the camera button is off; the Plans page tells the rest).
  const video = props.session.yourVideo.value;
  const planOnly = !stage.videoAllowed && (video?.reason ?? 'plan') === 'plan';
  const videoNote = planOnly ? '' : video?.note || '';
  // Everything the stage has to say goes through the one notice control (stageNotices.ts): the bar keeps the count and the camera's buttons.
  useStageNotices(stage, meet, props.session, props.onStage, null);
  return (
    <div class="stagestrip" data-blend={stage.blend} data-mask={stage.feed.segmenter.maskMode} data-performers={n} data-linked={stage.linked} data-onstage={props.onStage ? '1' : '0'} data-video-allowed={stage.videoAllowed ? '1' : '0'} data-video-why={stage.videoAllowed ? undefined : video?.reason || 'plan'}>
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
        <span class="chip" data-stage-count>
          <IcUsers size={14} /> {n} on stage{props.onStage && stage.others ? ` · ${stage.linked}/${stage.others} video linked` : ''}
        </span>
        {/* The facts the e2e and support read, out of sight: what the notices say in words. */}
        {props.onStage && !stage.videoAllowed && !planOnly && (
          <span hidden data-audio-only data-video-note={video?.reason || 'plan'}>
            audio only · no camera
          </span>
        )}
        {props.onStage && !stage.videoAllowed && !planOnly && videoNote && (
          <span hidden data-video-reason>
            {videoNote}
          </span>
        )}
        {props.onStage && stage.videoAllowed && video && video.leftSeconds !== null && (
          <span hidden data-video-left={video.leftSeconds}>
            video · {hoursLabel(video.leftSeconds)} left this month
          </span>
        )}
        {props.onStage && stage.camOn && stage.camHealth !== 'ok' && <span hidden data-cam-health={stage.camHealth} />}
        {props.onStage && stage.camOn && stage.cameraLine && <span hidden data-camera-line={stage.cameraLine} />}
        {props.onStage && stage.mixLine && <span hidden data-mix-line={stage.mixLine} />}
        {props.onStage && stage.distance && <span hidden data-distance={stage.distance} />}
        {props.onStage && stage.still.map((id) => <span key={id} hidden data-still={id} />)}
        {props.onStage && !stage.camOn && app.cameraOn && stage.videoAllowed && (
          <button class="btn sm accent" style="pointer-events:auto" onClick={() => void stage.openCamera()}>
            <IcCamera size={16} /> Turn the camera on
          </button>
        )}
        {props.onStage && (
          <button class={`btn sm ${app.cameraOn ? '' : 'accent'}`} style="pointer-events:auto" aria-label={app.cameraOn ? 'Camera off' : 'Camera on'} disabled={!stage.videoAllowed} onClick={() => updateApp({ cameraOn: !app.cameraOn })}>
            {app.cameraOn ? <IcCameraOff size={16} /> : <IcCamera size={16} />}
          </button>
        )}
        {props.onStage && stage.camOn && (
          <button class="btn sm" style="pointer-events:auto" data-cam-restart="1" title="Open the camera again from scratch — the plain cure for a picture that stands still" onClick={() => void stage.restartCamera()}>
            <IcCamera size={16} /> Restart camera
          </button>
        )}
        {props.onStage && <NoticeCenter open="below" />}
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
  onPrepare: () => Promise<boolean>;
  /** The song is over on this device (it ended, the host stopped it, this singer stepped out): the singer is back on the stage. */
  onSongOver: () => void;
  /** A song is running on this device (from the first cue until it wraps up). */
  onSinging: (singing: boolean) => void;
  /** The song is paused on this device (from the cued instant to the resume) — the stage talks meanwhile. */
  onPaused: (paused: boolean) => void;
}) {
  const { session, meet, engine, camera, loaded, stage } = props;
  const { feed, compositor, blend, peerStates } = stage;
  // The song's position, written every frame: a signal, read by the lyrics and the seek bar alone — the stage around them never re-renders for it.
  const tMs = useSignal(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [started, setStarted] = useState(false);
  const [finishing, setFinishing] = useState(false);
  /** The set list drawer over the stage: see what is next, add a song, (host) end the song. */
  const [songsOpen, setSongsOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const pickBackground = async (id: string) => {
    try {
      await session.setBackground(id);
      toast('Stage background switched for everyone', 'ok');
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const [fxOpen, setFxOpen] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [tvOpen, setTvOpen] = useState(false);
  /** A seek on its way: where the song is about to jump (cleared when the cue lands). */
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const raf = useRef(0);
  const scheduledEpoch = useRef(0);
  const pausedLocally = useRef(false);
  const app = appSettings.value;
  const audio = audioSettings.value;
  const track = loaded.track;
  // Who sings what: the song's parts divided among the singers in the song (everyone on stage who joined it, by slot) — two
  // singers, two colours for the whole song; ten on a five-part song, 1 and 6 share a part. A singer who joins later restarts
  // the song, divided again (MeetRoom.prepare).
  const mySlot = Math.max(1, props.you.slot ?? 1) as SingerSlot;
  const inSong = meet.stage.filter((s) => s.participantId && s.ready).map((s) => s.slot);
  const inSongKey = inSong.join(',');
  const plan = useMemo(() => planParts(track.singerCount, inSong), [track.singerCount, inSongKey]);
  // The TV in the room gets the song's words and its clock (lib/tv.ts); between songs it shows the stage alone.
  useEffect(() => {
    tvLink.setSong({ title: track.title, lines: track.lyrics, singerCount: track.singerCount, mySlot, plan });
    return () => tvLink.setSong(null);
  }, [track, mySlot, plan]);
  // Somebody joined the running song: say so — the song is divided again (and restarts from the top when it was well under way; the joiner's device cues that).
  const prevInSong = useRef(inSongKey);
  useEffect(() => {
    const before = prevInSong.current.split(',').filter(Boolean).map(Number);
    prevInSong.current = inSongKey;
    if (!started) return;
    const added = inSong.filter((s) => !before.includes(s));
    if (!added.length || inSong.length <= before.length) return;
    const names = added.map((slot) => meet.stage.find((s) => s.slot === slot)?.displayName.split(' ')[0] ?? `S${slot}`).join(', ');
    toast(tMs.peek() > LATE_JOIN_RESTART_MS ? `${names} joined the song — it restarts from the top, divided for ${inSong.length} singers` : `${names} joined the song — divided for ${inSong.length} singers`, 'info', 6000);
  }, [inSongKey, started]);
  const host = props.you.userId === meet.hostUserId;
  const pb = meet.playback ?? { state: 'idle' as const, offsetMs: 0, pausedAtMs: 0, pauseAtEpochMs: null, epoch: 0 };
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    engine.applyFx(audio.params);
    engine.setMonitor(audio.monitor);
    engine.player?.setGain(audio.backingGain);
  }, [audio]);

  // The room's stage (camera, cut-out, mesh) is already running since the lobby; here it stands in its own strip under the lyrics, the singers filling it as on the lobby stage.
  const camOn = stage.camOn;
  const stagePerformers = meet.stage.filter((s) => s.participantId);

  // ---- follow the shared transport: schedule playback at every kickstart (start / resume / restart) ----
  // Nothing is recorded per song on a singer's device: the film of the meet (roomStage.ts, the host's device)
  // keeps every song, with a chapter mark where each one starts, in one file.
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
      player.play(t0, offsetMs);
      setStarted(true);
      props.onSinging(true);
    } else if (player.playing && !pausedLocally.current) {
      // A jump while playing (a seek, a restart from the top): the song keeps playing and jumps at the cued
      // instant — the same instant on every device.
      player.cue(t0, offsetMs);
    } else {
      // Resume (from our pause — or a pause we only learned of late); a seek made while paused moves the song there too.
      clearTimeout(pauseTimer.current);
      if (!pausedLocally.current) player.pause();
      pausedLocally.current = false;
      props.onPaused(false); // the resume is cued: from this moment nobody on stage hears anyone else again
      player.play(t0, offsetMs);
    }
    setSeekTarget(null);
    // The song's natural end calls the *latest* finish (through a ref): the one in this closure was made before
    // `started` became true and would return at once — a song nobody paused or seeked would never finish.
    player.onEnded = () => {
      (window as unknown as { __svEnded?: unknown }).__svEnded = Date.now(); // support / e2e
      void finishRef.current(true); // the track is over: the song is over for the stage (the first device to get there says so)
    };
    cancelAnimationFrame(raf.current);
    // The count-in shown is the service's deadline read on the shared clock (kickstart − server now): the same number on
    // every device at every instant, and never a bigger one than the last within this cue — a main thread that stalled
    // (the camera pipeline on a phone) catches up, it never counts twice. The audio clock schedules the sound (above);
    // it does not drive the display, because a context that was suspended for a moment makes its clock jump.
    let shown = Infinity;
    const tick = () => {
      const leftMs = localStart - Date.now();
      if (leftMs > 0) {
        const n = Math.min(shown, Math.max(1, Math.ceil(leftMs / 1000)));
        shown = n;
        setCountdown(n);
      } else {
        setCountdown(null);
        tMs.value = Math.max(0, player.positionMs() - engine.outputLatencyMs);
      }
      (window as unknown as { __svPos?: unknown }).__svPos = { posMs: Math.round(player.positionMs()), epoch: pb.epoch, state: pb.state, offsetMs: pb.offsetMs, ks: meet.kickstartEpochMs, playing: player.playing, countdown: leftMs > 0 ? shown : null }; // support / e2e
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [meet.kickstartEpochMs, pb.epoch, pb.state, props.prepared]);

  // Host paused: the pause is cued at a shared server instant — stop exactly there (the instant is
  // converted to our own audio clock). A device that only learns of it after the instant stops
  // immediately and re-aligns on resume.
  const pauseAt = pb.pauseAtEpochMs;
  useEffect(() => {
    clearTimeout(pauseTimer.current);
    if (!started) return;
    const player = engine.player;
    if (!player) return;
    const doPause = () => {
      if (pausedLocally.current) return;
      pausedLocally.current = true;
      props.onPaused(true);
      if (player.playing) player.pause();
      player.seek(pb.pausedAtMs);
      tMs.value = pb.pausedAtMs;
    };
    if (pb.state === 'paused') {
      if (!pausedLocally.current) doPause();
      else if (Math.abs(player.positionMs() - pb.pausedAtMs) > 1) {
        // A seek while paused: everyone's paused position moves.
        player.seek(pb.pausedAtMs);
        tMs.value = pb.pausedAtMs;
      }
      setSeekTarget(null);
      return;
    }
    if (pb.state === 'playing' && pauseAt !== null) {
      const localInstant = pauseAt - clock.value.offsetMs; // server instant → local epoch ms
      const inMs = localInstant - Date.now();
      if (inMs <= 0) doPause();
      else pauseTimer.current = setTimeout(doPause, inMs);
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

  // The song is over (its track ended on the host's device, or the host ended it) or the meet ended → wrap up on this device.
  useEffect(() => {
    if (started && (meet.state === 'lobby' || meet.state === 'ended' || meet.state === 'expired')) void finish();
  }, [meet.state]);

  const finishRef = useRef<(forEveryone?: boolean) => Promise<void>>(async () => undefined);
  /**
   * Wrap the song up on this device — and, `forEveryone`, end it for the whole stage (the next one on the set
   * list comes up). The song's natural end on the host's device ends it for everyone as well; a singer who only
   * leaves the song keeps the stage singing and may join back in. Nothing is saved here: the film of the meet
   * (the host's device, roomStage.ts) has the song, marked, in the one file of the meet.
   */
  const finish = async (forEveryone = host) => {
    (window as unknown as { __svFinish?: unknown }).__svFinish = { at: Date.now(), finishing, started, step: 'called' }; // support / e2e
    if (finishing || !started) return;
    setFinishing(true);
    cancelAnimationFrame(raf.current);
    try {
      const player = engine.player!;
      player.onEnded = null;
      player.stop();
      // The mic stays open: the singer is still on stage, and between songs the stage talks (talk-back); it closes when they step off.
      await keepAwake(false);
      (window as unknown as { __svFinish?: unknown }).__svFinish = { at: Date.now(), step: 'stopped', host, state: meet.state };
      // Ending the song for everyone: the meet goes back to the lobby, next song up (the host's song ending always does).
      if (forEveryone && (meet.state === 'live' || meet.state === 'countdown')) void session.nextSong().catch(() => undefined);
      props.onSongOver();
      props.onSinging(false);
      // Back to a clean slate: a singer who left the running song joins it again with "Join the song" (cued from
      // where the song is), and the next song starts from the top.
      scheduledEpoch.current = 0;
      pausedLocally.current = false;
      props.onPaused(false);
      setStarted(false);
      setCountdown(null);
      setFinishing(false);
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
  /** Move the song back or forth for everyone: cued, so every device jumps at the same instant (the film marks it). */
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
  const paused = pb.state === 'paused';
  const micOpenNow = engine.micOpen.value;
  // Everything the stage has to say goes through the one notice control (stageNotices.ts); the bar keeps the count and the save state.
  useStageNotices(stage, meet, session, true, { paused, pauseCued: pauseAt !== null, seekTarget, talkback: micOpenNow && stage.show.hearingOthers, requests: host ? meet.requests.length : 0, softFocus: camOn && blend === 'oval' && app.cutout });
  // The TV's clock: where the song is, several times a second (the TV runs it on between).
  const tvPlaying = started && !paused && countdown === null;
  useEffect(() => effect(() => tvLink.clock(tMs.value, tvPlaying, countdown)), [tvPlaying, countdown]);

  return (
    <Page title={meet.title} nav={false} full>
      <div class="sing" data-layout="strip">
        <StageBackground id={meet.backgroundId} />
        <VirtualStage compositor={compositor} />
        <section class="stagebar" data-blend={blend} data-mask={feed.segmenter.maskMode} data-performers={compositor.tiles.length}>
          <span class="chip" data-stage-count>
            <IcUsers size={14} /> {stagePerformers.length} on stage{others.length ? ` · ${connected}/${others.length} video linked` : ''}
          </span>
          {/* The facts the e2e and support read, out of sight: what the notices say in words. */}
          {paused && micOpenNow && stage.show.hearingOthers && <span hidden data-talkback-live="1" />}
          {stage.mixLine && <span hidden data-mix-line={stage.mixLine} />}
          {stage.alignLine && <span hidden data-align-line={stage.alignLine} />}
          {stage.still.map((id) => (
            <span key={id} hidden data-still={id} />
          ))}
          {paused && <span class="chip warn">paused</span>}
          <NoticeCenter open="below" />
          <SaveStatus compact />
        </section>
        {track.video ? (
          <KaraokeVideo track={track} catalogTrackId={props.track?.source === 'catalog' ? props.track.entry.trackId : meet.catalogTrackId} tMs={tMs} playing={started && !paused && countdown === null} rate={audio.tempo} countdown={countdown} />
        ) : (
          <LyricsPanel lines={track.lyrics} tMs={tMs} mySlot={mySlot} plan={plan} countdown={countdown} showWho={track.singerCount > 1 || plan.singers.length > 1} title={track.title} />
        )}
        {songsOpen && (
          <div class="drawer" role="dialog" aria-label="Songs">
            <div class="row between">
              <b>Songs</b>
              <button class="btn icon sm" aria-label="Close the songs" onClick={() => setSongsOpen(false)}>
                <IcX size={16} />
              </button>
            </div>
            <SetListPanel session={session} meet={meet} you={props.you} track={props.track} host={host} onStage live compact />
          </div>
        )}
        {bgOpen && (
          <div class="drawer" role="dialog" aria-label="Stage background">
            <div class="row between">
              <b>Stage background — for everyone, at once</b>
              <button class="btn icon sm" aria-label="Close the stage background" onClick={() => setBgOpen(false)}>
                <IcX size={16} />
              </button>
            </div>
            <StageBackgroundChoice value={meet.backgroundId} onPick={(id) => pickBackground(id)} compact />
          </div>
        )}
        {app.showCueDeck && (track.singerCount > 1 || plan.singers.length > 1) && started && countdown === null && <CueDeck lines={track.lyrics} tMs={tMs} mySlot={mySlot} plan={plan} />}
        {tvOpen && (
          <div class="drawer" role="dialog" aria-label="TV">
            <div class="row between">
              <b>TV — your stage on the big screen</b>
              <button class="btn icon sm" aria-label="Close the TV panel" onClick={() => setTvOpen(false)}>
                <IcX size={16} />
              </button>
            </div>
            <TvPanel compact />
          </div>
        )}
        {pictureOpen && (
          <div class="drawer" role="dialog" aria-label="My picture">
            <div class="row between">
              <b>My picture — on every stage and in the show</b>
              <button class="btn icon sm" aria-label="Close my picture" onClick={() => setPictureOpen(false)}>
                <IcX size={16} />
              </button>
            </div>
            <PictureChoices compact />
          </div>
        )}
        {fxOpen && (
          <div class="drawer sound" role="dialog" aria-label="Sound">
            <div class="row between">
              <b>Sound</b>
              <button class="btn icon sm" aria-label="Close the sound settings" onClick={() => setFxOpen(false)}>
                <IcX size={16} />
              </button>
            </div>
            <PresetChips value={audio} onChange={updateAudio} />
            <MicStatus engine={engine} onChange={() => void reopenMic(engine, camera)} />
            <MixBalance />
            <details class="tweaks">
              <summary>Tweak the voice FX — every control of the vocal chain, live on your voice</summary>
              <FxPanel value={audio} onChange={updateAudio} compact />
            </details>
          </div>
        )}
        <section class="controls compact">
          <SeekBar tMs={tMs} durationMs={track.durationMs} onSeek={started && props.prepared ? (ms) => void seek(ms) : undefined} pending={seekTarget} disabled={countdown !== null} />
          <div class="main">
            <button class={`btn icon ${app.cameraOn && stage.videoAllowed ? 'on' : ''}`} aria-label="Camera" disabled={!stage.videoAllowed} title={stage.videoAllowed || session.yourVideo.value?.reason === 'plan' ? 'Camera' : session.yourVideo.value?.note || 'Camera'} onClick={() => updateApp({ cameraOn: !app.cameraOn })}>
              {app.cameraOn && stage.videoAllowed ? <IcCamera /> : <IcCameraOff />}
            </button>
            <button class={`btn icon ${tvOpen || tvLink.state.value === 'on' ? 'on' : ''}`} aria-label="TV" title="TV: your stage on the TV in the room — type the code the TV shows" aria-pressed={tvOpen} data-tv-button onClick={() => setTvOpen((o) => !o)}>
              <IcTv />
            </button>
            <button class={`btn icon ${pictureOpen ? 'on' : ''}`} aria-label="My picture" title="My picture: me on the stage or my camera as it is; still, following me, or zooming with my voice" aria-pressed={pictureOpen} disabled={!stage.videoAllowed} onClick={() => setPictureOpen((o) => !o)}>
              <IcZoom />
            </button>
            <button class={`btn icon ${audio.monitor ? 'on' : ''}`} aria-label="Hear myself" title="Hear myself (use headphones)" onClick={() => updateAudio({ monitor: !audio.monitor })}>
              <IcHeadphones />
            </button>
            <button class={`btn icon ${fxOpen ? 'on' : ''}`} aria-label="Sound" title="Sound: the voice preset and its tweaks, the microphone, the track and vocal volumes" aria-pressed={fxOpen} onClick={() => setFxOpen((o) => !o)}>
              <IcSliders />
            </button>
            <button class={`btn icon ${songsOpen ? 'on' : ''}`} aria-label="Songs" title="Songs: what is playing, what follows, pick the next one" aria-pressed={songsOpen} onClick={() => setSongsOpen((o) => !o)}>
              <IcMusic />
            </button>
            <button class={`btn icon ${bgOpen ? 'on' : ''}`} aria-label="Stage background" title="Switch the stage background for everyone — every device and the show follow at once" aria-pressed={bgOpen} onClick={() => setBgOpen((o) => !o)}>
              <IcImage />
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
                <button class="btn icon" aria-label="Restart the song for everyone" title="Restart from the top — for everyone on stage" onClick={() => void transport('restart')}>
                  <IcSkipBack />
                </button>
                <button class="btn big accent" disabled={finishing} aria-label="Stop the song for everyone" title="Stops the song for everyone on stage — the next one on the set list comes up" onClick={() => void finish(true)}>
                  {finishing ? <Spinner /> : <IcStop />} Stop song
                </button>
                {!host && (
                  <button class="btn" disabled={finishing} aria-label="Leave the song" title="Step out of the song — it goes on for the others, and you can join back in" onClick={() => void finish(false)}>
                    Leave
                  </button>
                )}
              </>
            ) : (
              <button class="btn big primary" disabled>
                <Spinner /> Waiting for the kickstart…
              </button>
            )}
            <span class="pitch-pill">
              <LevelDot engine={engine} /> ±{Math.round(clock.value.rttMs / 2)} ms
            </span>
            <span class="chip" style={{ borderColor: SLOT_COLORS[clampSlot(mySlot)] }} title={`Your lines are in this colour${plan.singers.length > 1 ? ` — the song is divided among ${plan.singers.length} singers` : ''}`}>
              S{mySlot}
            </span>
            {canPublishSignal.value && (
              <a class="btn sm" href={href(`/publishing/show/${encodeURIComponent(meet.meetId)}`)} target="_blank" rel="noopener" data-publish title="Publishing mode, in a new tab: the show view and Go live with your saved destinations">
                Publish
              </a>
            )}
          </div>
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
  const canPublish = canPublishSignal.value;
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
          <h3>The film of this meet</h3>
          <div class="muted small">One file for the whole meet — everyone on stage over the stage background, with the whole mix, as the audience saw and heard it — with a chapter mark per song, pause and stretch of stage, saved by the host and shared with everyone who was in the meet. Find it any time under Performances.</div>
          <SaveStatus />
          {!shows.length && <div class="muted small">{host ? 'The film lands here as soon as it is closed and shared (a moment after End meet); if nothing comes, the film was off (it runs while you are on stage with Film the whole meet switched on).' : 'Nothing has landed yet — the host’s film arrives here a moment after the meet ends (if the host had Film the whole meet switched on).'}</div>}
          <div class="list">
            {[...shows].sort((a, b) => (a.chapter && b.chapter && a.chapter.eventId === b.chapter.eventId ? a.chapter.index - b.chapter.index : a.createdAt.localeCompare(b.createdAt))).map((p) => (
              <div class="item wide-actions" key={p.performanceId} data-performance={p.performanceId} data-chapter={p.chapter?.index ?? ''} data-chapter-kind={p.chapter?.kind ?? ''} data-chapter-at={p.chapter?.startedAt ?? ''} data-film-marks={p.chapters?.length ?? 0} data-film-kinds={(p.chapters ?? []).map((c) => c.kind).join(',')}>
                <div class="thumb">
                  {p.chapter ? <span class="small">{String(p.chapter.index).padStart(2, '0')}</span> : <IcPlay size={18} />}
                </div>
                <div class="meta">
                  <div class="t">
                    {p.chapter ? `${p.chapter.eventTitle} ${String(p.chapter.index).padStart(2, '0')} · ${p.chapter.kind === 'song' ? '♪ ' : p.chapter.kind === 'pause' ? '⏸ ' : '▪ '}` : ''}
                    {p.songTitle || 'Untitled song'}
                  </div>
                  <div class="s">
                    {new Date(p.createdAt).toLocaleString()} · {formatMs(p.durationMs)} · {p.singers.map((x) => x.displayName.split(' ')[0]).join(', ') || p.hostName}
                  </div>
                  {(p.chapters?.length ?? 0) > 0 && (
                    <div class="s" data-film-chapters>
                      {marksLine(p.chapters!)}
                    </div>
                  )}
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
        {recs.length > 0 && (
          <section class="card stack">
            <h3>Personal takes from this meet</h3>
            <div class="muted small">Takes singers saved for themselves in this meet (an older build saved one per song; the film above is the meet's record now).</div>
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
                    <a class="btn sm" href={safeHref(r.driveFolderLink)} target="_blank" rel="noopener">
                      Drive
                    </a>
                  ) : (
                    <span class="chip">private</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
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
