/**
 * The room's virtual stage, alive for the whole meet — not just the song. The stage exists from the
 * moment the meet does: whoever steps on a slot appears on it instantly (their camera opens, their
 * cut-out is drawn, their alpha-packed video goes out to the other performers and to any Publishing
 * show view), whether the host has started the song yet or not. The song, pauses, a late singer
 * stepping on mid-song are activities on this stage, in parallel with the show.
 *
 * One LocalFeed (camera → cut-out → framing), one StageCompositor and one PerformerMesh per room,
 * shared by the lobby's stage strip and the full live stage, so nothing reconnects when the song
 * starts. Audience devices draw the performers' placeholders (video is private to the stage).
 * Beside the stage runs the ShowRecorder: the show picture with the whole mix, drawn from the same
 * cut-outs (the other singers' vocals come over the mesh for it — and are never played); on the
 * host's device the MeetRecorder films it for the whole meet into one file, a chapter mark per
 * song (nothing is recorded per song on any device).
 */
import { meetIsOpen, participantMedia, SLOT_COLORS, type Meet, type Participant, type PerformanceChapter, type PerformanceSinger, type SingerSlot } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AudioEngine } from '../../audio/engine.ts';
import { backgroundById, backgroundSrc, backgrounds, loadBackgrounds } from '../../components/BackgroundPicker.tsx';
import { serverNow } from '../../lib/api.ts';
import type { PerformanceSummary } from '../../lib/storage/types.ts';
import { media, needsReconnect } from '../../state/session.ts';
import { appSettings } from '../../state/settings.ts';
import { chapterCue } from '../../video/chapters.ts';
import { alignLine, alignPlan, delayFor, type AlignPlan, type PeerArrival } from '../../video/align.ts';
import { UnpackedFrame } from '../../video/alphaPack.ts';
import type { Camera } from '../../video/camera.ts';
import { LocalFeed, type FeedHealth } from '../../video/localFeed.ts';
import { MeetRecorder, stageSound } from '../../video/meetRecorder.ts';
import { PerformerMesh, type PeerState } from '../../video/peers.ts';
import type { SegmenterMode } from '../../video/segmenter.ts';
import { ShowRecorder } from '../../video/showRecorder.ts';
import { StageCompositor, type StagePerformer } from '../../video/stage.ts';
import { registerMeetFilm } from './meetFilm.ts';
import type { MeetSession } from './meetSession.ts';

export interface RoomStage {
  feed: LocalFeed;
  compositor: StageCompositor;
  mesh: PerformerMesh | null;
  /** The saved performance of a song: the show picture with the whole mix, recorded on this device. */
  show: ShowRecorder;
  /** The film of the whole meet (runs on the host's device while the host is on stage; see video/meetRecorder.ts). */
  film: MeetRecorder;
  peerStates: Record<string, PeerState>;
  /** How my cut-out is made right now (model / soft-focus oval / loading / off). */
  blend: SegmenterMode;
  /** The stage frame's word on my distance to the camera: 'close' — sit back; 'far' — come closer; null — fine. */
  distance: 'close' | 'far' | null;
  camOn: boolean;
  camStream: MediaStream | null;
  /** Why the camera did not open by itself (permission); the UI offers a button then. */
  camError: string | null;
  /** Open the camera from a user gesture (after a permission refusal, or on browsers that need the tap). */
  openCamera: () => Promise<void>;
  /** The camera's health (localFeed.ts): anything but 'ok' and the stage restarts it once by itself; the strip offers a button after that. */
  camHealth: FeedHealth;
  /** The camera again, from a tap (after it froze or went dark). */
  restartCamera: () => Promise<void>;
  /** Performers whose video link is up / other performers on stage. */
  linked: number;
  others: number;
  /** Other performers whose picture arrives but has not moved for a while (their camera froze on their device), by participant id. */
  still: string[];
  /** My camera, in words (frame rate, the cut-out, a picture standing still), refreshed every second while it is on. */
  cameraLine: string;
  /** What each source brings to this device's mix (the host's: what the audience, the film and the takes get), in words, refreshed every second: "mix: you −18 · Team −22 · track −20". */
  mixLine: string;
  /** The timing of the mix for this song (align.ts): what each other singer is held back by, and the lag — '' before the first count-in. */
  alignLine: string;
  /** Make the video link to a performer again from scratch (a plain Reconnect for a picture that stands still). */
  reconnect: (id: string) => void;
  /** This account may send its picture (a dual account); an audio-only account sings with sound alone. */
  videoAllowed: boolean;
}

export function useRoomStage(session: MeetSession, meet: Meet, you: Participant, camera: Camera, opts: { preparing: boolean; engine: AudioEngine | null; /** The song is paused on this device: the stage talks until the resume. */ paused?: boolean; restartCamera: () => Promise<void> }): RoomStage {
  const feed = useMemo(() => new LocalFeed(), []);
  const compositor = useMemo(() => new StageCompositor('show'), []);
  const show = useMemo(() => new ShowRecorder(), []);
  // Every singer's link carries their vocal for the recording of the show (received, never played).
  const mesh = useMemo(() => (PerformerMesh.supported() ? new PerformerMesh(session, you.participantId, { wantAudio: true }) : null), [session, you.participantId]);
  const remoteVideos = useRef(new Map<string, { video: HTMLVideoElement; frame: UnpackedFrame }>());
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});
  const [blend, setBlend] = useState<SegmenterMode>('off');
  const [camError, setCamError] = useState<string | null>(null);
  const app = appSettings.value;
  const onStage = you.slot !== null;
  const camStream = camera.stream;
  const camOn = camera.on.value;
  const facing = camera.facing.value;
  /**
   * The picture on stage is the service's verdict for this device in this meet (`you.media`, refreshed by every heartbeat:
   * an audio-only role, a free plan, the month's video hours used up — plans.ts): nothing of its picture is captured,
   * sent, recorded or streamed without it; the account's own standing stands in before the room answered.
   */
  const videoAllowed = (you.media ?? media.value) === 'dual';

  // ---- camera follows the stage: open when I step on (if my setting says so), close when I step off ----
  /** A camera opened from a tap stays open a moment even before the slot is confirmed (no open/close flicker). */
  const holdUntil = useRef(0);
  /** One open at a time: the tap and the "now on stage" effect may both ask within the same second. */
  const opening = useRef<Promise<void> | null>(null);
  const openCamera = (): Promise<void> => {
    if (camera.on.value) return Promise.resolve();
    if (!videoAllowed) {
      setCamError('Your account is audio only — no camera on stage (the SingersVoice admin can change that)');
      return Promise.resolve();
    }
    if (opening.current) return opening.current;
    holdUntil.current = Date.now() + 8000;
    opening.current = (async () => {
      try {
        await camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined });
        setCamError(null);
      } catch (e) {
        setCamError(e instanceof Error ? e.message : String(e));
      } finally {
        opening.current = null;
      }
    })();
    return opening.current;
  };
  useEffect(() => {
    if (!onStage) {
      setCamError(null);
      if (opts.preparing || !camOn) return;
      const wait = holdUntil.current - Date.now();
      if (wait <= 0) {
        camera.close();
        return;
      }
      const t = setTimeout(() => camera.close(), wait);
      return () => clearTimeout(t);
    }
    if (app.cameraOn && videoAllowed && !camOn && !opts.preparing) void openCamera();
    if ((!app.cameraOn || !videoAllowed) && camOn && !opts.preparing) camera.close();
  }, [onStage, app.cameraOn, camOn, opts.preparing, videoAllowed]);

  // ---- my cut-out, framed by me; the packed stream goes to the mesh while I am on stage ----
  useEffect(() => {
    feed.onMode = (m) => setBlend(m);
    feed.attach(camOn ? camStream : null, true);
    const sending = Boolean(camOn && camStream && onStage);
    if (sending) mesh?.setLocalStream(feed.packedStream());
    else if (!camOn || !camStream) {
      mesh?.setLocalStream(null);
      feed.stopPacking();
    }
    // The outgoing track was the feed worker's and the page had to take over: the mesh gets the page's.
    feed.onPackedLost = () => {
      if (sending) mesh?.setLocalStream(feed.packedStream());
    };
  }, [camStream, camOn, onStage]);
  // The stage frame's word on my distance to the camera (sit back / come closer), for the stage strip.
  const [distance, setDistance] = useState<'close' | 'far' | null>(null);
  useEffect(() => {
    feed.onNote = setDistance;
    return () => {
      feed.onNote = null;
    };
  }, []);
  // Another performer's picture standing still (frames arriving, nothing moving: their camera froze on their device): said on the strip, with Reconnect.
  const [still, setStill] = useState<string[]>([]);
  useEffect(() => {
    compositor.onStill = setStill;
    return () => {
      compositor.onStill = null;
    };
  }, [compositor]);
  const reconnect = (id: string) => mesh?.remake(id);
  // My camera's own line on the strip, once a second while it is on: what it does is never a guess.
  const [cameraLine, setCameraLine] = useState('');
  useEffect(() => {
    if (!camOn || !onStage) {
      setCameraLine('');
      return;
    }
    const t = setInterval(() => setCameraLine(feed.cameraLine), 1000);
    return () => clearInterval(t);
  }, [camOn, onStage, feed]);
  // The mix line: what each source brings to this device's mix, once a second while the bus is up — a voice that never reaches the mix is seen here, not in a file afterwards.
  const [mixLine, setMixLine] = useState('');
  const stageNames = useRef(new Map<string, string>());
  stageNames.current = new Map(meet.stage.filter((s) => s.participantId).map((s) => [s.participantId!, s.displayName.split(' ')[0] || 'Singer']));
  useEffect(() => {
    if (!onStage) {
      setMixLine('');
      return;
    }
    const fmt = (db: number) => (db <= -60 ? 'silent' : `${Math.round(db)} dB`);
    const t = setInterval(() => {
      const l = show.mixLevels();
      if (!l) {
        setMixLine('');
        return;
      }
      const parts = Object.entries(l.vocals).map(([id, db]) => `${id === 'me' ? 'you' : (stageNames.current.get(id) ?? 'singer')} ${fmt(db)}`);
      setMixLine(`mix: ${parts.join(' · ')} · track ${fmt(l.track)}`);
    }, 1000);
    return () => clearInterval(t);
  }, [onStage, show]);
  // ---- the camera's health: a camera the browser muted or ended, or one frozen on a picture, is restarted — once by itself, then from a tap ----
  const [camHealth, setCamHealth] = useState<FeedHealth>('ok');
  const restarting = useRef<Promise<void> | null>(null);
  const autoRestartAt = useRef(0);
  const latest = useRef(opts); // the newest engine/camera pairing, for a restart fired from an older closure
  latest.current = opts;
  const restartCamera = (): Promise<void> => {
    if (restarting.current) return restarting.current;
    restarting.current = latest.current
      .restartCamera()
      .then(() => setCamError(null))
      .catch((e) => setCamError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        restarting.current = null;
      });
    return restarting.current;
  };
  useEffect(() => {
    feed.onHealth = (h) => {
      setCamHealth(h);
      if (h === 'ok' || !onStage || !camOn) return;
      // one restart by itself per minute: a camera that stays frozen gets the button, not a loop of prompts
      if (Date.now() - autoRestartAt.current < 60_000) return;
      autoRestartAt.current = Date.now();
      void restartCamera();
    };
    return () => {
      feed.onHealth = null;
    };
  }, [onStage, camOn]);

  // ---- the performer mesh (video only; singers never hear each other), while I am on stage ----
  useEffect(() => {
    if (!mesh) return;
    mesh.onRemote = (id, stream, state) => {
      let r = remoteVideos.current.get(id);
      if (stream) {
        if (!r) {
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.autoplay = true;
          v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
          document.body.appendChild(v);
          r = { video: v, frame: new UnpackedFrame(v) };
          remoteVideos.current.set(id, r);
        }
        if (r.video.srcObject !== stream) {
          r.video.srcObject = stream;
          void r.video.play().catch(() => undefined);
        }
      } else if (r) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
        remoteVideos.current.delete(id);
      }
      setPeerStates((s) => ({ ...s, [id]: state }));
    };
    mesh.onRemoteAudio = (id, stream) => show.setVocal(id, stream); // the mix always; the speakers only between songs (talk-back)
    // Instant: what one singer changes (the background, the song, the transport) reaches the others and the show view
    // over the mesh at once — they fetch the new state now — and what they change reaches this device the same way.
    mesh.onMessage = (_from, m) => {
      if (m.type === 'changed') session.poke();
    };
    session.onActed = () => {
      (window as unknown as { __svSaid?: number }).__svSaid = mesh.say({ type: 'changed' }); // support / e2e: how many peers were told
    };
    session.onSignal = () => mesh.pollNow(); // the service says a signal waits: fetched now, not at the next poll
    (window as unknown as { __svMesh?: PerformerMesh; __svFeed?: LocalFeed }).__svMesh = mesh; // support / e2e hooks
    (window as unknown as { __svFeed?: LocalFeed }).__svFeed = feed;
    session.onLeave = () => mesh.close(); // goodbyes before the session leaves
    return () => {
      session.onLeave = null;
      session.onActed = null;
      session.onSignal = null;
      mesh.onMessage = null;
      void mesh.close();
      for (const r of remoteVideos.current.values()) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
      }
      remoteVideos.current.clear();
      setPeerStates({});
    };
  }, [mesh]);
  useEffect(() => {
    if (!mesh) return;
    if (onStage) void mesh.start();
    else {
      void mesh.close();
      for (const r of remoteVideos.current.values()) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
      }
      remoteVideos.current.clear();
      setPeerStates({});
    }
  }, [mesh, onStage]);
  useEffect(
    () => () => {
      feed.dispose();
      show.dispose();
    },
    [],
  );

  // The recording draws the same background the show view does (the meet's, as an image or looping video).
  const bgItems = backgrounds.value;
  useEffect(() => {
    void loadBackgrounds();
    const item = backgroundById(meet.backgroundId);
    show.setBackground(item ?? null, backgroundSrc(item));
  }, [meet.backgroundId, bgItems.length]);
  show.youLabel = you.displayName.split(' ')[0] || 'You';
  // The mix balance this device records and relays at: the singer's Track / Vocal controls.
  useEffect(() => show.setBalance(app.trackDb, app.vocalDb), [app.trackDb, app.vocalDb]);
  // The host's device sends the mix to the audience (nobody on stage ever hears it).
  show.broadcast = you.userId === meet.hostUserId ? (b) => session.sendMix(b) : null;

  // My vocal (after FX) goes out over the mesh from the moment my mic is open on stage: to the other
  // singers (heard between songs only — talk-back), to the host's mix (the audience) and to a publisher.
  const micOpen = opts.engine?.micOpen.value ?? false;
  useEffect(() => {
    mesh?.setLocalAudio(micOpen && onStage ? (opts.engine?.vocalStream()?.getAudioTracks()[0] ?? null) : null);
  }, [mesh, micOpen, onStage, opts.engine]);
  // Talk-back: the singers on stage hear each other until the countdown, and again while the song is
  // paused (from the cued instant it stops on this device until the resume is cued); from the count-in
  // to the end of the song, and from a resume on, nobody on stage hears anyone (Solo foldback). The
  // host's device keeps ONE mix going for the audience the whole time it is on stage with the mic open
  // — the talk between songs, the count-in, the song (whose recording hooks onto the same bus) — so
  // what the audience hears never breaks off at a song's start: a torn-down bus used to leave them a
  // silence of a count-in and a restart.
  const songRunning = meet.state === 'countdown' || (meet.state === 'live' && !opts.paused);
  const host = you.userId === meet.hostUserId;
  // Talk-back between songs and while paused: the others' voices play here — and echo cancellation keeps them out of this
  // microphone (engine.setTalkback) — Solo foldback from the count-in to the end of the song.
  useEffect(() => {
    const hear = onStage && !songRunning;
    show.setHearOthers(hear);
    opts.engine?.setTalkback(hear);
  }, [show, onStage, songRunning, opts.engine, micOpen]);
  useEffect(() => {
    const engine = opts.engine;
    if (!host || !onStage || !micOpen || !engine) return;
    show.startTalk(engine);
    return () => show.stopTalk();
  }, [show, host, onStage, micOpen, opts.engine]);

  const stagePerformers = meet.stage.filter((s) => s.participantId);
  const peerIds = stagePerformers.map((s) => s.participantId!).filter((id) => id !== you.participantId);
  const peerKey = peerIds.join(',');
  useEffect(() => {
    if (onStage) mesh?.setPeers(peerIds);
  }, [peerKey, onStage]);

  // Everyone on stage, left to right by slot, on one shared stage (placeholders for video I don't receive — and for an
  // audio-only account, whatever arrives: the rule is applied on every device that draws the stage, not only on theirs).
  // The recording gets the same people with the show view's labels (first names, no "You").
  const participants = session.snapshot.value?.participants ?? [];
  const audioOnlyKey = stagePerformers.filter((s) => participantMedia(participants, s.participantId) === 'audio').map((s) => s.participantId).join(',');
  useEffect(() => {
    const list: StagePerformer[] = stagePerformers.map((s) => {
      const me = s.participantId === you.participantId;
      const color = SLOT_COLORS[Math.max(1, Math.min(10, s.slot)) as SingerSlot];
      if (me) return { id: 'me', slot: s.slot, label: `You · S${s.slot}`, color, source: feed.source, mirror: facing === 'user', isMe: true };
      const r = participantMedia(participants, s.participantId) === 'audio' ? undefined : remoteVideos.current.get(s.participantId!);
      return { id: s.participantId!, slot: s.slot, label: `${s.displayName.split(' ')[0] || 'Singer'} · S${s.slot}`, picture: s.picture, color, source: r ? { kind: 'frame', frame: r.frame } : { kind: 'none' } };
    });
    compositor.setPerformers(list);
    show.setPerformers(list.map((p) => ({ ...p, label: p.isMe ? 'You' : p.label.replace(/ · S\d+$/, '') })));
  }, [peerKey, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|'), camStream, camOn, facing, peerStates, you.participantId, audioOnlyKey]);

  // ---- the film of the meet (the host's device): the whole meet as one video in the host's Drive ----
  const film = useMemo(() => new MeetRecorder(show), [show]);
  // ---- timing the mix (align.ts): at every count-in, each other singer's voice is held back by what it is early by ----
  const [alignment, setAlignment] = useState<{ plan: AlignPlan; arrivals: PeerArrival[]; line: string } | null>(null);
  const alignRef = useRef<AlignPlan | null>(null);
  const nameOf = (id: string) => meet.stage.find((s) => s.participantId === id)?.displayName.split(' ')[0] || 'a singer';
  useEffect(() => {
    const engine = opts.engine;
    if (mesh && engine) mesh.announceRoundTrip(engine.roundTripMs); // the others fit my voice by it
  }, [mesh, opts.engine, onStage, peerKey]);
  useEffect(() => {
    const engine = opts.engine;
    if (!mesh || !engine || !onStage || meet.state !== 'countdown') return;
    // Half a second into the count-in: the round trips announced on fresh links have landed, the links' latency has been read.
    const t = setTimeout(() => {
      const arrivals = mesh.arrivals();
      const plan = alignPlan(engine.roundTripMs, arrivals);
      show.setLag(plan.lagMs);
      for (const [id, ms] of Object.entries(plan.delays)) mesh.setPlayoutDelay(id, ms);
      alignRef.current = plan;
      setAlignment({ plan, arrivals, line: alignLine(plan, nameOf) });
    }, 500);
    return () => clearTimeout(t);
  }, [mesh, opts.engine, onStage, meet.state, meet.kickstartEpochMs]);
  // A singer whose voice arrives (or whose latency is first known) during the song is fitted to the plan as it stands; between songs every hold is lifted (talk-back at once).
  useEffect(() => {
    if (!mesh) return;
    if (!songRunning) {
      for (const { id } of mesh.arrivals()) if (mesh.playoutDelay(id)) mesh.setPlayoutDelay(id, 0);
      alignRef.current = null;
      return;
    }
    const t = setInterval(() => {
      const plan = alignRef.current;
      if (!plan) return;
      for (const a of mesh.arrivals()) {
        if (a.arrivalMs === null || a.id in plan.delays) continue;
        const ms = delayFor(plan, a.arrivalMs);
        plan.delays[a.id] = ms;
        mesh.setPlayoutDelay(a.id, ms);
        setAlignment((x) => (x ? { ...x, line: alignLine(plan, nameOf) } : x));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [mesh, songRunning]);
  useEffect(() => {
    (window as unknown as { __svStage?: unknown }).__svStage = { show, engine: opts.engine, film, alignment }; // support / e2e: the mix this device builds, the film of the meet, the timing plan
  }, [show, opts.engine, film, alignment]);
  const filmWanted = app.recordMeet;
  const meetOpen = meetIsOpen(meet);
  /** Everyone who stood on stage while the film ran (the manifest names them). */
  const filmSingers = useRef(new Map<number, PerformanceSinger>());
  useEffect(() => {
    if (!film.recording) return;
    for (const s of stagePerformers) filmSingers.current.set(s.slot, { slot: s.slot, displayName: s.displayName });
  }, [film.recording, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|')]);
  const driveLinked = !needsReconnect.value; // a Drive session that lapsed and came back starts the film then
  /** The film, as it lands in Drive (one file, its chapter marks on it): shared with the meet and listed for everyone who was there (meetFilm.ts). */
  const meetRef = useRef(meet);
  meetRef.current = meet;
  const onFilmSaved = (saved: PerformanceSummary, chapters: PerformanceChapter[]) => {
    const m = meetRef.current;
    registerMeetFilm({ saved, chapters, meet: { meetId: m.meetId, title: m.title, hostName: m.hostName }, singers: [...filmSingers.current.values()].sort((a, b) => a.slot - b.slot), session });
  };
  useEffect(() => {
    const engine = opts.engine;
    if (!host || !onStage || !engine || !filmWanted || !meetOpen || !driveLinked) return;
    filmSingers.current = new Map(stagePerformers.map((s) => [s.slot, { slot: s.slot, displayName: s.displayName }]));
    void film.start(stageSound(engine, show), { meetId: meet.meetId, title: meet.title, hostName: meet.hostName, singers: () => [...filmSingers.current.values()].sort((a, b) => a.slot - b.slot), onSaved: onFilmSaved }, chapterCue(meet, serverNow()));
  }, [film, host, onStage, opts.engine, filmWanted, meetOpen, driveLinked]);
  // The film is marked where the stage goes: a song's start (its kickstart), a pause, a stop, the next song (video/chapters.ts).
  const pb = meet.playback;
  useEffect(() => {
    film.cue(chapterCue(meet, serverNow()));
  }, [film, pb?.state, pb?.epoch, pb?.pauseAtEpochMs, meet.kickstartEpochMs, meet.trackTitle, meet.songCount]);
  const endFilm = () => void film.stop();
  useEffect(() => {
    if (!meetOpen || !onStage || !filmWanted) endFilm();
  }, [meetOpen, onStage, filmWanted]);
  useEffect(() => () => endFilm(), [film]);

  const others = peerIds.length;
  const linked = onStage ? peerIds.filter((id) => peerStates[id] === 'connected').length : 0;
  return { feed, compositor, mesh, show, film, peerStates, blend, distance, camOn, camStream, camError, openCamera, camHealth, restartCamera, linked, others, still, reconnect, cameraLine, mixLine, alignLine: alignment?.line ?? '', videoAllowed };
}
